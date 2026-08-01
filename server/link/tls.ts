import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generate as generateCertificate } from "selfsigned";
import { env } from "../env.js";

/**
 * 폰 카메라(getUserMedia)는 보안 컨텍스트에서만 열린다 — LAN IP 로 접속하는 폰에게는
 * HTTPS 가 필수다. 여기서 만드는 자체 서명 인증서는 시연 전 폰에서 경고를 한 번
 * 통과시키는 용도이지 신뢰 체계가 아니다.
 *
 * 인증서는 SAN 에 현재 LAN IP 전부를 넣어 굽고 캐시한다. IP 구성이 바뀌면
 * (다른 와이파이·핫스팟) 자동으로 다시 굽는다 — SAN 불일치는 브라우저가
 * "계속 진행"조차 막는 경우가 있다.
 */

const CERT_DIR = path.join(env.cacheRoot, "link-tls");
const CERT_DAYS = 365;

export interface LinkTls {
  key: string;
  cert: string;
}

/**
 * LAN IPv4 목록 — 폰 QR 은 첫 항목으로 만든다.
 * 인터페이스 이름 추측보다 **기본 라우트가 지나는 인터페이스**가 먼저다: 이더넷 독·VPN·
 * VM 브리지가 섞인 맥에서 "그럴듯하지만 폰이 못 가는 IP"를 고르는 사고를 막는다.
 */
export function lanAddresses(): string[] {
  const found: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      found.push({ name, address: entry.address });
    }
  }
  const primary = defaultRouteInterface();
  found.sort((a, b) => interfaceRank(a.name, primary) - interfaceRank(b.name, primary));
  return found.map((entry) => entry.address);
}

function defaultRouteInterface(): string | null {
  try {
    const output = execFileSync("route", ["-n", "get", "default"], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const match = output.match(/interface:\s*(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null; // darwin 밖이거나 라우트 조회 실패 — 이름 추측으로 내려간다.
  }
}

function interfaceRank(name: string, primary: string | null): number {
  if (primary && name === primary) return -1;
  if (/^en0$/.test(name)) return 0;
  if (/^en\d/.test(name)) return 1;
  if (/^(wlan|wl)/.test(name)) return 1;
  if (/^(bridge|ap|utun|vmnet)/.test(name)) return 3;
  return 2;
}

interface CertMeta {
  ips: string[];
  createdAt: string;
}

export async function ensureLinkTls(ips: string[]): Promise<LinkTls> {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");
  const metaPath = path.join(CERT_DIR, "meta.json");

  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as CertMeta;
    const fresh =
      Date.parse(meta.createdAt) > Date.now() - (CERT_DAYS - 30) * 86_400_000 &&
      ips.every((ip) => meta.ips.includes(ip));
    if (fresh) {
      const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
      return { key, cert };
    }
  } catch {
    /* 캐시 없음 — 새로 굽는다 */
  }

  const altNames: Array<{ type: 2 | 7; value?: string; ip?: string }> = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7 as const, ip })),
  ];

  const pems = await generateCertificate([{ name: "commonName", value: "snap2store.link" }], {
    notAfterDate: new Date(Date.now() + CERT_DAYS * 86_400_000),
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });

  // 개인키는 소유자 외 읽기 금지 — 캐시 디렉터리째로 잠근다.
  await mkdir(CERT_DIR, { recursive: true, mode: 0o700 });
  await chmod(CERT_DIR, 0o700);
  const meta: CertMeta = { ips, createdAt: new Date().toISOString() };
  await Promise.all([
    writeFile(keyPath, pems.private, { encoding: "utf8", mode: 0o600 }),
    writeFile(certPath, pems.cert, { encoding: "utf8", mode: 0o600 }),
    writeFile(metaPath, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 }),
  ]);
  return { key: pems.private, cert: pems.cert };
}
