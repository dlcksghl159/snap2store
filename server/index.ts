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
 */
void (async () => {
  try {
    const ips = lanAddresses();
    const tls = await ensureLinkTls(ips);
    const httpsServer = https.createServer(tls, app);
    httpsServer.on("upgrade", (request, socket, head) => {
      if (!linkHub.handleUpgrade(request, socket, head)) socket.destroy();
    });
    // tsx watch 재시작 직후엔 이전 프로세스가 포트를 아직 물고 있을 수 있다 —
    // EADDRINUSE 는 치명이 아니라 타이밍이므로 몇 번 되물어 본다.
    let attempts = 0;
    const listen = () => {
      httpsServer.listen(env.LINK_HTTPS_PORT, "0.0.0.0", () => {
        const host = ips[0] ?? "localhost";
        console.log(`Snap2Store phone link ready on https://${host}:${env.LINK_HTTPS_PORT}/phone`);
      });
    };
    httpsServer.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && attempts < 6) {
        attempts += 1;
        setTimeout(listen, 700);
        return;
      }
      console.error(`[link] HTTPS 포트를 열지 못했습니다 — 폰 링크 없이 계속합니다: ${error.message}`);
    });
    listen();
  } catch (error) {
    console.error(
      `[link] HTTPS 준비 실패 — 폰 링크 없이 계속합니다: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
})();

// 시연 당일 설정: LINK_TUNNEL=auto 면 부팅과 동시에 공개 터널을 데워 둔다.
if (env.LINK_TUNNEL === "auto") {
  void ensureTunnel().catch((error: unknown) => {
    console.error(
      `[tunnel] 자동 시작 실패 — LAN 모드로 계속합니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
