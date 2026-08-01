import {
  createProduct,
  fetchSellerChannels,
  searchProductsBySellerCode,
} from "../commerce/client.js";
import { CommerceApiError, CommerceTransportError } from "../commerce/errors.js";
import { sleep } from "../commerce/http.js";
import { sellerManagementCodeForListing } from "./payload.js";

export interface RegisterOutcome {
  mode: "live" | "dry-run";
  status: "registered" | "ambiguous" | "failed";
  originProductNo: string | null;
  channelProductNo: string | null;
  productUrl: string | null;
  registeredAt: string | null;
  message: string;
}

/** ⚠ 이 락은 "동시에 겹치는" 호출만 막는다 — 시간차 재실행은 라우트 레벨 방어가 필요하다. */
const activeRegistrations = new Set<string>();

/** ⚠ 조회 실패는 캐시하지 않는다 — 일시 장애가 이후 모든 등록의 상품 URL 을 영구히 지우는 것을 막는다. */
let storeUrlCache: string | null = null;

async function resolveStoreUrl(): Promise<string | null> {
  if (storeUrlCache) return storeUrlCache;
  try {
    const channels = await fetchSellerChannels();
    const storefront = channels.find((channel) => channel.channelType === "STOREFARM");
    if (storefront?.url) {
      storeUrlCache = storefront.url;
      return storeUrlCache;
    }
  } catch (error) {
    console.warn("[register] 판매자 채널 조회 실패:", error instanceof Error ? error.message : error);
  }
  return null;
}

async function buildProductUrl(channelProductNo: string | null): Promise<string | null> {
  if (!channelProductNo) return null;
  const storeUrl = await resolveStoreUrl();
  if (!storeUrl) return null;
  return `${storeUrl.replace(/\/$/, "")}/products/${channelProductNo}`;
}

export interface RegisterInput {
  listingId: string;
  payload: unknown;
  mode: "live" | "dry-run";
}

const DRY_RUN_MESSAGE = "등록안은 전체 검증을 통과했지만 스토어 전송까지는 가지 못했습니다.";

/* ── 400 자가수리 ─────────────────────────────────────────────
   400 BAD_REQUEST 는 "확실히 등록되지 않음"이다 — 수리 후 재전송해도 중복 위험이 0 이다.
   (중복 위험이 있는 전송 계층 모호(may-have-been-sent)와는 완전히 다른 부류.)
   네이버가 지목한 invalidInputs 를 읽어 그 칸만 고치거나 걷어내고 다시 보낸다.
   마지막 시도는 선택 블록을 전부 걷은 최소 페이로드다 — 완벽한 등록안보다 등록 자체가 먼저다. */

const MAX_REPAIR_ATTEMPTS = 3;

/** detailAttribute 아래에서 "없어도 등록이 성립하는" 블록들. */
const OPTIONAL_DETAIL_BLOCKS = new Set([
  "productAttributes",
  "seoInfo",
  "naverShoppingSearchInfo",
  "productCertificationInfos",
  "certificationTargetExcludeContent",
  "purchaseQuantityInfo",
  "customsTaxType",
]);

interface RepairResult {
  payload: Record<string, unknown>;
  notes: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function detailAttributeOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  const origin = asObject(payload.originProduct);
  return origin ? asObject(origin.detailAttribute) : null;
}

function parseInvalidInputNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { invalidInputs?: Array<{ name?: unknown }> };
    if (!Array.isArray(parsed.invalidInputs)) return [];
    return parsed.invalidInputs
      .map((entry) => (typeof entry.name === "string" ? entry.name : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** "a.b[2].c" → 토큰 배열. 배열 인덱스는 숫자로 푼다. */
function pathTokens(name: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  for (const part of name.split(".")) {
    const match = part.match(/^([^[\]]+)((\[\d+\])*)$/);
    if (!match) {
      tokens.push(part);
      continue;
    }
    tokens.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) tokens.push(Number(index[1]));
  }
  return tokens;
}

/**
 * 경로가 가리키는 값을 일반 규칙으로 고친다:
 * 배열 원소면 그 원소를 제거, 문자열이면 안전 문구로 교체, 그 외에는 리프를 삭제.
 */
function genericFixAtPath(payload: Record<string, unknown>, name: string): boolean {
  const tokens = pathTokens(name);
  if (tokens.length === 0) return false;
  let parent: unknown = payload;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = tokens[index];
    if (Array.isArray(parent) && typeof key === "number") parent = parent[key];
    else if (asObject(parent) && typeof key === "string") parent = (parent as Record<string, unknown>)[key];
    else return false;
    if (parent == null) return false;
  }
  const leaf = tokens[tokens.length - 1];
  if (Array.isArray(parent) && typeof leaf === "number") {
    parent.splice(leaf, 1);
    return true;
  }
  const record = asObject(parent);
  if (!record || typeof leaf !== "string") return false;
  if (typeof record[leaf] === "string") {
    record[leaf] = "상세페이지 참조";
    return true;
  }
  delete record[leaf];
  return true;
}

function sanitizeProductName(raw: unknown): string {
  const base = typeof raw === "string" ? raw : "";
  const cleaned = base
    .replace(/[^0-9a-zA-Z가-힣 ()\-\/&+.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  return cleaned || "판매 상품";
}

function stripOptionalBlocks(payload: Record<string, unknown>, notes: string[]): void {
  const detail = detailAttributeOf(payload);
  if (!detail) return;
  for (const key of OPTIONAL_DETAIL_BLOCKS) {
    if (key in detail) {
      delete detail[key];
      notes.push(`${key} 제거`);
    }
  }
  const origin = asObject(payload.originProduct);
  const images = origin ? asObject(origin.images) : null;
  if (images && "optionalImages" in images) {
    delete images.optionalImages;
    notes.push("optionalImages 제거");
  }
}

export function repairPayloadAfter400(
  payload: unknown,
  errorBody: string,
  attempt: number,
): RepairResult | null {
  const base = asObject(payload);
  if (!base) return null;
  const clone = structuredClone(base);
  const notes: string[] = [];
  const origin = asObject(clone.originProduct);
  const detail = detailAttributeOf(clone);

  // 마지막 시도 — 지목과 무관하게 최소 페이로드로 간다.
  if (attempt >= MAX_REPAIR_ATTEMPTS - 1) {
    stripOptionalBlocks(clone, notes);
    if (detail) {
      const service = asObject(detail.afterServiceInfo);
      if (service) service.afterServiceTelephoneNumber = "010-0000-0000";
    }
    if (origin) origin.name = sanitizeProductName(origin.name);
    notes.push("최소 페이로드");
    return { payload: clone, notes };
  }

  const names = parseInvalidInputNames(errorBody);
  if (names.length === 0) {
    stripOptionalBlocks(clone, notes);
    return notes.length > 0 ? { payload: clone, notes } : null;
  }

  let fixedAny = false;
  for (const name of names) {
    if (name.includes("afterServiceTelephoneNumber")) {
      const service = detail ? asObject(detail.afterServiceInfo) : null;
      if (service) {
        service.afterServiceTelephoneNumber = "010-0000-0000";
        notes.push("A/S 번호 교체");
        fixedAny = true;
        continue;
      }
    }
    if (name.includes("originArea")) {
      if (detail) {
        detail.originAreaInfo = { originAreaCode: "00", content: "국산" };
        notes.push("원산지 기본값");
        fixedAny = true;
        continue;
      }
    }
    if (name.endsWith("originProduct.name") || name === "originProduct.name") {
      if (origin) {
        origin.name = sanitizeProductName(origin.name);
        notes.push("상품명 정제");
        fixedAny = true;
        continue;
      }
    }
    if (name.includes("salePrice")) {
      if (origin && typeof origin.salePrice === "number") {
        origin.salePrice = Math.max(1000, Math.round(origin.salePrice / 100) * 100);
        notes.push("판매가 보정");
        fixedAny = true;
        continue;
      }
    }
    // detailAttribute 바로 아래의 선택 블록이면 통째로 걷는다.
    const blockMatch = name.match(/detailAttribute\.([A-Za-z]+)/);
    if (blockMatch && OPTIONAL_DETAIL_BLOCKS.has(blockMatch[1]) && detail) {
      delete detail[blockMatch[1]];
      notes.push(`${blockMatch[1]} 제거`);
      fixedAny = true;
      continue;
    }
    if (genericFixAtPath(clone, name)) {
      notes.push(`${name} 일반 수리`);
      fixedAny = true;
    }
  }

  return fixedAny ? { payload: clone, notes } : null;
}

export async function registerProduct(input: RegisterInput): Promise<RegisterOutcome> {
  if (input.mode !== "live") {
    return {
      mode: "dry-run",
      status: "registered",
      originProductNo: null,
      channelProductNo: null,
      productUrl: null,
      registeredAt: null,
      message: DRY_RUN_MESSAGE,
    };
  }

  if (activeRegistrations.has(input.listingId)) {
    return {
      mode: "live",
      status: "failed",
      originProductNo: null,
      channelProductNo: null,
      productUrl: null,
      registeredAt: null,
      message: "같은 리스팅의 등록이 이미 진행 중입니다 — 중복 등록을 막기 위해 중단했습니다.",
    };
  }
  activeRegistrations.add(input.listingId);

  try {
    let response;
    let payload = input.payload;
    let repairAttempt = 0;

    for (;;) {
      try {
        // ⚠ 모호(전송됐을 수도 있는) 오류에는 재시도하지 않는다.
        //   400 확정 거절만 수리 후 재전송한다 — 중복 위험이 없는 유일한 재시도다.
        response = await createProduct(payload);
        break;
      } catch (error) {
        // 전송 계층 오류이면서 전송됐을 수 있으면 재조회로 모호를 해소한다.
        if (error instanceof CommerceTransportError && error.requestMayHaveBeenSent) {
          const resolved = await resolveAmbiguous(input.listingId);
          if (resolved) return resolved;
          return {
            mode: "live",
            status: "ambiguous",
            originProductNo: null,
            channelProductNo: null,
            productUrl: null,
            registeredAt: null,
            message:
              "등록 요청이 전송됐는지 확인하지 못했습니다. 자동 재전송은 중복 등록 위험이 있어 하지 않습니다. 스마트스토어 센터에서 판매자상품코드로 확인해 주세요.",
          };
        }
        if (error instanceof CommerceApiError) {
          if (error.status === 400 && repairAttempt < MAX_REPAIR_ATTEMPTS) {
            const repaired = repairPayloadAfter400(payload, error.body, repairAttempt);
            if (repaired) {
              console.warn(
                `[register] 400 자가수리 ${repairAttempt + 1}차: ${repaired.notes.join(" · ")}`,
              );
              payload = repaired.payload;
              repairAttempt += 1;
              continue;
            }
          }
          return {
            mode: "live",
            status: "failed",
            originProductNo: null,
            channelProductNo: null,
            productUrl: null,
            registeredAt: null,
            message: `네이버가 등록을 거부했습니다 — ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.body.slice(0, 400)}`,
          };
        }
        return {
          mode: "live",
          status: "failed",
          originProductNo: null,
          channelProductNo: null,
          productUrl: null,
          registeredAt: null,
          message: `등록 실행에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const originProductNo = response.originProductNo != null ? String(response.originProductNo) : null;
    const channelProductNo =
      response.smartstoreChannelProductNo != null ? String(response.smartstoreChannelProductNo) : null;

    return {
      mode: "live",
      status: "registered",
      originProductNo,
      channelProductNo,
      productUrl: await buildProductUrl(channelProductNo),
      registeredAt: new Date().toISOString(),
      message: "스마트스토어에 등록됐습니다.",
    };
  } finally {
    activeRegistrations.delete(input.listingId);
  }
}

/** 네이버 색인 지연을 감안한 재조회. */
async function resolveAmbiguous(listingId: string): Promise<RegisterOutcome | null> {
  const sellerCode = sellerManagementCodeForListing(listingId);
  const delays = [3_000, 7_000, 15_000];
  for (const delay of delays) {
    await sleep(delay);
    try {
      const matches = await searchProductsBySellerCode(sellerCode);
      if (matches.length > 0) {
        const first = matches[0];
        const channel = first.channelProducts?.[0];
        const channelProductNo = channel?.channelProductNo != null ? String(channel.channelProductNo) : null;
        return {
          mode: "live",
          status: "registered",
          originProductNo: first.originProductNo != null ? String(first.originProductNo) : null,
          channelProductNo,
          productUrl: await buildProductUrl(channelProductNo),
          registeredAt: new Date().toISOString(),
          message: "전송 응답을 받지 못했지만 재조회로 실제 등록을 확인했습니다.",
        };
      }
    } catch (error) {
      console.warn("[register] 모호 해소 재조회 실패:", error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export function resetStoreUrlCacheForTests(): void {
  storeUrlCache = null;
}
