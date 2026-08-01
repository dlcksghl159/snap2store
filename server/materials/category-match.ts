import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import {
  getCategoryTree,
  resolveLeafFromDisplayPath,
  searchLeaves,
  type CategoryTree,
} from "../catalog/categories.js";
import { searchComparableListings } from "../naver/openapi.js";
import { ShoppingSearchUnavailableError } from "../commerce/errors.js";
import type {
  CategoryAttempt,
  CategoryCandidate,
  CategoryMatchResult,
  ShoppingSearchItem,
} from "../../src/domain/types";

const MAX_ROUNDS = 3;
const TOP_CANDIDATES = 8;
const HEAD_WEIGHT = 1.5;
const HEAD_COUNT = 10;

/**
 * MATCH 편향 검증자 — 중립 검증자는 형제 카테고리를 이유로 계속 MISMATCH 를 내서
 * 루프가 소진되고 결국 아무것도 확정하지 못한다. 카테고리는 "정확히 최적"일 필요가
 * 없고 "그 매대에 놓여도 되는가"만 만족하면 된다.
 */
const VERIFIER_SYSTEM = `당신은 네이버 스마트스토어 카테고리 배치 검증자입니다.
상품 정보와 카테고리 경로를 보고, 이 상품이 그 카테고리에 진열되어도 되는지 판정합니다.

MISMATCH는 오직 "다른 종류의 물건"일 때만 냅니다. 다음은 전부 MATCH입니다:
- 더 세분화되었거나 덜 세분화된 카테고리 (세분성 차이)
- 형제 카테고리가 더 적합해 보이는 경우 (명명·취향 차이)
- 상품의 여러 기능 중 하나를 기준으로 분류된 경우
- 재질·대상·크기 같은 속성이 다른 경우
- 이미지를 판독하기 어려운 경우
판단이 갈리면 MATCH입니다.

MISMATCH일 때만 suggestedKeywords에 이 상품이 실제로 진열될 만한 상품군 검색어를 1~4개 제안합니다.
각 키워드는 검색창에 단독으로 넣을 완전한 상품군 명사구여야 하며, 서로 연결해 쓰지 않습니다.
이미 거부된 카테고리로 다시 이어질 키워드는 제안하지 마세요.
MATCH이면 suggestedKeywords는 빈 배열입니다.`;

const VerdictSchema = z.object({
  verdict: z.enum(["MATCH", "MISMATCH"]),
  reason: z.string().max(300),
  suggestedKeywords: z.array(z.string().max(60)).max(4),
});

const VERDICT_JSON_SCHEMA = strictObject({
  verdict: { type: "string", enum: ["MATCH", "MISMATCH"] },
  reason: { type: "string", description: "판정 근거 한두 문장 (300자 이내)" },
  suggestedKeywords: {
    type: "array",
    items: { type: "string" },
    description: "MISMATCH일 때만 1~4개. 각각 단독 검색 가능한 상품군 명사구.",
  },
});

const SelectionSchema = z.object({
  index: z.number().int().min(-1),
  reason: z.string().max(200),
});

const SELECTION_JSON_SCHEMA = strictObject({
  index: { type: "integer", description: "선택한 후보의 0-기반 인덱스. 적합한 것이 없으면 -1." },
  reason: { type: "string", description: "선택 근거 한 문장" },
});

export interface MatchCategoryInput {
  productGroupName: string;
  productSummary: string;
  productTitle?: string;
  imageDataUrl?: string | null;
}

function collectVotes(
  tree: CategoryTree,
  comps: ShoppingSearchItem[],
  tally: Map<string, CategoryCandidate>,
): void {
  comps.forEach((comp, index) => {
    const pathNames = comp.categoryPath.length > 0 ? comp.categoryPath.slice(0, 4) : [];
    if (pathNames.length === 0) return;
    const resolved = resolveLeafFromDisplayPath(tree, pathNames);
    if (!resolved) return;

    const weight = index < HEAD_COUNT ? HEAD_WEIGHT : 1;
    const id = String(resolved.category.id);
    const existing = tally.get(id);
    if (existing) {
      existing.votes += weight;
      return;
    }
    tally.set(id, {
      categoryId: id,
      categoryName: resolved.category.wholeCategoryName ?? resolved.category.name,
      leafName: resolved.category.name,
      votes: weight,
      matchKind: resolved.matchKind,
    });
  });
}

function rank(tally: Map<string, CategoryCandidate>): CategoryCandidate[] {
  return [...tally.values()].sort((a, b) => b.votes - a.votes);
}

async function verifyPlacement(input: {
  productTitle: string;
  productSummary: string;
  categoryPath: string;
  rejected: string[];
  imageDataUrl?: string | null;
}): Promise<z.infer<typeof VerdictSchema>> {
  const userLines = [
    `상품명: ${input.productTitle}`,
    `설명: ${input.productSummary}`,
    `배치된 카테고리 경로: ${input.categoryPath}`,
  ];
  if (input.rejected.length > 0) {
    userLines.push(`이미 거부된 카테고리: ${input.rejected.join(" | ")}`);
  }

  return requestOpenAiJson({
    system: VERIFIER_SYSTEM,
    user: userLines.join("\n"),
    imageUrls: input.imageDataUrl ? [input.imageDataUrl] : undefined,
    schemaName: "category_placement_verdict",
    jsonSchema: VERDICT_JSON_SCHEMA,
    validator: VerdictSchema,
    reasoningEffort: "low",
  });
}

async function selectFromTree(
  candidates: CategoryCandidate[],
  input: MatchCategoryInput,
): Promise<CategoryCandidate | null> {
  if (candidates.length === 0) return null;
  const listing = candidates
    .map((candidate, index) => `${index}. ${candidate.categoryName}`)
    .join("\n");

  try {
    const selection = await requestOpenAiJson({
      system:
        "당신은 네이버 스마트스토어 카테고리 배치 담당자입니다. 주어진 후보 경로 중 이 상품이 실제로 진열될 곳을 하나 고릅니다. 세분성 차이나 형제 카테고리는 문제가 아닙니다 — 매대가 맞으면 고르세요. 정말로 전혀 다른 종류뿐이면 -1을 반환합니다.",
      user: `상품명: ${input.productTitle ?? input.productGroupName}\n상품군: ${input.productGroupName}\n설명: ${input.productSummary}\n\n후보:\n${listing}`,
      imageUrls: input.imageDataUrl ? [input.imageDataUrl] : undefined,
      schemaName: "category_tree_selection",
      jsonSchema: SELECTION_JSON_SCHEMA,
      validator: SelectionSchema,
      reasoningEffort: "low",
    });
    if (selection.index < 0 || selection.index >= candidates.length) return null;
    return candidates[selection.index];
  } catch (error) {
    console.warn("[category] 트리 선택 실패 — 1위 후보를 씁니다:", error instanceof Error ? error.message : error);
    return candidates[0];
  }
}

export async function matchCategory(input: MatchCategoryInput): Promise<CategoryMatchResult> {
  const productTitle = input.productTitle ?? input.productGroupName;
  const attempts: CategoryAttempt[] = [];
  const rejectedPaths: string[] = [];
  const tally = new Map<string, CategoryCandidate>();
  let compsSample: ShoppingSearchItem[] = [];
  let matchSource: CategoryMatchResult["matchSource"] = null;

  let tree: CategoryTree;
  try {
    tree = await getCategoryTree();
  } catch (error) {
    console.warn("[category] 카테고리 트리 사용 불가:", error instanceof Error ? error.message : error);
    return {
      outcome: "unavailable",
      categoryId: null,
      categoryName: null,
      leafName: null,
      matchSource: null,
      reviewRequired: true,
      attempts,
      candidates: [],
      compsSample: [],
    };
  }

  // 1) 상품군 명칭으로 카탈로그 모델 검색
  let catalogAvailable = true;
  try {
    compsSample = await searchComparableListings(input.productGroupName, 30);
    collectVotes(tree, compsSample, tally);
    if (tally.size > 0) matchSource = "catalog_models";
  } catch (error) {
    if (error instanceof ShoppingSearchUnavailableError) {
      catalogAvailable = false;
    } else {
      console.warn("[category] 카탈로그 검색 실패:", error instanceof Error ? error.message : error);
      catalogAvailable = false;
    }
  }

  let queue = rank(tally);

  // 카탈로그 검색이 불가능하면 트리 어휘 검색 + LLM 선택으로 강등한다.
  if (queue.length === 0) {
    const leaves = searchLeaves(tree, `${input.productGroupName} ${input.productSummary}`, 24);
    if (leaves.length === 0) {
      return {
        outcome: "unavailable",
        categoryId: null,
        categoryName: null,
        leafName: null,
        matchSource: null,
        reviewRequired: true,
        attempts,
        candidates: [],
        compsSample,
      };
    }
    const treeCandidates: CategoryCandidate[] = leaves.map((leaf) => ({
      categoryId: String(leaf.id),
      categoryName: leaf.wholeCategoryName ?? leaf.name,
      leafName: leaf.name,
      votes: 0,
      matchKind: "tree_search",
    }));
    const picked = await selectFromTree(treeCandidates, input);
    if (!picked) {
      return {
        outcome: "unavailable",
        categoryId: null,
        categoryName: null,
        leafName: null,
        matchSource: "tree_search",
        reviewRequired: true,
        attempts,
        candidates: treeCandidates.slice(0, TOP_CANDIDATES),
        compsSample,
      };
    }
    matchSource = "tree_search";
    queue = [picked, ...treeCandidates.filter((candidate) => candidate.categoryId !== picked.categoryId)];
  }

  // 5) 검증 루프
  let last: CategoryCandidate | null = queue[0] ?? null;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const candidate = queue[0];
    if (!candidate) break;
    last = candidate;

    let verdict: z.infer<typeof VerdictSchema>;
    try {
      verdict = await verifyPlacement({
        productTitle,
        productSummary: input.productSummary,
        categoryPath: candidate.categoryName,
        rejected: rejectedPaths,
        imageDataUrl: input.imageDataUrl,
      });
    } catch (error) {
      // 검증 호출 자체가 실패하면 마지막 후보를 유지한 채 review_required 로 반환한다.
      attempts.push({
        round,
        categoryId: candidate.categoryId,
        categoryName: candidate.categoryName,
        verdict: "ERROR",
        reason: error instanceof Error ? error.message : String(error),
        suggestedKeywords: [],
      });
      return {
        outcome: "review_required",
        categoryId: candidate.categoryId,
        categoryName: candidate.categoryName,
        leafName: candidate.leafName,
        matchSource,
        reviewRequired: true,
        attempts,
        candidates: rank(tally).slice(0, TOP_CANDIDATES),
        compsSample,
      };
    }

    attempts.push({
      round,
      categoryId: candidate.categoryId,
      categoryName: candidate.categoryName,
      verdict: verdict.verdict,
      reason: verdict.reason,
      suggestedKeywords: verdict.suggestedKeywords,
    });

    if (verdict.verdict === "MATCH") {
      return {
        outcome: "verified",
        categoryId: candidate.categoryId,
        categoryName: candidate.categoryName,
        leafName: candidate.leafName,
        matchSource,
        reviewRequired: false,
        attempts,
        candidates: rank(tally).slice(0, TOP_CANDIDATES),
        compsSample,
      };
    }

    // MISMATCH → 거부 집합에 넣고, 제안 키워드를 각각 단독으로 재검색한다.
    rejectedPaths.push(candidate.categoryName);
    const rejectedIds = new Set(
      attempts.filter((attempt) => attempt.verdict === "MISMATCH").map((attempt) => attempt.categoryId),
    );

    if (catalogAvailable && verdict.suggestedKeywords.length > 0 && round < MAX_ROUNDS) {
      const freshTally = new Map<string, CategoryCandidate>();
      for (const keyword of verdict.suggestedKeywords.slice(0, 4)) {
        // ⚠ 키워드를 이어 붙여 한 번에 검색하면 분류가 흩어져 투표가 무의미해진다.
        try {
          const results = await searchComparableListings(keyword, 20);
          collectVotes(tree, results, freshTally);
          collectVotes(tree, results, tally);
        } catch (error) {
          console.warn(
            `[category] 재검색 실패 ("${keyword}"):`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      const fresh = rank(freshTally).filter((entry) => !rejectedIds.has(entry.categoryId));
      const rest = queue.slice(1).filter(
        (entry) => !rejectedIds.has(entry.categoryId) && !fresh.some((f) => f.categoryId === entry.categoryId),
      );
      queue = [...fresh, ...rest];
    } else {
      queue = queue.slice(1).filter((entry) => !rejectedIds.has(entry.categoryId));
    }
  }

  // 3라운드 소진 → 마지막 후보를 유지한 채 review_required
  return {
    outcome: "review_required",
    categoryId: last?.categoryId ?? null,
    categoryName: last?.categoryName ?? null,
    leafName: last?.leafName ?? null,
    matchSource,
    reviewRequired: true,
    attempts,
    candidates: rank(tally).slice(0, TOP_CANDIDATES),
    compsSample,
  };
}
