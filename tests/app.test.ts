import { createServer, get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { clearRuntimeForTests } from "../server/store.js";
import { env } from "../server/env.js";

const app = createApp();

afterAll(async () => {
  await clearRuntimeForTests();
});

describe("HTTP 계약", () => {
  it("RUNTIME_ROOT 격리가 적용돼 있다 — 실런타임을 건드리지 않는다", () => {
    expect(env.runtimeRoot).toContain(".test-runtime");
  });

  it("GET /api/health → { ok: true }", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("GET /api/config 응답에 비밀 문자열이 없다", async () => {
    const response = await request(app).get("/api/config");
    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(Object.keys(response.body).sort()).toEqual(
      ["agentMode", "openaiReady", "smartstoreMode", "smartstoreReady"].sort(),
    );
    for (const secret of [
      env.OPENAI_API_KEY,
      env.NAVER_COMMERCE_CLIENT_ID,
      env.NAVER_COMMERCE_CLIENT_SECRET,
      env.COMMERCE_PROXY_URL,
      env.NAVER_SEARCHAD_API_KEY,
      env.NAVER_SEARCHAD_SECRET_KEY,
    ]) {
      if (secret) expect(body).not.toContain(secret);
    }
    expect(body).not.toMatch(/sk-[a-z0-9_-]{12,}/i);
  });

  it("POST /api/listings 파일 없이 → 400", async () => {
    const response = await request(app).post("/api/listings");
    expect(response.status).toBe(400);
  });

  it("잘못된 MIME → 400", async () => {
    const response = await request(app)
      .post("/api/listings")
      .attach("photos", Buffer.from("not an image"), {
        filename: "note.txt",
        contentType: "text/plain",
      });
    expect(response.status).toBe(400);
  });

  it("GET /api/listings/:id 없는 id → 404", async () => {
    const response = await request(app).get("/api/listings/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("GET /api/listings → 배열", async () => {
    const response = await request(app).get("/api/listings");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("GET /api/stream 이 text/event-stream 헤더로 응답한다", async () => {
    // SSE 는 끝나지 않는 응답이므로 실제 소켓을 열어 헤더만 읽고 즉시 끊는다.
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const headers = await new Promise<Record<string, string | string[] | undefined>>(
        (resolve, reject) => {
          const req = httpGet(
            { host: "127.0.0.1", port: address.port, path: "/api/stream" },
            (res) => {
              resolve(res.headers);
              res.destroy();
              req.destroy();
            },
          );
          req.on("error", reject);
        },
      );
      expect(String(headers["content-type"])).toContain("text/event-stream");
      expect(String(headers["cache-control"])).toContain("no-cache");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GET /stream 이 빌드 없이 단일 HTML 페이지를 반환한다", async () => {
    const response = await request(app).get("/stream");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("RAW API STREAM");
    // 채널 범례가 전부 있어야 세컨드 화면 게이트를 만족한다
    for (const channel of ["tool_call", "tool_result", "openai_raw", "image", "milestone", "status"]) {
      expect(response.text).toContain(channel);
    }
  });

  it("재실행은 저장된 draft 가 없으면 거부한다", async () => {
    const response = await request(app).post("/api/listings/does-not-exist/retry");
    expect(response.status).toBe(404);
  });
});
