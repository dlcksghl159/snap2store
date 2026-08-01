import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import { fetchRecommendTags, fetchRestrictedTags } from "../commerce/client.js";
import { createSerialThrottle } from "../commerce/http.js";
import { hasCommerceCredentials } from "../env.js";
import type { ResolvedTag, TagResolution } from "../../src/domain/types";

const MAX_TAGS = 10;
const RESTRICTED_BATCH = 20;
const OVERDRAW = 6;

/** 정규화는 반드시 이 순서. */
export function normalizeTag(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .trim();
}

export function tagKey(value: string): string {
  return normalizeTag(value).toLocaleLowerCase("ko-KR");
}

export function dedupeTags(values: string[], limit = MAX_TAGS): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const normalized = normalizeTag(raw ?? "");
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase("ko-KR");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

/** 호출 간 350ms 직렬 스로틀. */
const recommendThrottle = createSerialThrottle(350);

export interface OfficialLookup {
  official: boolean;
  text: string;
}

/**
 * `recommend-tags` 는 조회가 아니라 **접두어 매치 목록**이다.
 * 정규화 키가 정확히 일치하는 행이 있을 때만 공식으로 인정하고,
 * 채택 시 네이버 저장 철자를 따른다 (예: USB충전식 → usb충전식).
 */
export function pickOfficialSpelling(
  rows: Array<{ text?: string }>,
  tag: string,
): OfficialLookup {
  const key = tagKey(tag);
  const exact = rows.find((row) => tagKey(row.text ?? "") === key);
  return exact?.text
    ? { official: true, text: normalizeTag(exact.text) }
    : { official: false, text: normalizeTag(tag) };
}

export async function lookupOfficialSpelling(tag: string): Promise<OfficialLookup> {
  const rows = await recommendThrottle(() => fetchRecommendTags(tag));
  return pickOfficialSpelling(rows, tag);
}

export async function filterRestricted(
  tags: string[],
): Promise<{ allowed: string[]; removed: string[]; checked: boolean }> {
  if (!hasCommerceCredentials() || tags.length === 0) {
    return { allowed: tags, removed: [], checked: false };
  }
  const restricted = new Set<string>();
  try {
    for (let offset = 0; offset < tags.length; offset += RESTRICTED_BATCH) {
      const batch = tags.slice(offset, offset + RESTRICTED_BATCH);
      const rows = await fetchRestrictedTags(batch);
      for (const row of rows) {
        if (row?.restricted) restricted.add(tagKey(row.tag ?? ""));
      }
    }
  } catch (error) {
    console.warn("[tags] 제한 태그 조회 실패:", error instanceof Error ? error.message : error);
    // 조회 실패 시 태그를 조용히 비우지 않고 미검증 상태로 유지한다.
    return { allowed: tags, removed: [], checked: false };
  }
  const allowed = tags.filter((tag) => !restricted.has(tagKey(tag)));
  const removed = tags.filter((tag) => restricted.has(tagKey(tag)));
  return { allowed, removed, checked: true };
}

/* ── 기본 경로 ───────────────────────────────────────────────── */

export interface ResolveTagsInput {
  candidates: string[];
  leafName?: string | null;
}

export async function resolveTags(input: ResolveTagsInput): Promise<TagResolution> {
  const warnings: string[] = [];
  const leafKey = input.leafName ? tagKey(input.leafName) : null;

  // ⚠ 카테고리 leaf 이름과 동일한 태그는 후보에서 제외한다 — 제한 태그로 걸린다.
  const candidates = dedupeTags(input.candidates, MAX_TAGS + OVERDRAW).filter(
    (tag) => !leafKey || tagKey(tag) !== leafKey,
  );

  const official = new Map<string, boolean>();
  const spelled: string[] = [];
  if (hasCommerceCredentials()) {
    for (const tag of candidates) {
      try {
        const lookup = await lookupOfficialSpelling(tag);
        official.set(tagKey(lookup.text), lookup.official);
        spelled.push(lookup.text);
      } catch (error) {
        // 연쇄 실패를 피하기 위해 한 번 실패하면 남은 태그는 미검증으로 두고 루프를 끊는다.
        warnings.push("태그 공식 사전 대조를 완료하지 못했습니다 — 정규화만 적용합니다.");
        console.warn("[tags] 추천 태그 조회 실패:", error instanceof Error ? error.message : error);
        spelled.push(...candidates.slice(spelled.length));
        break;
      }
    }
  } else {
    warnings.push("태그 정규화 적용 — 공식 사전 대조 미완 (커머스 자격증명 없음).");
    spelled.push(...candidates);
  }

  const unique = dedupeTags(spelled, MAX_TAGS + OVERDRAW);
  const { allowed, removed, checked } = await filterRestricted(unique);
  if (!checked && unique.length > 0 && hasCommerceCredentials()) {
    warnings.push("제한 태그 대조를 완료하지 못했습니다 — 미검증 상태로 진행합니다.");
  }
  if (removed.length > 0) {
    warnings.push(`제한 태그 ${removed.length}개를 제외했습니다: ${removed.join(", ")}`);
  }

  const tags: ResolvedTag[] = allowed.slice(0, MAX_TAGS).map((text) => ({
    text,
    official: official.get(tagKey(text)) ?? false,
    restricted: false,
    relation: null,
    score: 0,
  }));

  return { tags, restrictedRemoved: removed, dictionaryChecked: checked && official.size > 0, warnings };
}

/* ── 포트폴리오 생성 ─────────────────────────────────────────── */

const RELATION_SCORE: Record<string, number> = {
  exact: 100,
  synonym: 86,
  function: 66,
  use_case: 48,
  style: 40,
};

const SeedPlanSchema = z.object({
  exact: z.array(z.string().max(40)).max(4),
  synonym: z.array(z.string().max(40)).max(4),
  function: z.array(z.string().max(40)).max(4),
  useCase: z.array(z.string().max(40)).max(4),
  style: z.array(z.string().max(40)).max(4),
});

const SEED_JSON_SCHEMA = strictObject({
  exact: { type: "array", items: { type: "string" }, description: "상품군 그 자체 (최대 4)" },
  synonym: { type: "array", items: { type: "string" }, description: "동의어 (최대 4)" },
  function: { type: "array", items: { type: "string" }, description: "기능·특징 (최대 4)" },
  useCase: { type: "array", items: { type: "string" }, description: "사용 상황 (최대 4)" },
  style: { type: "array", items: { type: "string" }, description: "디자인·스타일 (최대 4)" },
});

const AuditSchema = z.object({ passIndexes: z.array(z.number().int().min(0)).max(40) });
const AUDIT_JSON_SCHEMA = strictObject({
  passIndexes: { type: "array", items: { type: "integer" }, description: "통과시킬 태그의 0-기반 인덱스" },
});

const SEED_SYSTEM = `네이버 추천 태그 API에 넣을 seed keyword를 만듭니다. 목표는 최종 태그를 직접
정하는 것이 아니라 좋은 검색 시드를 만드는 것입니다.
- 이 상품을 사실대로 설명하는 표현만. 브랜드명·판매자명·다른 품목명 금지.
- exact=상품군 그 자체, synonym=동의어, function=기능·특징, useCase=사용 상황,
  style=디자인·스타일.`;

const AUDIT_SYSTEM = `이 상품을 사실대로 설명하는 태그만 통과시킵니다. 다른 품목·브랜드·과장 효능
태그는 기각합니다. 통과 인덱스만 반환하세요.`;

export interface TagPortfolioInput {
  productTitle: string;
  productGroup: string;
  summary: string;
  agentTags: string[];
  uncoveredQueries: string[];
  leafName: string | null;
  categoryPath: string | null;
}

interface Scored {
  text: string;
  relation: string;
  official: boolean;
  uncoveredJoin: boolean;
  score: number;
}

export async function generateTagPortfolio(input: TagPortfolioInput): Promise<TagResolution> {
  const warnings: string[] = [];
  const leafKey = input.leafName ? tagKey(input.leafName) : null;
  const excluded = (tag: string): boolean => Boolean(leafKey && tagKey(tag) === leafKey);

  // ① 시드 계획
  let plan: z.infer<typeof SeedPlanSchema> | null = null;
  try {
    plan = await requestOpenAiJson({
      system: SEED_SYSTEM,
      user: `상품명: ${input.productTitle}\n상품군: ${input.productGroup}\n요약: ${input.summary}\n카테고리: ${input.categoryPath ?? "미확정"}`,
      schemaName: "tag_seed_plan",
      jsonSchema: SEED_JSON_SCHEMA,
      validator: SeedPlanSchema,
      reasoningEffort: "low",
    });
  } catch (error) {
    warnings.push("태그 시드 계획을 만들지 못해 에이전트 태그로 진행합니다.");
    console.warn("[tags] 시드 계획 실패:", error instanceof Error ? error.message : error);
  }

  const relationBySeed: Array<{ seed: string; relation: string }> = [];
  if (plan) {
    const groups: Array<[string, string[]]> = [
      ["exact", plan.exact],
      ["synonym", plan.synonym],
      ["function", plan.function],
      ["use_case", plan.useCase],
      ["style", plan.style],
    ];
    // 라운드로빈, 최대 8시드
    let index = 0;
    while (relationBySeed.length < 8) {
      let added = false;
      for (const [relation, seeds] of groups) {
        const seed = seeds[index];
        if (!seed) continue;
        added = true;
        if (relationBySeed.length >= 8) break;
        relationBySeed.push({ seed: normalizeTag(seed), relation });
      }
      if (!added) break;
      index += 1;
    }
  }

  // ② 시드별 recommend-tags 수집
  const pool = new Map<string, Scored>();
  const push = (text: string, relation: string, official: boolean, uncoveredJoin: boolean): void => {
    const normalized = normalizeTag(text);
    if (!normalized || excluded(normalized)) return;
    const key = tagKey(normalized);
    const base = RELATION_SCORE[relation] ?? 40;
    const score = base + (official ? 20 : 0) + (uncoveredJoin ? 60 : 0);
    const existing = pool.get(key);
    if (existing && existing.score >= score) return;
    pool.set(key, { text: normalized, relation, official, uncoveredJoin, score });
  };

  if (hasCommerceCredentials()) {
    for (const { seed, relation } of relationBySeed) {
      try {
        const rows = await recommendThrottle(() => fetchRecommendTags(seed));
        const seedKey = tagKey(seed);
        for (const row of rows.slice(0, 6)) {
          const text = normalizeTag(row.text ?? "");
          if (!text) continue;
          push(text, relation, true, false);
        }
        if (!rows.some((row) => tagKey(row.text ?? "") === seedKey)) push(seed, relation, false, false);
      } catch (error) {
        warnings.push("태그 정규화 적용 — 공식 사전 대조 미완.");
        console.warn("[tags] 추천 태그 수집 중단:", error instanceof Error ? error.message : error);
        break;
      }
    }
  } else {
    warnings.push("태그 정규화 적용 — 공식 사전 대조 미완 (커머스 자격증명 없음).");
  }

  // ③ 에이전트 태그 + 제목 미커버 질의 조인
  for (const tag of input.agentTags) push(tag, "synonym", pool.get(tagKey(tag))?.official ?? false, false);

  for (const query of input.uncoveredQueries) {
    const normalized = normalizeTag(query);
    if (!normalized || excluded(normalized)) continue;
    // 미커버 질의는 공식 사전 등재분만 채택한다 — 검증 등급을 낮추면서까지 넣지 않는다.
    if (!hasCommerceCredentials()) continue;
    try {
      const lookup = await lookupOfficialSpelling(normalized);
      if (lookup.official) push(lookup.text, "exact", true, true);
    } catch {
      break;
    }
  }

  let ranked = [...pool.values()].sort((a, b) => {
    if (a.uncoveredJoin !== b.uncoveredJoin) return a.uncoveredJoin ? -1 : 1;
    if (a.official !== b.official) return a.official ? -1 : 1;
    return b.score - a.score;
  });

  // ④ QA 감사 — 상품과 다른 태그는 검색량과 무관하게 기각
  if (ranked.length > 0) {
    try {
      const listing = ranked.map((entry, index) => `${index}. ${entry.text}`).join("\n");
      const audit = await requestOpenAiJson({
        system: AUDIT_SYSTEM,
        user: `상품명: ${input.productTitle}\n상품군: ${input.productGroup}\n요약: ${input.summary}\n\n태그 후보:\n${listing}`,
        schemaName: "tag_audit",
        jsonSchema: AUDIT_JSON_SCHEMA,
        validator: AuditSchema,
        reasoningEffort: "low",
      });
      const pass = new Set(audit.passIndexes);
      const filtered = ranked.filter((_, index) => pass.has(index));
      if (filtered.length > 0) ranked = filtered;
    } catch (error) {
      console.warn("[tags] QA 감사 실패 — 후보를 그대로 씁니다:", error instanceof Error ? error.message : error);
    }
  }

  // ⑤ 상한 +6개를 뽑아 제한 필터 통과 후 10개
  const overdrawn = ranked.slice(0, MAX_TAGS + OVERDRAW);
  const { allowed, removed, checked } = await filterRestricted(overdrawn.map((entry) => entry.text));
  if (removed.length > 0) {
    warnings.push(`제한 태그 ${removed.length}개를 제외했습니다: ${removed.join(", ")}`);
  }
  if (!checked && overdrawn.length > 0 && hasCommerceCredentials()) {
    warnings.push("제한 태그 대조를 완료하지 못했습니다 — 미검증 상태로 진행합니다.");
  }

  const allowedSet = new Set(allowed.map((tag) => tagKey(tag)));
  const tags: ResolvedTag[] = overdrawn
    .filter((entry) => allowedSet.has(tagKey(entry.text)))
    .slice(0, MAX_TAGS)
    .map((entry) => ({
      text: entry.text,
      official: entry.official,
      restricted: false,
      relation: entry.relation,
      score: entry.score,
    }));

  return {
    tags,
    restrictedRemoved: removed,
    dictionaryChecked: checked && tags.some((tag) => tag.official),
    warnings,
  };
}

/* ── seoInfo ─────────────────────────────────────────────────── */

/** 단어 경계 클립 — 마지막 공백이 상한의 60% 이후면 거기서 자른다. */
export function clipAtWordBoundary(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= limit) return trimmed;
  const clipped = trimmed.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim();
}

export interface SeoInfoPayload {
  pageTitle?: string;
  metaDescription?: string;
  sellerTags?: Array<{ text: string }>;
}

export function buildSeoInfo(input: {
  title: string;
  summary: string;
  tags: ResolvedTag[];
}): SeoInfoPayload | null {
  const payload: SeoInfoPayload = {};
  const pageTitle = clipAtWordBoundary(input.title, 40);
  if (pageTitle) payload.pageTitle = pageTitle;
  const metaDescription = clipAtWordBoundary(input.summary, 80);
  if (metaDescription) payload.metaDescription = metaDescription;
  // ⚠ sellerTags 에는 text 만 싣는다. code 는 공백 제거 정규화와 불일치할 수 있다.
  if (input.tags.length > 0) {
    payload.sellerTags = input.tags.slice(0, MAX_TAGS).map((tag) => ({ text: tag.text }));
  }
  return Object.keys(payload).length > 0 ? payload : null;
}
