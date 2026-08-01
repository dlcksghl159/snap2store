// ⚠ 절대 규칙: fetch 와 ProxyAgent 는 반드시 같은 undici 패키지 것을 쓴다.
// Node 내장 fetch 에 npm undici 의 dispatcher 를 주입하면 버전 불일치로
// `invalid onRequestStart method` 류 런타임 오류가 난다.
import { fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit } from "undici";
import { env } from "../env.js";

export const DEFAULT_JSON_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

let proxyAgent: ProxyAgent | null = null;
let proxyResolved = false;
let proxyWarned = false;

function resolveProxyAgent(): ProxyAgent | null {
  if (proxyResolved) return proxyAgent;
  proxyResolved = true;
  if (env.COMMERCE_PROXY_URL) {
    try {
      proxyAgent = new ProxyAgent(env.COMMERCE_PROXY_URL);
    } catch (error) {
      // 프록시 URL 에 자격증명이 들어 있으므로 절대 노출하지 않는다.
      console.warn(`[commerce] 프록시 초기화 실패 — 직접 연결로 진행합니다: ${error instanceof Error ? error.name : "unknown"}`);
      proxyAgent = null;
    }
  } else if (!proxyWarned && env.SMARTSTORE_MODE === "live") {
    proxyWarned = true;
    console.warn(
      "[commerce] COMMERCE_PROXY_URL 이 없습니다 — 커머스 API 는 등록된 egress IP 만 허용합니다.",
    );
  }
  return proxyAgent;
}

/** 프록시 URL 의 호스트명만 남긴다 — 자격증명 노출 금지. */
function proxyHostLabel(): string | null {
  if (!env.COMMERCE_PROXY_URL) return null;
  try {
    return new URL(env.COMMERCE_PROXY_URL).host;
  } catch {
    return "proxy";
  }
}

export interface CommerceFetchOptions extends Omit<RequestInit, "signal" | "dispatcher"> {
  timeoutMs?: number;
}

export async function commerceFetch(url: string, options: CommerceFetchOptions = {}) {
  const { timeoutMs = DEFAULT_JSON_TIMEOUT_MS, ...init } = options;
  const dispatcher = resolveProxyAgent();
  try {
    return await undiciFetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher: dispatcher as Dispatcher } : {}),
    });
  } catch (error) {
    // 프록시 경유 실패는 원인이 `fetch failed` 로 뭉개진다 — 호스트명만 남긴 메시지로 감싼다.
    const host = proxyHostLabel();
    if (host) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`프록시(${host}) 경유 요청 실패: ${detail}`, { cause: error });
    }
    throw error;
  }
}

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 지수 백오프 재시도. ⚠ 쓰기 요청(상품 등록)에는 절대 쓰지 않는다.
 */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 2000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError;
}

/** 직렬 스로틀 — 호출 간 최소 간격을 보장한다. */
export function createSerialThrottle(minIntervalMs: number): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = 0;
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const waitFor = lastAt + minIntervalMs - Date.now();
      if (waitFor > 0) await sleep(waitFor);
      try {
        return await task();
      } finally {
        lastAt = Date.now();
      }
    });
    chain = run.catch(() => undefined);
    return run as Promise<T>;
  };
}
