import bcrypt from "bcryptjs";
import { env } from "../env.js";
import { commerceFetch } from "./http.js";
import { CommerceApiError } from "./errors.js";

const TOKEN_URL = "https://api.commerce.naver.com/external/v1/oauth2/token";
/** 만료 5분 전까지 재사용한다. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
/** 동시 발급 요청은 in-flight 프라미스를 공유해 중복 발급을 막는다. */
let inFlight: Promise<string> | null = null;

function buildSignature(clientId: string, clientSecret: string, timestamp: number): string {
  const password = `${clientId}_${timestamp}`;
  // 시크릿이 salt 다.
  const hash = bcrypt.hashSync(password, clientSecret);
  return Buffer.from(hash).toString("base64");
}

async function issueToken(): Promise<string> {
  const clientId = env.NAVER_COMMERCE_CLIENT_ID;
  const clientSecret = env.NAVER_COMMERCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("커머스 API 자격증명이 없습니다 (NAVER_COMMERCE_CLIENT_ID / _SECRET).");
  }

  const timestamp = Date.now();
  let signature: string;
  try {
    signature = buildSignature(clientId, clientSecret, timestamp);
  } catch (error) {
    // `Invalid salt version` — 시크릿의 `\$` 이스케이프가 남아 있을 때 난다.
    throw new Error(
      `커머스 시크릿 서명 실패 — NAVER_COMMERCE_CLIENT_SECRET 형식을 확인하세요 (bcrypt salt): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    timestamp: String(timestamp),
    grant_type: "client_credentials",
    client_secret_sign: signature,
    type: "SELF",
  });

  const response = await commerceFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new CommerceApiError(response.status, "POST", "/v1/oauth2/token", text);
  }

  const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error("커머스 토큰 응답에 access_token 이 없습니다.");

  const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
  cached = {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + expiresInMs,
  };
  return cached.accessToken;
}

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.accessToken;
  }
  if (inFlight) return inFlight;
  inFlight = issueToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function resetCommerceTokenForTests(): void {
  cached = null;
  inFlight = null;
}
