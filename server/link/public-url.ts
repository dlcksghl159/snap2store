import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../env.js";

/**
 * 폰이 밖에서 들어올 공개 주소를 찾는다.
 *
 * 우선순위:
 *  1. `LINK_PUBLIC_URL` — 손으로 꽂은 주소. 확실히 되는 길을 알고 있다면 그게 이긴다.
 *  2. 터널 지킴이(scripts/tunnel-keeper.mjs)가 적어 둔 파일 — **서버 재시작과 무관하게** 산다.
 *  3. 없으면 null → 호출부가 LAN 주소로 내려간다.
 *
 * ⚠ 파일을 매번 읽는다. 캐시하면 지킴이가 터널을 새로 발급했을 때(주소가 바뀐다)
 * 서버가 죽은 주소를 계속 QR 에 박는다 — 그게 정확히 시연에서 폰이 안 붙던 증상이다.
 * 세션 생성은 초당 수십 번 일어나는 일이 아니므로 이 정도 I/O 는 값이 싸다.
 */
const URL_FILE = path.join(env.cacheRoot, "tunnel-url.txt");
const HTTPS_URL = /^https:\/\/[^\s]+$/;

export function publicPhoneBase(): string | null {
  const configured = env.LINK_PUBLIC_URL.replace(/\/+$/, "");
  if (configured) return configured;
  try {
    const text = readFileSync(URL_FILE, "utf8").trim().replace(/\/+$/, "");
    return HTTPS_URL.test(text) ? text : null;
  } catch {
    return null; // 지킴이가 안 돌거나 터널이 내려갔다
  }
}

const PID_FILE = path.join(env.cacheRoot, "tunnel-keeper.pid");
const KEEPER_SCRIPT = path.join(env.projectRoot, "scripts", "tunnel-keeper.mjs");
const KEEPER_LOG = path.join(env.cacheRoot, "tunnel-keeper.log");

function keeperAlive(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 터널 지킴이를 **분리된 프로세스로** 띄운다.
 *
 * ⚠ detached 가 핵심이다. 자식으로 띄우면 `tsx watch` 가 서버를 재시작할 때 같이 죽고,
 * 그러면 터널이 사라져 QR 이 조용히 LAN 주소로 되돌아간다 — 시연장에서 폰이 안 붙던
 * 바로 그 증상이다. 분리해 두면 서버를 몇 번 껐다 켜도 터널은 그대로 살아 있다.
 *
 * 이미 살아 있으면 아무것도 하지 않는다. 지킴이 쪽에도 PID 잠금이 있어 이중 방어다 —
 * 지킴이가 여럿이면 각자 터널을 요청해 레이트 리밋을 스스로 부른다.
 */
export function ensureTunnelKeeper(): void {
  if (env.LINK_PUBLIC_URL) return; // 손으로 꽂은 주소가 있으면 터널이 필요 없다
  if (keeperAlive()) return;
  try {
    // 로그는 파일로 흘린다 — 부모가 죽어도 파이프가 막히지 않아야 한다.
    const log = openSync(KEEPER_LOG, "a");
    const child = spawn(process.execPath, [KEEPER_SCRIPT], {
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    console.log(`[tunnel] 지킴이를 띄웠습니다 (pid=${child.pid}) — 로그: ${KEEPER_LOG}`);
  } catch (error) {
    console.warn(
      `[tunnel] 지킴이를 띄우지 못했습니다 — LAN 모드로 계속합니다: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
