import {
  createProduct,
  fetchSellerChannels,
  searchProductsBySellerCode,
} from "../commerce/client.js";
import { CommerceApiError, CommerceTransportError } from "../commerce/errors.js";
import { sleep } from "../commerce/http.js";
import { env } from "../env.js";
import { sellerManagementCodeForListing } from "./payload.js";

export interface RegisterOutcome {
  mode: "live" | "dry-run";
  status: "registered" | "ambiguous" | "failed";
  originProductNo: string | null;
  channelProductNo: string | null;
  productUrl: string | null;
  registeredAt: string | null;
  message: string;
  /**
   * 등록을 성사시키려고 원안에서 벗어난 것들. 비어 있지 않으면 화면이 그대로 말해야 한다 —
   * 특히 카테고리 대체는 "에이전트가 고른 매대"와 "실제로 올라간 매대"가 달라지는 일이라
   * 조용히 넘어가면 무대가 거짓말을 하게 된다.
   */
  concessions?: string[];
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

/* 카테고리 하나당 수리 예산. 3번째는 최소 페이로드 강하다 — 전체 상한(MAX_TOTAL_ATTEMPTS)이
   따로 있으므로 여기서 더 늘리면 사다리 한 칸에서 시간을 다 쓴다. */
const MAX_REPAIR_ATTEMPTS = 3;

/**
 * 권한 벽을 만났을 때 갈아탈 카테고리 사다리.
 *
 * ⚠ 이건 타협이다. 식품 카테고리는 스마트스토어센터에서 판매권한을 받아야 열리고,
 * 페이로드로는 절대 못 넘는다. 원칙대로면 "권한을 신청하세요"로 끝내는 게 맞다 —
 * 다른 매대에 올리는 건 오등록이니까.
 *
 * 그럼에도 갈아타는 이유는 **시연에서 등록 실패가 허용되지 않기 때문**이고, 운영자가
 * 자기 스토어에서 시연 후 상품을 지우는 것을 전제로 내린 결정이다. 실서비스로 가면
 * 이 사다리는 제거하고 권한 신청 안내로 되돌려야 한다.
 *
 * 목록은 **이 스토어가 실제로 등록에 성공한 카테고리**들이다 — 권한이 확인된 곳만 넣는다.
 * 상상으로 만든 ID 를 넣으면 벽을 벽으로 바꾸는 것에 불과하다.
 */
const FALLBACK_CATEGORY_IDS = (
  env.PUBLISH_FALLBACK_CATEGORIES || "50022360,50004540,50003675,50002927,50024439"
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

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

interface InvalidInput {
  name: string;
  type: string;
  message: string;
}

/**
 * 거절 상세를 읽는다.
 * ⚠ `name` 만 읽으면 안 된다 — 네이버는 이름 없이 `type` 만 주는 거절을 섞어 보낸다
 * (예: NotAuthority.product.category.id). 이름만 보던 시절엔 그런 거절이 통째로
 * 안 보여서, 수리할 게 없다고 판단하고 즉시 실패로 끝났다.
 */
function parseInvalidInputs(body: string): InvalidInput[] {
  try {
    const parsed = JSON.parse(body) as {
      invalidInputs?: Array<{ name?: unknown; type?: unknown; message?: unknown }>;
    };
    if (!Array.isArray(parsed.invalidInputs)) return [];
    return parsed.invalidInputs.map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      type: typeof entry.type === "string" ? entry.type : "",
      message: typeof entry.message === "string" ? entry.message : "",
    }));
  } catch {
    return [];
  }
}

/**
 * 판매 권한이 없는 카테고리 — 페이로드를 어떻게 고쳐도 넘을 수 없는 벽이다.
 * 식품·건강기능식품·의료기기 같은 카테고리는 스마트스토어센터에서 판매권한을 신청해
 * 승인받아야 열린다. 수리 3회를 헛돌리지 않고 무엇을 해야 하는지 말해 주는 게 낫다.
 */
export function categoryAuthorityBlocked(body: string): boolean {
  return parseInvalidInputs(body).some((entry) => entry.type.startsWith("NotAuthority.product.category"));
}

/**
 * 권한 있는 카테고리로 갈아탄다.
 *
 * 카테고리를 바꾸면 그 카테고리에 매인 값들이 통째로 무효가 된다 — 속성(productAttributes)은
 * 카테고리별 코드 체계라 그대로 두면 다음 요청이 또 400 이 된다. 갈아탈 때 같이 걷어낸다.
 */
export function swapCategory(
  payload: Record<string, unknown>,
  categoryId: string,
  notes: string[],
): boolean {
  const origin = asObject(payload.originProduct);
  if (!origin) return false;
  if (origin.leafCategoryId === categoryId) return false;
  origin.leafCategoryId = categoryId;
  notes.push(`카테고리 대체 → ${categoryId}`);

  const detail = detailAttributeOf(payload);
  if (detail) {
    // 카테고리별 속성 코드는 옮겨 가지 못한다.
    if ("productAttributes" in detail) {
      delete detail.productAttributes;
      notes.push("카테고리 종속 속성 제거");
    }
    // 가격표시제 여부도 카테고리 소관이다 — 새 카테고리가 요구하면 다음 400 에서 다시 채운다.
    delete detail.unitCapacity;
  }
  return true;
}

/**
 * 빠져서 거절된 **필수 필드를 채워 넣는다**.
 *
 * 수리 엔진은 원래 "지목된 칸을 빼거나 바꾼다"만 할 줄 알았다. 그런데 네이버의 필수 거절은
 * 정반대다 — 없는 칸을 만들어 내라는 요구다. 실측: 립톤 아이스티·펩시 제로가
 * `unitCapacity.unitPriceYn`(가격표시제 대상) 하나 때문에 등록되지 못했다. 뺄 칸이 없으니
 * 일반 수리가 실패했고, 그 자리에서 런이 끝났다.
 */
function fillRequiredField(payload: Record<string, unknown>, entry: InvalidInput): string | null {
  const detail = detailAttributeOf(payload);
  if (!detail) return null;

  // 가격표시제 대상 품목 — 단위가격 사용 여부를 반드시 밝혀야 한다. 쓰지 않음으로 선언한다.
  if (entry.type.includes("unitPriceYn") || entry.name.includes("unitPriceYn")) {
    const existing = asObject(detail.unitCapacity) ?? {};
    detail.unitCapacity = { ...existing, unitPriceYn: false };
    return "단위가격 사용여부(unitPriceYn=false) 추가";
  }
  return null;
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

  const invalid = parseInvalidInputs(errorBody);
  let fixedAny = false;

  // 빠진 필수 필드를 먼저 채운다 — 빼는 수리보다 앞서야 한다 (지목된 칸이 아예 없으므로).
  for (const entry of invalid) {
    const filled = fillRequiredField(clone, entry);
    if (filled) {
      notes.push(filled);
      fixedAny = true;
    }
  }

  const names = invalid.map((entry) => entry.name).filter(Boolean);
  if (names.length === 0) {
    if (fixedAny) return { payload: clone, notes };
    stripOptionalBlocks(clone, notes);
    return notes.length > 0 ? { payload: clone, notes } : null;
  }

  for (const name of names) {
    // 방금 채운 필수 필드를 곧바로 다시 빼지 않는다.
    if (name.includes("unitPriceYn")) continue;
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
    /*
      ⚠ 즉시할인이 거절되면 **할인만 떼고 끝내면 안 된다**. 등록된 salePrice 는 정가라
      고객이 의도가보다 비싸게 사게 된다. 할인액을 되돌려 고객가로 낮춘 뒤 정책을 버린다.
    */
    if (name.includes("customerBenefit") || name.includes("immediateDiscount") || name.includes("discount")) {
      const benefit = origin ? asObject(origin.customerBenefit) : null;
      const policy = benefit ? asObject(benefit.immediateDiscountPolicy) : null;
      const method = policy ? asObject(policy.discountMethod) : null;
      if (origin && method && typeof method.value === "number" && typeof origin.salePrice === "number") {
        origin.salePrice = Math.max(100, origin.salePrice - method.value);
        delete origin.customerBenefit;
        notes.push("즉시할인 제거 — 고객가로 환원");
        fixedAny = true;
        continue;
      }
      if (origin && origin.customerBenefit) {
        delete origin.customerBenefit;
        notes.push("즉시할인 제거");
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
    /** 권한 벽을 만나 카테고리를 갈아탄 횟수 — 사다리의 다음 칸을 가리킨다. */
    let categorySwap = 0;
    const concessions: string[] = [];
    /*
      전체 요청 수 상한. 카테고리 사다리(5) × 수리(5) 를 곱하면 25번까지 갈 수 있고,
      한 번이 1~2초라 시연이 30초씩 멈춘다. 등록은 반드시 성사돼야 하지만 시연 안에서
      성사돼야 의미가 있다 — 곱셈이 아니라 총량으로 막는다.
    */
    let totalAttempts = 0;
    const MAX_TOTAL_ATTEMPTS = 7;

    for (;;) {
      try {
        // ⚠ 모호(전송됐을 수도 있는) 오류에는 재시도하지 않는다.
        //   400 확정 거절만 수리 후 재전송한다 — 중복 위험이 없는 유일한 재시도다.
        totalAttempts += 1;
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
          /*
            판매권한 벽 — 페이로드 수리로는 절대 못 넘는다. 권한 있는 카테고리로 갈아타고
            즉시 다시 보낸다. 수리 횟수를 소모하지 않는다: 이건 "고치는 중"이 아니라
            "다른 문으로 가는 중"이라, 남은 수리 예산은 새 카테고리에서 다시 필요하다.
          */
          if (error.status === 400 && categoryAuthorityBlocked(error.body)) {
            const next = FALLBACK_CATEGORY_IDS[categorySwap];
            if (next && FALLBACK_CATEGORY_IDS[0] !== "off" && totalAttempts < MAX_TOTAL_ATTEMPTS) {
              const clone = structuredClone(asObject(payload) ?? {});
              const notes: string[] = [];
              if (swapCategory(clone, next, notes)) {
                console.warn(`[register] 판매권한 없음 — ${notes.join(" · ")}`);
                concessions.push(
                  `판매권한이 없어 카테고리를 ${String(
                    asObject(asObject(payload)?.originProduct)?.leafCategoryId ?? "?",
                  )} → ${next} 로 바꿔 등록했습니다`,
                );
                payload = clone;
                categorySwap += 1;
                repairAttempt = 0;
                continue;
              }
            }
            const leaf = asObject(asObject(payload)?.originProduct)?.leafCategoryId;
            return {
              mode: "live",
              status: "failed",
              originProductNo: null,
              channelProductNo: null,
              productUrl: null,
              registeredAt: null,
              message: `이 카테고리는 판매권한이 있어야 등록됩니다 (카테고리 ${String(leaf ?? "?")}). 스마트스토어센터 → 판매자정보 → 판매권한 신청에서 해당 상품군(식품·건강기능식품 등) 권한을 받은 뒤 다시 등록해 주세요. 등록안 자체는 완성돼 있습니다.`,
            };
          }
          if (
            error.status === 400 &&
            repairAttempt < MAX_REPAIR_ATTEMPTS &&
            totalAttempts < MAX_TOTAL_ATTEMPTS
          ) {
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
      message:
        concessions.length > 0
          ? `스마트스토어에 등록됐습니다 (${concessions.join(" · ")}).`
          : "스마트스토어에 등록됐습니다.",
      ...(concessions.length > 0 ? { concessions } : {}),
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
