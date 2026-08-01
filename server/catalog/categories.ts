import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { fetchAllCategories, type NaverCategory } from "../commerce/client.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_VALID_NODES = 1000;

export interface CategoryTree {
  syncedAt: string;
  byId: Map<string, NaverCategory>;
  byWholeName: Map<string, NaverCategory>;
  leaves: NaverCategory[];
  stale: boolean;
}

interface CacheFile {
  syncedAt: string;
  categories: NaverCategory[];
}

let memoryTree: CategoryTree | null = null;
let inFlight: Promise<CategoryTree> | null = null;

export function normalizePath(wholeName: string): string {
  return wholeName
    .split(">")
    .map((part) => part.trim().toLocaleLowerCase("ko-KR"))
    .filter(Boolean)
    .join(">");
}

function buildTree(categories: NaverCategory[], syncedAt: string, stale: boolean): CategoryTree {
  const byId = new Map<string, NaverCategory>();
  const byWholeName = new Map<string, NaverCategory>();
  const leaves: NaverCategory[] = [];

  for (const category of categories) {
    if (!category?.id) continue;
    byId.set(String(category.id), category);
    if (category.wholeCategoryName) {
      byWholeName.set(normalizePath(category.wholeCategoryName), category);
    }
    if (category.last) leaves.push(category);
  }

  return { syncedAt, byId, byWholeName, leaves, stale };
}

function cachePath(): string {
  return path.join(env.cacheRoot, "naver-categories.json");
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (!Array.isArray(parsed?.categories) || parsed.categories.length < MIN_VALID_NODES) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(file: CacheFile): Promise<void> {
  await mkdir(env.cacheRoot, { recursive: true });
  const target = cachePath();
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(file)}\n`, "utf8");
  await rename(temp, target);
}

async function syncTree(): Promise<CategoryTree> {
  const cached = await readCache();
  const fresh = cached && Date.now() - Date.parse(cached.syncedAt) < CACHE_TTL_MS;
  if (cached && fresh) {
    return buildTree(cached.categories, cached.syncedAt, false);
  }

  try {
    const categories = await fetchAllCategories();
    // 부분 응답으로 캐시를 오염시키지 않는다.
    if (categories.length < MIN_VALID_NODES) {
      throw new Error(`카테고리 동기화 결과가 비정상입니다 (${categories.length}건).`);
    }
    const syncedAt = new Date().toISOString();
    await writeCache({ syncedAt, categories }).catch((error: unknown) => {
      console.warn("[categories] 캐시 기록 실패:", error instanceof Error ? error.message : error);
    });
    return buildTree(categories, syncedAt, false);
  } catch (error) {
    if (cached) {
      // 낡은 캐시를 경고와 함께 계속 쓴다 — leaf 유효성은 프리플라이트가 재확인한다.
      console.warn(
        `[categories] 동기화 실패 — 낡은 캐시(${cached.syncedAt})로 진행합니다:`,
        error instanceof Error ? error.message : error,
      );
      return buildTree(cached.categories, cached.syncedAt, true);
    }
    throw error;
  }
}

export async function getCategoryTree(): Promise<CategoryTree> {
  if (memoryTree && Date.now() - Date.parse(memoryTree.syncedAt) < CACHE_TTL_MS && !memoryTree.stale) {
    return memoryTree;
  }
  if (inFlight) return inFlight;
  inFlight = syncTree()
    .then((tree) => {
      memoryTree = tree;
      return tree;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function resetCategoryTreeForTests(): void {
  memoryTree = null;
  inFlight = null;
}

export interface LeafResolution {
  category: NaverCategory;
  matchKind: "exact_path" | "suffix" | "leaf_name";
}

/**
 * 전시 경로 → 판매 leaf 해석. 3단 하강.
 * 2건 이상 걸리면 채택하지 않는다 — 모호한 매핑이 잘못된 카테고리보다 낫다.
 */
export function resolveLeafFromDisplayPath(
  tree: CategoryTree,
  pathNames: string[],
): LeafResolution | null {
  const cleaned = pathNames.map((part) => part.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;

  // 1) exact_path
  const exact = tree.byWholeName.get(normalizePath(cleaned.join(">")));
  if (exact?.last) return { category: exact, matchKind: "exact_path" };

  // 2) suffix — 깊은 쪽 3→2 세그먼트 접미 일치가 정확히 1건일 때
  for (const depth of [3, 2]) {
    if (cleaned.length < depth) continue;
    const suffix = normalizePath(cleaned.slice(-depth).join(">"));
    const matches = tree.leaves.filter((leaf) =>
      normalizePath(leaf.wholeCategoryName ?? "").endsWith(suffix),
    );
    if (matches.length === 1) return { category: matches[0], matchKind: "suffix" };
  }

  // 3) leaf_name — leaf 이름만 일치가 정확히 1건일 때
  const leafName = cleaned[cleaned.length - 1].trim().toLocaleLowerCase("ko-KR");
  const nameMatches = tree.leaves.filter(
    (leaf) => leaf.name.trim().toLocaleLowerCase("ko-KR") === leafName,
  );
  if (nameMatches.length === 1) return { category: nameMatches[0], matchKind: "leaf_name" };

  return null;
}

/** 어휘 검색 — 카탈로그 소스 불가 시 폴백. */
export function searchLeaves(tree: CategoryTree, query: string, limit = 30): NaverCategory[] {
  const tokens = query
    .split(/[\s/><,]+/)
    .map((token) => token.trim().toLocaleLowerCase("ko-KR"))
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];

  const scored: Array<{ category: NaverCategory; score: number }> = [];
  for (const leaf of tree.leaves) {
    const name = leaf.name.toLocaleLowerCase("ko-KR");
    const whole = (leaf.wholeCategoryName ?? "").toLocaleLowerCase("ko-KR");
    let score = 0;
    for (const token of tokens) {
      if (name.includes(token)) score += 3;
      else if (whole.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ category: leaf, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.category);
}
