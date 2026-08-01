#!/usr/bin/env node
/**
 * 터널 지킴이 — cloudflared 를 **에이전트 서버 바깥에서** 살려 둔다.
 *
 * ⚠ 왜 따로 떼어냈나 (실측):
 * 터널이 서버의 자식 프로세스였을 때, `tsx watch` 가 파일 변경으로 서버를 재시작할 때마다
 * 터널이 같이 죽었다. 그리고 재발급은 trycloudflare 의 레이트 리밋(429 · error 1015)에
 * 걸린다 — 재시작이 잦을수록 더 걸린다. 그 결과 QR 은 조용히 LAN 주소로 되돌아가고,
 * 기기 격리가 걸린 와이파이에서는 폰이 영영 붙지 못한다. 시연 중에 이게 벌어졌다.
 *
 * 그래서 수명을 분리한다: 이 프로세스는 서버와 무관하게 계속 살아 있고, 발급받은
 * 공개 주소를 파일에 적어 둔다. 서버는 그 파일을 읽기만 한다(server/link/public-url.ts).
 * 서버를 몇 번을 재시작해도 터널은 그대로다.
 *
 * 사용:
 *   node scripts/tunnel-keeper.mjs          # 포그라운드 (Ctrl-C 로 정리)
 *   node scripts/tunnel-keeper.mjs &        # 백그라운드
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL_FILE = path.join(projectRoot, "data", "cache", "tunnel-url.txt");
const PID_FILE = path.join(projectRoot, "data", "cache", "tunnel-keeper.pid");
const PORT = process.env.AGENT_API_PORT || "8788";
const NGROK_CONFIG = path.join(
  process.env.HOME || "",
  "Library/Application Support/ngrok/ngrok.yml",
);

/*
  지킴이는 하나만 산다. 서버가 재시작할 때마다 ensureTunnelKeeper() 가 부르므로,
  잠금이 없으면 켤 때마다 하나씩 늘어난다 — 여러 지킴이가 각자 터널을 요청하면
  trycloudflare 레이트 리밋을 스스로 불러온다(그게 오늘 시연을 막은 그 리밋이다).
*/
function alreadyRunning() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // 신호 0 = 존재만 확인
    return pid !== process.pid;
  } catch {
    return false; // 파일이 없거나 죽은 PID — 내가 맡는다
  }
}

if (alreadyRunning()) {
  console.log("[keeper] 이미 돌고 있는 지킴이가 있습니다 — 그대로 둡니다");
  process.exit(0);
}
mkdirSync(path.dirname(PID_FILE), { recursive: true });
writeFileSync(PID_FILE, String(process.pid), "utf8");

/* 레이트 리밋(1015)은 시간이 풀어 준다 — 빠르게 두드릴수록 더 오래 막힌다. */
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 60_000, 120_000];
let failures = 0;
let child = null;
let stopping = false;

/**
 * 터널 제공자 사다리.
 *
 * ⚠ 계정 없는 trycloudflare 퀵 터널은 시연에 걸 수 없다 — 발급이 잦으면 IP 단위
 * 레이트 리밋(429 · 1015)에 걸리고, 한 번 걸리면 수십 분씩 아무 터널도 못 연다.
 * 실측으로 시연 직전에 이걸로 폰이 끊겼다. 그래서 **계정 기반 제공자를 먼저 본다**:
 * 토큰이 설정돼 있으면 리밋이 없고 주소도 안정적이다.
 *
 * 순서: cloudflared 퀵 터널 → (연속 실패하면) ngrok.
 *
 * cloudflared 를 먼저 두는 이유는 **폰에서 탭이 한 번 덜 필요하기 때문**이다. ngrok 무료는
 * 브라우저 첫 접속에 "Visit Site" 안내 페이지를 끼워 넣는다 — 시연에서 QR 을 찍은 사람이
 * 영문 경고 화면을 한 번 통과해야 한다. 대신 ngrok 은 토큰만 있으면 레이트 리밋이 없다.
 * 그래서 깨끗한 쪽을 먼저 두드리고, 막혀 있으면 확실한 쪽으로 넘어간다.
 */
const CLOUDFLARE_TRIES_BEFORE_FALLBACK = 2;

const PROVIDERS = [
  {
    name: "cloudflared",
    bin: "cloudflared",
    args: ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`],
    ready: () => true,
    pattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  },
  {
    name: "ngrok",
    bin: "ngrok",
    args: ["http", PORT, "--log", "stdout", "--log-format", "logfmt"],
    // ngrok 은 토큰이 없으면 즉시 죽는다 — 설정이 있을 때만 후보로 친다.
    ready: () => existsSync(NGROK_CONFIG) || Boolean(process.env.NGROK_AUTHTOKEN),
    /*
      ⚠ TLD 를 열거하지 않는다. 실측으로 발급 주소가 `.ngrok-free.dev` 였는데
      `(app|io)` 로 못 박아 둔 탓에 터널이 멀쩡히 열려 있는데도 못 읽었다 —
      ngrok 은 도메인을 계속 바꾼다.
    */
    pattern: /https:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*\.[a-z]{2,}/i,
    // 로그 형식보다 확실한 길: ngrok 이 로컬에 여는 관리 API 를 직접 묻는다.
    api: "http://127.0.0.1:4040/api/tunnels",
  },
];

/** ngrok 관리 API 에서 공개 https 주소를 직접 읽는다. 로그 파싱이 놓쳐도 이쪽이 잡는다. */
async function discoverFromApi(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const body = await response.json();
    const tunnel = (body.tunnels ?? []).find(
      (t) => typeof t.public_url === "string" && t.public_url.startsWith("https://"),
    );
    return tunnel?.public_url ?? null;
  } catch {
    return null; // 아직 안 떴거나 API 가 없다
  }
}

function pickProvider() {
  const [cloudflare, ngrok] = PROVIDERS;
  if (failures >= CLOUDFLARE_TRIES_BEFORE_FALLBACK && ngrok.ready()) return ngrok;
  return cloudflare;
}

function publish(url) {
  mkdirSync(path.dirname(URL_FILE), { recursive: true });
  writeFileSync(URL_FILE, url, "utf8");
  console.log(`[keeper] 공개 주소 발급: ${url}`);
  console.log(`[keeper] → ${URL_FILE} 에 기록. 서버가 이걸 읽어 QR 에 씁니다.`);
}

function retract(reason) {
  try {
    rmSync(URL_FILE, { force: true });
  } catch {
    /* 파일이 없으면 그만이다 */
  }
  console.warn(`[keeper] 공개 주소 해제 (${reason}) — 서버는 LAN 주소로 되돌아갑니다`);
}

function start() {
  if (stopping) return;
  const provider = pickProvider();
  console.log(`[keeper] ${provider.name} 시작 — http://localhost:${PORT}`);
  child = spawn(provider.bin, provider.args, { stdio: ["ignore", "pipe", "pipe"] });

  let found = false;
  const scan = (chunk) => {
    const text = String(chunk);
    if (!found) {
      const match = text.match(provider.pattern);
      if (match) {
        found = true;
        failures = 0; // 한 번이라도 열렸으면 백오프를 처음으로 되돌린다
        publish(match[0]);
      }
    }
    if (/error code: 1015|429 Too Many Requests/.test(text)) {
      console.warn("[keeper] trycloudflare 레이트 리밋 — 기다렸다 다시 시도합니다");
    }
    if (/ERR_NGROK_4018|authtoken/i.test(text) && !found) {
      console.warn("[keeper] ngrok 인증 토큰이 없습니다 — `ngrok config add-authtoken <토큰>` 후 다시 시도됩니다");
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);

  // 관리 API 가 있는 제공자는 로그를 기다리지 않고 직접 물어본다 (최대 20초).
  if (provider.api) {
    void (async () => {
      for (let i = 0; i < 20 && !found && !stopping; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const url = await discoverFromApi(provider.api);
        if (url && !found) {
          found = true;
          failures = 0;
          publish(url);
        }
      }
    })();
  }

  child.on("exit", (code) => {
    child = null;
    if (stopping) return;
    retract(`${provider.name} 종료 code=${code}`);
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
    failures += 1;
    console.warn(`[keeper] ${Math.round(wait / 1000)}초 뒤 재시도 (${failures}회차)`);
    setTimeout(start, wait);
  });

  child.on("error", (error) => {
    console.error(
      `[keeper] ${provider.name} 실행 실패: ${error.message}` +
        (error.code === "ENOENT" ? ` — \`brew install ${provider.bin}\` 가 필요합니다` : ""),
    );
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    retract("지킴이 종료");
    try {
      rmSync(PID_FILE, { force: true });
    } catch {
      /* 이미 없으면 그만이다 */
    }
    if (child) child.kill();
    process.exit(0);
  });
}

start();
