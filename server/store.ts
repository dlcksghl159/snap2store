import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";
import type { ListingRecord } from "../src/domain/types";

const storePath = path.join(env.runtimeRoot, "listings.json");

let cache: ListingRecord[] | null = null;
/** 직렬 큐가 필수다 — 병렬 재료 생산이 이벤트를 동시에 append 하므로. */
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<ListingRecord[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as ListingRecord[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  const snapshot = JSON.stringify(cache ?? [], null, 2);
  const tempPath = `${storePath}.tmp`;
  writeQueue = writeQueue.then(async () => {
    await mkdir(path.join(env.runtimeRoot, "assets"), { recursive: true });
    await writeFile(tempPath, `${snapshot}\n`, "utf8");
    await rename(tempPath, storePath); // rename 은 원자적
  });
  await writeQueue;
}

export async function listListings(): Promise<ListingRecord[]> {
  const all = await load();
  return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getListing(id: string): Promise<ListingRecord | null> {
  const all = await load();
  return all.find((listing) => listing.id === id) ?? null;
}

export async function insertListing(listing: ListingRecord): Promise<void> {
  const all = await load();
  all.unshift(listing);
  await persist();
}

export async function updateListing(
  id: string,
  updater: (listing: ListingRecord) => ListingRecord,
): Promise<ListingRecord> {
  const all = await load();
  const index = all.findIndex((listing) => listing.id === id);
  if (index === -1) throw new Error(`리스팅을 찾을 수 없습니다: ${id}`);
  // structuredClone 후 업데이터를 적용한다 — 캐시 객체를 직접 변형하면
  // 이전 스냅샷이 오염된다.
  const next = updater(structuredClone(all[index]));
  next.updatedAt = new Date().toISOString();
  all[index] = next;
  await persist();
  return next;
}

export function listingAssetDirectory(id: string): string {
  return path.join(env.runtimeRoot, "assets", id);
}

export function listingAssetUrl(id: string, filename: string): string {
  return `/runtime/assets/${id}/${filename}`;
}

export async function ensureListingAssetDirectory(id: string): Promise<string> {
  const dir = listingAssetDirectory(id);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** ⚠ 실제 등록 이력을 지운다. 테스트 전용 (RUNTIME_ROOT 격리 필수). */
export async function clearRuntimeForTests(): Promise<void> {
  cache = [];
  await rm(env.runtimeRoot, { recursive: true, force: true });
  await mkdir(path.join(env.runtimeRoot, "assets"), { recursive: true });
  await persist();
}
