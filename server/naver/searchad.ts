import crypto from "node:crypto";
import { env, hasSearchAdCredentials } from "../env.js";
import { createSerialThrottle } from "../commerce/http.js";

const BASE_URL = "https://api.searchad.naver.com";
const KEYWORDSTOOL_PATH = "/keywordstool";
const MAX_HINT_KEYWORDS = 5;

/** 호출당 hintKeywords 최대 5개, 500ms 직렬 스로틀. */
const throttle = createSerialThrottle(500);

export interface KeywordVolume {
  keyword: string;
  normalized: string;
  monthlyVolume: number;
}

/** 매칭 키 정규화: NFKC → 공백 제거 → 대문자 (keywordstool 표기와 정렬). */
export function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

/** `"< 10"` 문자열은 5로 파싱한다 (측정된 수요 없음). */
function parseCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("<")) return 5;
    const parsed = Number.parseInt(trimmed.replace(/[^\d]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sign(timestamp: number, method: string, path: string, secretKey: string): string {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}.${method}.${path}`)
    .digest("base64");
}

interface KeywordRow {
  relKeyword?: string;
  monthlyPcQcCnt?: unknown;
  monthlyMobileQcCnt?: unknown;
}

async function fetchBatch(keywords: string[]): Promise<KeywordRow[]> {
  const timestamp = Date.now();
  const signature = sign(timestamp, "GET", KEYWORDSTOOL_PATH, env.NAVER_SEARCHAD_SECRET_KEY!);
  const url = new URL(BASE_URL + KEYWORDSTOOL_PATH);
  url.searchParams.set("hintKeywords", keywords.join(","));
  url.searchParams.set("showDetail", "1");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Timestamp": String(timestamp),
      "X-API-KEY": env.NAVER_SEARCHAD_API_KEY!,
      "X-Customer": env.NAVER_SEARCHAD_CUSTOMER_ID!,
      "X-Signature": signature,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`검색광고 API ${response.status}`);
  }
  const data = (await response.json()) as { keywordList?: KeywordRow[] };
  return Array.isArray(data?.keywordList) ? data.keywordList : [];
}

export interface KeywordResearch {
  /** 정확히 일치하는 행만 그 표현의 지표로 인정한다. */
  volumes: Map<string, number>;
  /** 응답의 keywordList 전체를 공짜로 수확한다 → 질의 풀 후보. */
  harvested: KeywordVolume[];
  available: boolean;
}

/**
 * 표현별 월간 검색량 조회. 자격증명이 없으면 빈 결과를 반환하고 파이프라인은 그대로 진행한다.
 * 실패하면 남은 배치를 생략하고 지금까지 결과로 진행한다 (연쇄 실패 방지).
 */
export async function researchKeywordVolumes(expressions: string[]): Promise<KeywordResearch> {
  const volumes = new Map<string, number>();
  const harvested: KeywordVolume[] = [];
  const seenHarvest = new Set<string>();

  if (!hasSearchAdCredentials()) {
    return { volumes, harvested, available: false };
  }

  const unique = [...new Set(expressions.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return { volumes, harvested, available: true };

  const wanted = new Map<string, string>();
  for (const expression of unique) wanted.set(normalizeKeyword(expression), expression);

  for (let offset = 0; offset < unique.length; offset += MAX_HINT_KEYWORDS) {
    const batch = unique.slice(offset, offset + MAX_HINT_KEYWORDS);
    let rows: KeywordRow[];
    try {
      rows = await throttle(() => fetchBatch(batch.map((value) => value.replace(/\s+/g, ""))));
    } catch (error) {
      console.warn(
        "[searchad] 조회 실패 — 남은 배치를 생략하고 진행합니다:",
        error instanceof Error ? error.message : error,
      );
      break;
    }

    for (const row of rows) {
      const keyword = typeof row.relKeyword === "string" ? row.relKeyword.trim() : "";
      if (!keyword) continue;
      const normalized = normalizeKeyword(keyword);
      const monthlyVolume = parseCount(row.monthlyPcQcCnt) + parseCount(row.monthlyMobileQcCnt);

      if (wanted.has(normalized)) volumes.set(normalized, monthlyVolume);
      if (!seenHarvest.has(normalized)) {
        seenHarvest.add(normalized);
        harvested.push({ keyword, normalized, monthlyVolume });
      }
    }
  }

  return { volumes, harvested, available: true };
}
