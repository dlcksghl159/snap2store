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
    try {
      // ⚠ 재시도 경로가 존재하지 않는다.
      response = await createProduct(input.payload);
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
