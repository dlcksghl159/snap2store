import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import { normalizeKeyword, researchKeywordVolumes } from "../naver/searchad.js";
import { validateTitle } from "./title-gate.js";
import type { SeoTitleResult, ShoppingSearchItem, SpecFact } from "../../src/domain/types";

const TITLE_BUDGET = 48;
const MAX_TOKENS = 12;
const MAX_RESEARCH_EXPRESSIONS = 15;

/* ── ① 분해 ─────────────────────────────────────────────────── */

const UnitSchema = z.object({
  kind: z.string().max(40),
  importance: z.enum(["primary", "secondary", "optional"]),
  expressions: z.array(z.string().max(40)).min(1).max(6),
});
const DecompositionSchema = z.object({ units: z.array(UnitSchema).min(1).max(10) });

const DECOMPOSITION_JSON_SCHEMA = strictObject({
  units: {
    type: "array",
    items: strictObject({
      kind: {
        type: "string",
        description: "유닛 종류. 상품군 명사 유닛은 정확히 하나이며 kind 는 'product_type'.",
      },
      importance: { type: "string", enum: ["primary", "secondary", "optional"] },
      expressions: {
        type: "array",
        items: { type: "string" },
        description: "이 유닛을 표현할 수 있는 표기들 (1~6개)",
      },
    }),
  },
});

const DECOMPOSITION_SYSTEM = `당신은 네이버 스마트스토어 상품명 최적화의 분해 단계를 맡습니다.
초안 제목을 의미 유닛으로 쪼개고, 유닛마다 한국 쇼핑객이 실제로 검색할 대체 표현을 붙입니다.

절대 규칙:
- 근거에 없는 브랜드·성능·인증·수치·대상을 만들지 않습니다. 근거에 있는 사실만 표현을 바꿉니다.
- 상품군 명사 유닛(kind = "product_type")은 정확히 하나이며 importance 는 "primary" 입니다.
- 숫자·단위·수량은 정확히 보존합니다 (예: "2단"을 "3단"으로 바꾸지 않습니다).
- 각 표현은 공백 없는 단일 토큰이거나 짧은 명사구입니다.`;

const CandidateSchema = z.object({
  candidates: z
    .array(
      z.object({
        strategy: z.enum(["accuracy", "balanced", "conversion"]),
        title: z.string().max(60),
      }),
    )
    .length(3),
});

const CANDIDATE_JSON_SCHEMA = strictObject({
  candidates: {
    type: "array",
    items: strictObject({
      strategy: { type: "string", enum: ["accuracy", "balanced", "conversion"] },
      title: { type: "string", description: "공백 포함 50자 이내의 상품명" },
    }),
    description: "정확히 3개 — accuracy / balanced / conversion 각 1개",
  },
});

const CANDIDATE_SYSTEM = `당신은 네이버 스마트스토어 상품명의 어순을 구성합니다. 조합 탐색은 이미 끝났습니다 —
당신은 주어진 토큰을 읽기 좋은 순서로 배열하기만 합니다.

절대 규칙:
- 제공된 토큰·유닛 표현에 있는 단어만 사용합니다. 새 단어를 만들지 않습니다.
- 상품군 명사는 앞쪽 1~3단어 안에 옵니다.
- 같은 단어를 두 번 쓰지 않습니다.
- 공백 포함 50자 이내.
- 정확히 3개 후보: accuracy(사실 충실) / balanced(균형) / conversion(검색 유입 중시).`;

/* ── 어휘 검증 ──────────────────────────────────────────────── */

export function vocabularyKeys(sources: string[]): Set<string> {
  const keys = new Set<string>();
  for (const source of sources) {
    for (const word of source.split(/[\s/,]+/)) {
      const cleaned = word.trim();
      if (cleaned.length < 2) continue;
      keys.add(cleaned.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR"));
    }
  }
  return keys;
}

function titleUsesOnlyKnownWords(title: string, vocabulary: Set<string>): boolean {
  for (const word of title.split(/[\s/,]+/)) {
    const cleaned = word.trim();
    if (cleaned.length < 2) continue;
    const key = cleaned.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
    if (!vocabulary.has(key)) return false;
  }
  return true;
}

/**
 * ③ 질의 풀 진실 필터 — 수확한 키워드 중 허용 어휘로 **완전 분해 가능한 것만** 채택.
 * 환각 방지의 핵심. DP 로 분해 가능 판정, 토큰 길이 2~12.
 */
export function isDecomposable(keyword: string, vocabulary: Set<string>): boolean {
  const text = keyword.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
  if (text.length === 0) return false;
  const reachable = new Array<boolean>(text.length + 1).fill(false);
  reachable[0] = true;
  for (let end = 1; end <= text.length; end += 1) {
    for (let length = 2; length <= 12; length += 1) {
      const start = end - length;
      if (start < 0) break;
      if (!reachable[start]) continue;
      if (vocabulary.has(text.slice(start, end))) {
        reachable[end] = true;
        break;
      }
    }
  }
  return reachable[text.length];
}

/* ── ④ 서버 토큰 최적화 ─────────────────────────────────────── */

interface TokenPick {
  token: string;
  volume: number;
}

export function optimizeTokens(input: {
  anchor: string;
  tokens: TokenPick[];
  queries: Array<{ text: string; volume: number }>;
}): string[] {
  const chosen: string[] = [input.anchor];
  let used = input.anchor.length;
  const remaining = input.tokens.filter((entry) => entry.token !== input.anchor);

  const coverageOf = (tokens: string[]): number => {
    let covered = 0;
    for (const query of input.queries) {
      const key = query.text.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
      const joined = tokens.join("").normalize("NFKC").toLocaleLowerCase("ko-KR");
      if (tokens.some((token) => key.includes(token.toLocaleLowerCase("ko-KR"))) && joined.length > 0) {
        covered += 1;
      }
    }
    return covered;
  };

  let currentCoverage = coverageOf(chosen);

  while (chosen.length < MAX_TOKENS && remaining.length > 0) {
    let best: { index: number; value: number; token: string } | null = null;
    remaining.forEach((entry, index) => {
      const length = entry.token.length;
      if (used + 1 + length > TITLE_BUDGET) return;
      const gain = coverageOf([...chosen, entry.token]) - currentCoverage;
      const value = (gain + entry.volume * 0.01 + 1) / Math.max(1, length);
      if (!best || value > best.value) best = { index, value, token: entry.token };
    });
    if (!best) break;
    const picked = best as { index: number; value: number; token: string };
    chosen.push(picked.token);
    used += 1 + picked.token.length;
    currentCoverage = coverageOf(chosen);
    remaining.splice(picked.index, 1);
  }

  return chosen;
}

/* ── 파이프라인 ─────────────────────────────────────────────── */

export interface SeoTitleInput {
  draftTitle: string;
  productGroup: string;
  categoryPath: string | null;
  specFacts: SpecFact[];
  labelTexts: string[];
  comps: ShoppingSearchItem[];
}

const EMPTY: SeoTitleResult = {
  title: null,
  strategy: null,
  coveredQueries: [],
  uncoveredQueries: [],
  monthlyVolume: 0,
  warnings: [],
};

/** 어떤 단계의 실패도 비치명이다. null 을 반환하면 호출자가 에이전트 제목을 유지한다. */
export async function generateSeoTitle(input: SeoTitleInput): Promise<SeoTitleResult> {
  const warnings: string[] = [];

  // ① 분해
  let decomposition: z.infer<typeof DecompositionSchema>;
  try {
    const evidence = [
      `초안 제목: ${input.draftTitle}`,
      `상품군: ${input.productGroup}`,
      `카테고리 경로: ${input.categoryPath ?? "미확정"}`,
      input.specFacts.length > 0
        ? `확정 스펙: ${input.specFacts.map((fact) => `${fact.label}=${fact.value}`).join(" / ")}`
        : "확정 스펙: 없음",
      input.labelTexts.length > 0 ? `라벨 전사: ${input.labelTexts.slice(0, 12).join(" | ")}` : "라벨 전사: 없음",
      input.comps.length > 0
        ? `시장 comps 제목: ${input.comps.slice(0, 12).map((comp) => comp.title).filter(Boolean).join(" | ")}`
        : "시장 comps 제목: 없음",
    ].join("\n");

    decomposition = await requestOpenAiJson({
      system: DECOMPOSITION_SYSTEM,
      user: evidence,
      schemaName: "title_decomposition",
      jsonSchema: DECOMPOSITION_JSON_SCHEMA,
      validator: DecompositionSchema,
      reasoningEffort: "low",
    });
  } catch (error) {
    console.warn("[title-seo] 분해 실패:", error instanceof Error ? error.message : error);
    return { ...EMPTY, warnings: ["상품명 SEO 분해 단계 실패 — 에이전트 제목을 유지합니다."] };
  }

  const productTypeUnit =
    decomposition.units.find((unit) => unit.kind === "product_type") ??
    decomposition.units.find((unit) => unit.importance === "primary") ??
    decomposition.units[0];
  const anchor = productTypeUnit.expressions[0];

  // 허용 어휘 = 근거 + 유닛 표현
  const vocabulary = vocabularyKeys([
    input.draftTitle,
    input.productGroup,
    input.categoryPath ?? "",
    ...input.specFacts.map((fact) => `${fact.label} ${fact.value}`),
    ...input.labelTexts,
    ...decomposition.units.flatMap((unit) => unit.expressions),
  ]);

  // ② 수요 검증 — 중요도 순, 최대 15개
  const importanceRank = { primary: 0, secondary: 1, optional: 2 } as const;
  const expressions = decomposition.units
    .slice()
    .sort((a, b) => importanceRank[a.importance] - importanceRank[b.importance])
    .flatMap((unit) => unit.expressions)
    .slice(0, MAX_RESEARCH_EXPRESSIONS);

  const research = await researchKeywordVolumes(expressions);
  if (!research.available) warnings.push("검색 수요 API 자격증명이 없어 검색량 없이 조합했습니다.");

  // ③ 질의 풀 진실 필터
  const queries = research.harvested
    .filter((entry) => isDecomposable(entry.keyword, vocabulary))
    .sort((a, b) => b.monthlyVolume - a.monthlyVolume)
    .slice(0, 40)
    .map((entry) => ({ text: entry.keyword, volume: entry.monthlyVolume }));

  // ④ 서버 토큰 최적화
  const tokenPicks: TokenPick[] = [];
  const seenToken = new Set<string>([anchor]);
  for (const unit of decomposition.units) {
    for (const expression of unit.expressions) {
      const token = expression.trim();
      if (!token || seenToken.has(token)) continue;
      seenToken.add(token);
      tokenPicks.push({ token, volume: research.volumes.get(normalizeKeyword(token)) ?? 0 });
    }
  }
  const tokens = optimizeTokens({ anchor, tokens: tokenPicks, queries });

  // ⑤ 어순 구성
  let candidates: z.infer<typeof CandidateSchema>;
  try {
    candidates = await requestOpenAiJson({
      system: CANDIDATE_SYSTEM,
      user: [
        `상품군 명사(앵커): ${anchor}`,
        `사용 가능한 토큰: ${tokens.join(" · ")}`,
        `유닛 표현: ${decomposition.units.map((unit) => `${unit.kind}[${unit.expressions.join("/")}]`).join(" ")}`,
      ].join("\n"),
      schemaName: "title_candidates",
      jsonSchema: CANDIDATE_JSON_SCHEMA,
      validator: CandidateSchema,
      reasoningEffort: "low",
    });
  } catch (error) {
    console.warn("[title-seo] 어순 구성 실패:", error instanceof Error ? error.message : error);
    return { ...EMPTY, warnings: [...warnings, "상품명 어순 구성 실패 — 에이전트 제목을 유지합니다."] };
  }

  // ⑥ 선택
  const scored = candidates.candidates
    .map((candidate) => {
      const gate = validateTitle(candidate.title, "generation");
      if (gate.errors.length > 0) return null;
      if (!titleUsesOnlyKnownWords(gate.title, vocabulary)) return null;
      const key = gate.title.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR");
      const covered = queries.filter((query) =>
        key.includes(query.text.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ko-KR")),
      );
      return {
        strategy: candidate.strategy,
        title: gate.title,
        covered: covered.map((query) => query.text),
        volume: covered.reduce((sum, query) => sum + query.volume, 0),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.volume - a.volume);

  const winner = scored[0];
  if (!winner) {
    return { ...EMPTY, warnings: [...warnings, "상품명 후보가 게이트·어휘 검증을 통과하지 못했습니다."] };
  }

  const coveredSet = new Set(winner.covered);
  return {
    title: winner.title,
    strategy: winner.strategy,
    coveredQueries: winner.covered,
    uncoveredQueries: queries.filter((query) => !coveredSet.has(query.text)).slice(0, 12).map((query) => query.text),
    monthlyVolume: winner.volume,
    warnings,
  };
}
