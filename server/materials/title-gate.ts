/**
 * 상품명 하드 게이트 + 자동 보정.
 *
 * ⚠ 길이는 **문자 수**다. 공백 정리(`\s+ → " "`, trim) 후 UTF-16 length 기준.
 *   바이트가 아니다.
 */

export type TitleGateMode = "generation" | "registration";

const GENERATION_MAX = 50;
const REGISTRATION_MAX = 100;

export const FORBIDDEN_CHARACTER = /[*?"<>]/;

export const PROMOTION =
  /(무료배송|오늘출발|당일발송|특가|할인|쿠폰|최저가|이벤트|사은품|포인트|무이자|할부|1위|베스트|인기|MD추천)/i;

// ⚠ `~st` 모조 표기는 반드시 한글 앞자만 잡는다 — 영문 정상 단어(Nest, Everest, Forest…)를
//    오탐하면 자동 보정이 브랜드 토큰을 지워 버린다.
export const IMITATION =
  /(레플리카|미러급|정품퀄|싱크로율|보세|(?:네이버|이케아|나이키|아디다스|샤넬|구찌|루이비통|애플|삼성|다이슨|레고|스타벅스)(?:스타일|풍)|[가-힣]{2,}st(?:\s|$|[()[\],./-]))/i;

export const SENSITIVE_CLAIM =
  /(무해|무독성|치료|예방|통증\s*(?:치료|완화|예방|개선)|임상(?:시험)?|A\s*등급|A\s*급|Class\s*A|클래스\s*A|1\s*등급|최고급|프리미엄)/i;

/** 생성 게이트에만 적용한다. */
export const TEMPORAL_PROMOTION =
  /(?:신제품|신상품|신상|최신(?:형|식|버전)?|올해\s*신상|new\s*(?:제품|상품|모델))/i;

const SYNONYM_GROUPS_BASE: string[][] = [
  ["매트리스커버", "침대커버"],
  ["핸드폰", "휴대폰", "스마트폰"],
];
const SYNONYM_GROUPS_GENERATION: string[][] = [...SYNONYM_GROUPS_BASE, ["UV", "자외선"]];

export interface TitleGateResult {
  title: string;
  length: number;
  errors: string[];
  warnings: string[];
}

export function normalizeTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function globalize(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

export function validateTitle(rawTitle: string, mode: TitleGateMode = "generation"): TitleGateResult {
  const title = normalizeTitleWhitespace(rawTitle ?? "");
  const errors: string[] = [];
  const warnings: string[] = [];
  const limit = mode === "registration" ? REGISTRATION_MAX : GENERATION_MAX;

  if (title.length === 0) {
    errors.push("상품명이 비어 있습니다.");
    return { title, length: 0, errors, warnings };
  }
  if (title.length > limit) {
    errors.push(`상품명이 ${limit}자를 넘습니다 (현재 ${title.length}자).`);
  }
  if (mode === "registration" && title.length > GENERATION_MAX && title.length <= REGISTRATION_MAX) {
    warnings.push(`상품명이 ${GENERATION_MAX}자를 넘습니다 (현재 ${title.length}자) — 검색 노출에 불리합니다.`);
  }

  if (FORBIDDEN_CHARACTER.test(title)) {
    errors.push(`상품명에 사용할 수 없는 특수문자가 있습니다 (* ? " < >).`);
  }
  const promotion = title.match(PROMOTION);
  if (promotion) errors.push(`상품명에 홍보성 표현이 있습니다: "${promotion[0]}"`);

  const imitation = title.match(IMITATION);
  if (imitation) errors.push(`상품명에 모조품 연상 표현이 있습니다: "${imitation[0].trim()}"`);

  const claim = title.match(SENSITIVE_CLAIM);
  if (claim) errors.push(`상품명에 검증되지 않은 주장 표현이 있습니다: "${claim[0].trim()}"`);

  if (mode === "generation") {
    const temporal = title.match(TEMPORAL_PROMOTION);
    if (temporal) errors.push(`상품명에 시점 홍보 표현이 있습니다: "${temporal[0].trim()}"`);
  }

  const tokens = title.split(" ").filter(Boolean);
  const seen = new Map<string, number>();
  for (const token of tokens) {
    const key = token.toLocaleLowerCase("ko-KR");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [token, count] of seen) {
    if (count >= 2) errors.push(`상품명에 같은 단어가 반복됩니다: "${token}" (${count}회)`);
  }

  const groups = mode === "generation" ? SYNONYM_GROUPS_GENERATION : SYNONYM_GROUPS_BASE;
  const lowered = title.toLocaleLowerCase("ko-KR");
  for (const group of groups) {
    const hits = group.filter((word) => lowered.includes(word.toLocaleLowerCase("ko-KR")));
    if (hits.length >= 2) errors.push(`상품명에 같은 뜻의 표현이 겹칩니다: ${hits.join(" / ")}`);
  }

  return { title, length: title.length, errors, warnings };
}

export interface TitleRepairResult {
  title: string;
  changed: boolean;
  removed: string[];
}

/**
 * 게이트 위반을 사람 없이 기계적으로 해소한다 — 자율성의 핵심.
 * 보정 결과는 반드시 게이트를 다시 통과시킨 뒤 사용한다.
 */
export function repairTitle(
  rawTitle: string,
  fallbackName: string,
  mode: TitleGateMode = "registration",
): TitleRepairResult {
  const original = normalizeTitleWhitespace(rawTitle ?? "");
  const removed: string[] = [];
  let working = original;

  // 1) 금지 특수문자 → 공백
  working = working.replace(globalize(FORBIDDEN_CHARACTER), " ");

  // 2) 홍보·모조·주장 패턴 전역 치환 → 공백
  const patterns = [PROMOTION, IMITATION, SENSITIVE_CLAIM];
  if (mode === "generation") patterns.push(TEMPORAL_PROMOTION);
  for (const pattern of patterns) {
    working = working.replace(globalize(pattern), (match) => {
      removed.push(match.trim());
      return " ";
    });
  }
  working = normalizeTitleWhitespace(working);

  // 3) 반복 토큰은 첫 등장만 남김
  const seen = new Set<string>();
  working = working
    .split(" ")
    .filter((token) => {
      if (!token) return false;
      const key = token.toLocaleLowerCase("ko-KR");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" ");

  // 4) 동의어군은 첫 번째만 남김
  const groups = mode === "generation" ? SYNONYM_GROUPS_GENERATION : SYNONYM_GROUPS_BASE;
  for (const group of groups) {
    let kept = false;
    for (const word of group) {
      const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (!pattern.test(working)) continue;
      if (!kept) {
        kept = true;
        continue;
      }
      working = working.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
      removed.push(word);
    }
  }
  working = normalizeTitleWhitespace(working);

  // 5) 길이 초과 시 토큰 경계 우선 절단
  const limit = mode === "registration" ? REGISTRATION_MAX : GENERATION_MAX;
  if (working.length > limit) {
    const clipped = working.slice(0, limit);
    const lastSpace = clipped.lastIndexOf(" ");
    working = normalizeTitleWhitespace(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped);
  }

  // 6) 다 지워 비면 폴백 → 그마저 없으면 "상품"
  if (working.length === 0) {
    const fallback = normalizeTitleWhitespace(fallbackName ?? "");
    const safeFallback = fallback
      .replace(globalize(FORBIDDEN_CHARACTER), " ")
      .replace(globalize(PROMOTION), " ")
      .replace(globalize(IMITATION), " ")
      .replace(globalize(SENSITIVE_CLAIM), " ");
    working = normalizeTitleWhitespace(safeFallback).slice(0, limit) || "상품";
  }

  return { title: working, changed: working !== original, removed: [...new Set(removed)].filter(Boolean) };
}
