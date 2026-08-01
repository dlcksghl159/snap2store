import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      // 테스트는 반드시 전용 런타임 디렉토리를 쓴다 —
      // 실런타임(listings.json)을 공유하면 스토어 초기화 테스트가 실제 등록 이력을 지운다.
      RUNTIME_ROOT: "data/.test-runtime",
    },
  },
});
