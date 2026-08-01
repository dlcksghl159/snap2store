import { searchComparableListings } from "../naver/openapi.js";
// 가격 정책은 프론트와 공유한다 — 무대가 띄우는 정가·할인율이 등록값과 같아야 한다.
export { planDiscount, DEFAULT_DISCOUNT_RATE } from "../../src/domain/pricing.js";
export type { DiscountPlan } from "../../src/domain/pricing.js";
import type { SellerConfig } from "../seller-config.js";
import type { PriceDistribution, PriceResolution, ShoppingSearchItem } from "../../src/domain/types";

/** 반품/교환비 — 등록 페이로드에 필수. 반품과 교환에 같은 값을 쓴다. */
export function calcReturnExchangeFeeKrw(salePrice: number): number {
  const raw = Math.round(salePrice * 0.2);
  return Math.min(200_000, Math.max(20_000, raw));
}

export function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = ratio * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface DistributionResult {
  distribution: PriceDistribution;
  anchorPrice: number;
}

/**
 * IQR 펜스로 이상치를 제거한다. 남은 게 min(3, 원본수) 미만이면 제거를 취소하고 원본을 쓴다.
 */
export function buildDistribution(prices: number[], anchor: "conservative" | "median"): DistributionResult | null {
  const valid = prices.filter((price) => Number.isFinite(price) && price > 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;

  const q1 = percentile(valid, 0.25);
  const q3 = percentile(valid, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;

  let kept = valid.filter((price) => price >= lowFence && price <= highFence);
  let removedOutliers = valid.length - kept.length;
  if (kept.length < Math.min(3, valid.length)) {
    kept = valid;
    removedOutliers = 0;
  }

  const distribution: PriceDistribution = {
    sampleSize: valid.length,
    keptSize: kept.length,
    min: Math.round(kept[0]),
    p25: Math.round(percentile(kept, 0.25)),
    median: Math.round(percentile(kept, 0.5)),
    p75: Math.round(percentile(kept, 0.75)),
    max: Math.round(kept[kept.length - 1]),
    removedOutliers,
  };

  return {
    distribution,
    anchorPrice: anchor === "median" ? distribution.median : distribution.p25,
  };
}

export function applyDisplayUnit(price: number, displayUnit: number, minSalePrice: number): number {
  const unit = Math.max(1, displayUnit);
  const rounded = Math.ceil(price / unit) * unit;
  return Math.max(minSalePrice, rounded);
}


export interface ResolvePriceInput {
  comps: ShoppingSearchItem[];
  searchQuery: string;
  estimatedPriceKrw: number | null;
  config: SellerConfig;
  /** 테스트 주입용. */
  research?: (query: string, size?: number) => Promise<ShoppingSearchItem[]>;
}

export async function resolvePrice(input: ResolvePriceInput): Promise<PriceResolution> {
  const { config } = input;
  let comps = input.comps ?? [];
  let pricedCount = comps.filter((comp) => typeof comp.price === "number" && comp.price! > 0).length;

  // ⚠ comps 는 있는데 전부 무가격이면 재질의해도 무가격이다 → 생략한다.
  if (pricedCount < 5 && (comps.length === 0 || pricedCount > 0) && input.searchQuery.trim()) {
    const research = input.research ?? searchComparableListings;
    try {
      const extra = await research(input.searchQuery, 40);
      comps = [...comps, ...extra];
      pricedCount = comps.filter((comp) => typeof comp.price === "number" && comp.price! > 0).length;
    } catch {
      /* 재질의 실패는 비치명 */
    }
  }

  const prices = comps
    .map((comp) => comp.price)
    .filter((price): price is number => typeof price === "number" && price > 0);

  const built = buildDistribution(prices, config.pricing.anchor);
  if (built) {
    const salePrice = applyDisplayUnit(
      built.anchorPrice,
      config.pricing.displayUnit,
      config.pricing.minSalePrice,
    );
    const { distribution } = built;
    const anchorLabel = config.pricing.anchor === "median" ? "중앙값(p50)" : "보수적 백분위(p25)";
    return {
      resolved: true,
      salePrice,
      priceBasis:
        `시세 표본 ${distribution.sampleSize}건` +
        (distribution.removedOutliers > 0 ? ` (IQR 이상치 ${distribution.removedOutliers}건 제거)` : "") +
        ` · 분포 ${distribution.min.toLocaleString("ko-KR")}~${distribution.max.toLocaleString("ko-KR")}원` +
        ` · ${anchorLabel} 기준 ${config.pricing.displayUnit}원 단위 올림`,
      source: "market_distribution",
      sampleSize: distribution.sampleSize,
      distribution,
    };
  }

  // 분포가 없으면 에이전트 추정으로 간다. 사과조로 쓰지 않는다 —
  // 카탈로그 소스에 가격이 없는 것은 알려진 사실이므로 추정이 정식 경로다.
  if (typeof input.estimatedPriceKrw === "number" && input.estimatedPriceKrw >= 100) {
    const salePrice = applyDisplayUnit(
      input.estimatedPriceKrw,
      config.pricing.displayUnit,
      config.pricing.minSalePrice,
    );
    return {
      resolved: true,
      salePrice,
      priceBasis: `에이전트 추정가 — 사진·상품 정보 근거 (${config.pricing.displayUnit}원 단위 올림)`,
      source: "agent_estimate",
      sampleSize: 0,
      distribution: null,
    };
  }

  return {
    resolved: false,
    salePrice: 0,
    priceBasis: "판매가 근거를 확보하지 못했습니다.",
    source: "agent_estimate",
    sampleSize: 0,
    distribution: null,
  };
}
