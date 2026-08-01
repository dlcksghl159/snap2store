import https from "node:https";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { linkHub } from "./link/hub.js";
import { ensureLinkTls, lanAddresses } from "./link/tls.js";
import { ensureTunnel } from "./link/tunnel.js";

/**
 * 무정지 완주 계약의 마지막 방어선.
 * 이 두 핸들러가 없으면 fire-and-forget 경로가 reject 할 때 Node 기본 동작(프로세스 종료)으로
 * 진행 중인 모든 리스팅이 함께 죽는다. 원인은 반드시 로그로 남긴다.
 * 이것이 개별 브랜치의 .catch() 를 생략해도 된다는 뜻은 아니다 — 그물이 뚫렸을 때의 마지막 그물이다.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    `[fatal-guard] unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
  );
});
process.on("uncaughtException", (error) => {
  console.error(`[fatal-guard] uncaught exception: ${error.stack ?? String(error)}`);
});

const app = createApp();

const httpServer = app.listen(env.AGENT_API_PORT, "0.0.0.0", () => {
  console.log(`Snap2Store agent API ready on port ${env.AGENT_API_PORT}`);
});
// 데스크톱은 Vite 프록시(ws)를 거쳐 이 포트로 /link 업그레이드를 보낸다.
httpServer.on("upgrade", (request, socket, head) => {
  if (!linkHub.handleUpgrade(request, socket, head)) socket.destroy();
});

/**
 * 폰 링크용 HTTPS — 같은 Express 앱을 자체 서명 인증서로 한 포트 더 연다.
 * 폰 카메라(getUserMedia)는 보안 컨텍스트에서만 열리므로 LAN 접속은 이 포트로 온다.
 * 인증서 준비 실패는 로그만 남긴다 — 폰 링크가 없어도 본편(업로드→등록)은 살아야 한다.
 *
 * ⚠ IP 는 런타임에 바뀐다. 시연장에서 와이파이를 바꾸거나 핫스팟으로 갈아타면 QR 은
 * 새 IP 를 가리키는데 서버는 옛 IP 로 구운 인증서를 계속 내민다 — SAN 불일치는
 * 브라우저가 "계속 진행"조차 막는 경우가 있고, 겉으로는 그냥 "폰이 안 붙는다"로 보인다.
 * 실제로 한 번 겪었고, 손으로 서버를 껐다 켜서 풀었다. 그 복구를 여기서 자동으로 한다.
 */
const NETWORK_WATCH_MS = 4_000;
let phoneLinkServer: https.Server | null = null;
let servingIps = "";

async function openPhoneLink(ips: string[]): Promise<void> {
  const tls = await ensureLinkTls(ips);
  const server = https.createServer(tls, app);
  phoneLinkServer = server;
  server.on("upgrade", (request, socket, head) => {
    if (!linkHub.handleUpgrade(request, socket, head)) socket.destroy();
  });
  // tsx watch 재시작·직전 리스너 정리 직후엔 포트가 아직 물려 있을 수 있다 —
  // EADDRINUSE 는 치명이 아니라 타이밍이므로 몇 번 되물어 본다.
  let attempts = 0;
  const listen = () => {
    server.listen(env.LINK_HTTPS_PORT, "0.0.0.0", () => {
      const host = ips[0] ?? "localhost";
      console.log(`Snap2Store phone link ready on https://${host}:${env.LINK_HTTPS_PORT}/phone`);
    });
  };
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && attempts < 8) {
      attempts += 1;
      setTimeout(listen, 700);
      return;
    }
    console.error(`[link] HTTPS 포트를 열지 못했습니다 — 폰 링크 없이 계속합니다: ${error.message}`);
  });
  listen();
}

async function syncPhoneLink(): Promise<void> {
  const ips = lanAddresses();
  const key = ips.join(",");
  if (key === servingIps) return;
  const previous = servingIps;
  servingIps = key;

  if (phoneLinkServer) {
    console.log(`[link] 네트워크 변경 감지 (${previous || "없음"} → ${key || "없음"}) — 인증서를 다시 굽고 다시 엽니다`);
    // 기존 연결은 어차피 사라진 망 위에 있다. 새 리스너가 포트를 잡을 수 있게 강제로 닫는다.
    phoneLinkServer.closeAllConnections?.();
    await new Promise<void>((resolve) => phoneLinkServer?.close(() => resolve()) ?? resolve());
    phoneLinkServer = null;
  }

  try {
    await openPhoneLink(ips);
  } catch (error) {
    console.error(
      `[link] HTTPS 준비 실패 — 폰 링크 없이 계속합니다: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    servingIps = ""; // 다음 감시 주기에 다시 시도한다.
  }
}

void syncPhoneLink();
setInterval(() => {
  void syncPhoneLink();
}, NETWORK_WATCH_MS).unref();

// 시연 당일 설정: LINK_TUNNEL=auto 면 부팅과 동시에 공개 터널을 데워 둔다.
if (env.LINK_TUNNEL === "auto") {
  void ensureTunnel().catch((error: unknown) => {
    console.error(
      `[tunnel] 자동 시작 실패 — LAN 모드로 계속합니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
