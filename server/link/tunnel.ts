import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../env.js";

/**
 * Cloudflare 퀵 터널 — "같은 와이파이" 제약을 없애는 탈출구.
 *
 * `cloudflared tunnel --url http://localhost:<API포트>` 는 계정 없이 임시 공개 주소
 * (https://*.trycloudflare.com)를 발급한다. 폰은 LTE·다른 와이파이 어디서든 접속하고,
 * 진짜 인증서라 자체 서명 경고도 사라진다. 프레임·오디오가 CF 엣지를 한 번 돌아오므로
 * 지연은 LAN 직결보다 늘어난다 — 그래서 기본은 LAN, 이건 버튼으로 켜는 구조대다.
 *
 * 프로세스는 서버 수명 동안 하나만 유지하고 모든 세션이 같이 쓴다.
 */

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 20_000;

interface TunnelState {
  process: ChildProcess | null;
  url: string | null;
  starting: Promise<string> | null;
}

const state: TunnelState = { process: null, url: null, starting: null };

/* tsx watch 재시작·Ctrl-C 에서 cloudflared 고아를 남기지 않는다.
   수수께끼 종료를 추적하기 위해 어떤 경로로 죽는지 반드시 로그를 남긴다. */
const reapTunnel = () => {
  try {
    state.process?.kill("SIGTERM");
  } catch {
    /* noop */
  }
};
process.once("exit", (code) => {
  console.error(`[lifecycle] process exit code=${code}`);
  reapTunnel();
});
process.once("SIGTERM", () => {
  console.error("[lifecycle] SIGTERM 수신 — 종료");
  reapTunnel();
  process.exit(0);
});
process.once("SIGINT", () => {
  console.error("[lifecycle] SIGINT 수신 — 종료");
  reapTunnel();
  process.exit(0);
});
process.once("SIGHUP", () => {
  console.error("[lifecycle] SIGHUP 수신 — 종료");
  reapTunnel();
  process.exit(0);
});

export function activeTunnelUrl(): string | null {
  return state.url;
}

export function activeTunnelHostname(): string | null {
  if (!state.url) return null;
  try {
    return new URL(state.url).hostname;
  } catch {
    return null;
  }
}

export class TunnelUnavailableError extends Error {
  constructor(
    message: string,
    public readonly installed: boolean,
  ) {
    super(message);
  }
}

/** 이미 켜져 있으면 그 주소를, 켜는 중이면 그 약속을 돌려준다 — 중복 스폰 금지. */
export function ensureTunnel(): Promise<string> {
  if (state.url && state.process && state.process.exitCode === null) {
    return Promise.resolve(state.url);
  }
  if (state.starting) return state.starting;

  state.starting = startTunnel().finally(() => {
    state.starting = null;
  });
  return state.starting;
}

function startTunnel(): Promise<string> {
  return new Promise((resolve, reject) => {
    // 로컬은 평문 HTTP 포트로 잇는다 — 자체 서명 검증 문제를 원천 회피한다.
    // 공개 구간은 cloudflared 가 정식 인증서의 https 로 감싼다.
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${env.AGENT_API_PORT}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let logTail = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new TunnelUnavailableError(
          `터널 주소를 ${START_TIMEOUT_MS / 1000}초 안에 받지 못했습니다 — 인터넷 연결을 확인하세요.\n${logTail.slice(-400)}`,
          true,
        ),
      );
    }, START_TIMEOUT_MS);
    timer.unref?.();

    const onChunk = (chunk: Buffer) => {
      const text = String(chunk);
      logTail = (logTail + text).slice(-2_000);
      const match = text.match(URL_PATTERN);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        state.process = child;
        state.url = match[0];
        console.log(`[tunnel] 공개 주소 발급: ${state.url}`);
        resolve(state.url);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(
        new TunnelUnavailableError(
          missing
            ? "cloudflared 가 설치돼 있지 않습니다 — `brew install cloudflared` 후 다시 시도하세요."
            : `cloudflared 실행 실패: ${error.message}`,
          !missing,
        ),
      );
    });

    child.on("exit", (code) => {
      if (state.process === child) {
        console.warn(`[tunnel] cloudflared 종료 (code=${code}) — 공개 주소 해제`);
        state.process = null;
        state.url = null;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new TunnelUnavailableError(
            `cloudflared 가 바로 종료됐습니다 (code=${code}).\n${logTail.slice(-400)}`,
            true,
          ),
        );
      }
    });
  });
}
