import { createApp } from "./app.js";
import { env } from "./env.js";

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
app.listen(env.AGENT_API_PORT, "0.0.0.0", () => {
  console.log(`Snap2Store agent API ready on port ${env.AGENT_API_PORT}`);
});
