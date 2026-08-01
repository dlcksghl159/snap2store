import { getAccessToken } from "./auth.js";
import { CommerceApiError, CommerceTransportError } from "./errors.js";
import {
  DEFAULT_JSON_TIMEOUT_MS,
  commerceFetch,
  createSerialThrottle,
  isTransientStatus,
  retryTransient,
} from "./http.js";
import { hasCommerceCredentials } from "../env.js";

const BASE_URL = "https://api.commerce.naver.com/external";

/* ── 응답 타입 ───────────────────────────────────────────────── */

export interface NaverCategory {
  id: string;
  name: string;
  last: boolean;
  wholeCategoryId?: string;
  wholeCategoryName: string;
}

export interface NaverCategoryDetail {
  id: string;
  exceptionalCategories?: string[];
  certificationInfos?: Array<{
    id: number;
    name: string;
    kindTypes: string[];
    companyName?: boolean;
    certificationDate?: boolean;
    nonEssential?: boolean;
  }>;
}

export interface NaverNoticeTypeInfo {
  productInfoProvidedNoticeType: string;
  productInfoProvidedNoticeTypeName?: string;
  productInfoProvidedNoticeContents?: Array<{ fieldName: string; required?: boolean | string }> | null;
}

export interface NaverProductAttribute {
  attributeSeq: number;
  attributeName?: string;
  attributeClassificationType?: "SINGLE_SELECT" | "MULTI_SELECT" | "RANGE";
  attributeType?: "PRIMARY" | "OPTIONAL";
  unitUsable?: boolean;
  representativeUnitCode?: string;
  attributeValueMaxMatchingCount?: number;
}

export interface NaverProductAttributeValue {
  attributeSeq: number;
  attributeValueSeq: number;
  attributeValueName?: string;
  valueName?: string;
  minAttributeValue?: string;
  maxAttributeValue?: string;
}

export interface CatalogModel {
  id?: number;
  name?: string;
  wholeCategoryName?: string;
  categoryId?: string;
  brandName?: string;
  manufacturerName?: string;
}

export interface SellerChannel {
  channelNo?: number;
  channelType?: string;
  name?: string;
  url?: string;
}

export interface ProductSearchResult {
  originProductNo?: number | string;
  channelProducts?: Array<{
    channelProductNo?: number | string;
    name?: string;
    sellerManagementCode?: string;
    statusType?: string;
  }>;
}

/* ── 요청 래퍼 ───────────────────────────────────────────────── */

interface RequestOptions {
  timeoutMs?: number;
  retry?: boolean;
  query?: Record<string, string | number | undefined | Array<string | number>>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_JSON_TIMEOUT_MS, retry = false, query } = options;
  const url = buildUrl(path, query);

  const execute = async (): Promise<T> => {
    const token = await getAccessToken();
    let response;
    try {
      response = await commerceFetch(url, {
        method,
        timeoutMs,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // 응답을 못 받았다. GET 이 아니면 전송됐을 수 있다.
      throw new CommerceTransportError(method, path, error, method !== "GET");
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!response.ok) {
      throw new CommerceApiError(response.status, method, path, text);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  };

  if (!retry) return execute();
  return retryTransient(execute, {
    attempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 2000,
    shouldRetry: (error) =>
      (error instanceof CommerceApiError && isTransientStatus(error.status)) ||
      (error instanceof CommerceTransportError && !error.requestMayHaveBeenSent),
  });
}

function assertCredentials(): void {
  if (!hasCommerceCredentials()) {
    throw new Error("커머스 API 자격증명이 없습니다.");
  }
}

/* ── 엔드포인트 ──────────────────────────────────────────────── */

/** 카테고리 전체. 1.5만 대 노드이므로 타임아웃을 넉넉히 준다. */
export async function fetchAllCategories(): Promise<NaverCategory[]> {
  assertCredentials();
  const data = await request<NaverCategory[]>("GET", "/v1/categories", undefined, {
    retry: true,
    timeoutMs: 60_000,
  });
  return Array.isArray(data) ? data : [];
}

export async function fetchCategoryDetail(categoryId: string): Promise<NaverCategoryDetail | null> {
  assertCredentials();
  try {
    return await request<NaverCategoryDetail>("GET", `/v1/categories/${encodeURIComponent(categoryId)}`, undefined, {
      retry: true,
    });
  } catch (error) {
    console.warn(`[commerce] 카테고리 상세 조회 실패 (${categoryId}):`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function fetchNoticeTypes(categoryId?: string): Promise<NaverNoticeTypeInfo[]> {
  assertCredentials();
  const data = await request<NaverNoticeTypeInfo[]>(
    "GET",
    "/v1/products-for-provided-notice",
    undefined,
    { retry: true, query: categoryId ? { categoryId } : undefined },
  );
  return Array.isArray(data) ? data : [];
}

export interface OriginAreaCodeName {
  code: string;
  name: string;
}

/** 응답 키가 흔들리므로 관대하게 파싱한다. */
export async function searchOriginAreas(name: string): Promise<OriginAreaCodeName[]> {
  assertCredentials();
  const data = await request<unknown>("GET", "/v1/product-origin-areas/query", undefined, {
    retry: true,
    query: { name },
  });

  const container = (() => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      for (const key of ["originAreaCodeNames", "originAreas", "contents"]) {
        if (Array.isArray(record[key])) return record[key] as unknown[];
      }
    }
    return [];
  })();

  const results: OriginAreaCodeName[] = [];
  for (const item of container) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const code = ["originAreaCode", "code", "id"]
      .map((key) => record[key])
      .find((value) => typeof value === "string" || typeof value === "number");
    const label = ["originAreaName", "name", "originArea"]
      .map((key) => record[key])
      .find((value) => typeof value === "string");
    if (code == null) continue;
    results.push({ code: String(code), name: typeof label === "string" ? label : "" });
  }
  return results;
}

export async function fetchProductAttributes(categoryId: string): Promise<NaverProductAttribute[]> {
  assertCredentials();
  const data = await request<NaverProductAttribute[]>("GET", "/v1/product-attributes/attributes", undefined, {
    retry: true,
    query: { categoryId },
  });
  return Array.isArray(data) ? data : [];
}

export async function fetchProductAttributeValues(
  categoryId: string,
): Promise<NaverProductAttributeValue[]> {
  assertCredentials();
  const data = await request<NaverProductAttributeValue[]>(
    "GET",
    "/v1/product-attributes/attribute-values",
    undefined,
    { retry: true, query: { categoryId } },
  );
  return Array.isArray(data) ? data : [];
}

export interface RecommendTag {
  code?: string;
  text: string;
}

export async function fetchRecommendTags(keyword: string): Promise<RecommendTag[]> {
  assertCredentials();
  const data = await request<RecommendTag[]>("GET", "/v2/tags/recommend-tags", undefined, {
    retry: true,
    query: { keyword },
  });
  return Array.isArray(data) ? data : [];
}

export async function fetchRestrictedTags(tags: string[]): Promise<Array<{ tag: string; restricted: boolean }>> {
  assertCredentials();
  if (tags.length === 0) return [];
  const data = await request<Array<{ tag: string; restricted: boolean }>>(
    "GET",
    "/v2/tags/restricted-tags",
    undefined,
    { retry: true, query: { tags } },
  );
  return Array.isArray(data) ? data : [];
}

/** 호출 간 최소 150ms 간격의 직렬 스로틀. */
const catalogThrottle = createSerialThrottle(150);

export async function searchCatalogModels(name: string, size = 30): Promise<CatalogModel[]> {
  assertCredentials();
  const bounded = Math.max(1, Math.min(100, size));
  return catalogThrottle(async () => {
    const data = await request<{ contents?: CatalogModel[] }>("GET", "/v1/product-models", undefined, {
      retry: true,
      query: { name, page: 1, size: bounded },
    });
    return Array.isArray(data?.contents) ? data.contents : [];
  });
}

export async function uploadProductImages(
  form: unknown,
  timeoutMs: number,
): Promise<{ images?: Array<{ url?: string }> }> {
  assertCredentials();
  const token = await getAccessToken();
  let response;
  try {
    response = await commerceFetch(`${BASE_URL}/v1/product-images/upload`, {
      method: "POST",
      timeoutMs,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      // ⚠ FormData 는 반드시 npm undici 것이어야 한다 (images.ts 에서 만든다).
      body: form as never,
    });
  } catch (error) {
    throw new CommerceTransportError("POST", "/v1/product-images/upload", error, true);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CommerceApiError(response.status, "POST", "/v1/product-images/upload", text);
  }
  return text ? (JSON.parse(text) as { images?: Array<{ url?: string }> }) : {};
}

/**
 * 상품 등록. ⚠ 재시도 경로가 존재하지 않는다.
 * 응답을 못 받은 POST 는 이미 등록됐을 수 있고, 재전송은 중복 상품을 만든다.
 */
export async function createProduct(payload: unknown): Promise<{
  originProductNo?: number | string;
  smartstoreChannelProductNo?: number | string;
}> {
  assertCredentials();
  return request("POST", "/v2/products", payload, { retry: false, timeoutMs: 60_000 });
}

/** 등록 POST 의 모호 실패를 해소하는 유일한 수단. */
export async function searchProductsBySellerCode(
  sellerManagementCode: string,
): Promise<ProductSearchResult[]> {
  assertCredentials();
  const data = await request<{ contents?: ProductSearchResult[] }>(
    "POST",
    "/v1/products/search",
    {
      searchKeywordType: "SELLER_CODE",
      sellerManagementCode,
      productStatusTypes: ["SALE", "OUTOFSTOCK", "SUSPENSION", "WAIT"],
      page: 1,
      size: 50,
    },
    { retry: true },
  );
  return Array.isArray(data?.contents) ? data.contents : [];
}

/** ⚠ 조회 실패를 캐시하지 않는다 — 일시 장애가 이후 모든 상품 URL 을 영구히 지우는 것을 막는다. */
export async function fetchSellerChannels(): Promise<SellerChannel[]> {
  assertCredentials();
  const data = await request<SellerChannel[]>("GET", "/v1/seller/channels", undefined, { retry: true });
  return Array.isArray(data) ? data : [];
}
