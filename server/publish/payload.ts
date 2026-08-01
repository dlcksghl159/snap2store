import { calcReturnExchangeFeeKrw } from "../materials/pricing.js";
import type { SellerConfig } from "../seller-config.js";
import type { SeoInfoPayload } from "../materials/tags.js";
import type { OriginAreaInfo } from "../../src/domain/types";

/**
 * ⚠ `sellerManagementCode` 의 실제 한계는 30자다 (문서에 100자로 적힌 것과 다르다).
 * 초과하면 400 MaxLength.
 *
 * ⚠ 등록 후 모호 해소 재조회와 반드시 같은 변환을 쓴다 —
 *   이 코드가 등록 POST 의 모호 실패를 해소하는 유일한 열쇠다.
 */
export function sellerManagementCodeForListing(listingId: string): string {
  return listingId.replace(/-/g, "").slice(0, 30);
}

export function buildDeliveryFee(delivery: SellerConfig["delivery"]): Record<string, unknown> {
  if (delivery.deliveryFeeType === "PAID") {
    return { deliveryFeeType: "PAID", baseFee: delivery.baseFee > 0 ? delivery.baseFee : 3000 };
  }
  if (delivery.deliveryFeeType === "CONDITIONAL_FREE") {
    return {
      deliveryFeeType: "CONDITIONAL_FREE",
      baseFee: delivery.baseFee > 0 ? delivery.baseFee : 3000,
      freeConditionalAmount: delivery.freeConditionalAmount ?? 50_000,
    };
  }
  return { deliveryFeeType: "FREE" };
}

/**
 * A/S 전화번호 정규화 — 커머스 API 는 숫자·-·+ 외 문자가 하나라도 있으면 등록 전체를
 * 400 으로 거절한다. 걸러낸 결과에 숫자가 7자리 미만이면 설정이 자리표시자였다는 뜻이므로
 * 안전한 기본 번호로 대체한다.
 */
export function sanitizeAsPhoneNumber(raw: string): string {
  const cleaned = raw.replace(/[^0-9+-]/g, "");
  const digits = cleaned.replace(/[^0-9]/g, "");
  return digits.length >= 7 ? cleaned : "010-0000-0000";
}

function clip(value: string | null | undefined, limit: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, limit);
}

/**
 * 시각적 유사만으로 브랜드를 주장하지 않는다는 불변식이
 * 페이로드 레벨에서 강제되는 지점이다.
 */
export function buildShoppingSearchInfo(input: {
  brandVerified: boolean;
  brandName: string | null;
  manufacturerName: string | null;
  modelName: string | null;
}): Record<string, string> | null {
  const brandName = clip(input.brandName, 60);
  const manufacturerName = clip(input.manufacturerName, 80);
  const modelName = clip(input.modelName, 100);

  if (input.brandVerified && brandName) {
    const payload: Record<string, string> = { brandName };
    if (manufacturerName) payload.manufacturerName = manufacturerName;
    if (modelName) payload.modelName = modelName;
    return payload;
  }
  if (manufacturerName || modelName) {
    const payload: Record<string, string> = {};
    if (manufacturerName) payload.manufacturerName = manufacturerName;
    if (modelName) payload.modelName = modelName;
    return payload;
  }
  return null;
}

export interface BuildPayloadInput {
  listingId: string;
  title: string;
  leafCategoryId: string;
  representativeImageUrl: string;
  optionalImageUrls: string[];
  detailContent: string;
  /** 고객이 실제로 내는 값 — 반품비 산정과 화면 표기의 기준. */
  salePrice: number;
  /** 정가. 즉시할인을 걸 때만 salePrice 보다 크다. */
  listPrice?: number;
  /** 즉시할인액(원). */
  discountKrw?: number;
  stockQuantity: number;
  config: SellerConfig;
  notice: Record<string, unknown>;
  originAreaInfo: OriginAreaInfo;
  searchInfo: Record<string, string> | null;
  certificationTargetExcludeContent: Record<string, unknown> | null;
  productCertificationInfos: Array<Record<string, unknown>>;
  productAttributes: Array<Record<string, unknown>>;
  seoInfo: SeoInfoPayload | null;
}

export function buildProductPayload(input: BuildPayloadInput): Record<string, unknown> {
  const { config } = input;
  // 반품·교환비는 고객이 내는 값 기준이다 — 정가로 잡으면 실제보다 비싼 구간이 걸린다.
  const claimFee = calcReturnExchangeFeeKrw(input.salePrice);
  const listPrice = input.listPrice ?? input.salePrice;
  const discountKrw = Math.max(0, Math.round(input.discountKrw ?? 0));
  const optional = input.optionalImageUrls.filter(Boolean);

  const purchaseQuantityInfo =
    config.product.maxPurchaseQuantityPerId > 0 || config.product.maxPurchaseQuantityPerOrder > 0
      ? {
          maxPurchaseQuantityPerId: config.product.maxPurchaseQuantityPerId,
          maxPurchaseQuantityPerOrder: config.product.maxPurchaseQuantityPerOrder,
        }
      : null;

  return {
    originProduct: {
      statusType: "SALE",
      leafCategoryId: input.leafCategoryId,
      name: input.title,
      images: {
        representativeImage: { url: input.representativeImageUrl },
        ...(optional.length > 0
          ? { optionalImages: optional.slice(0, 9).map((url) => ({ url })) }
          : {}),
      },
      detailContent: input.detailContent,
      /*
        즉시할인을 걸면 등록되는 salePrice 는 **정가**이고, 고객가는 할인 차감 후 값이다.
        할인이 없으면 둘이 같다.
      */
      salePrice: discountKrw > 0 ? listPrice : input.salePrice,
      ...(discountKrw > 0
        ? {
            customerBenefit: {
              immediateDiscountPolicy: {
                discountMethod: { value: discountKrw, unitType: "WON" },
              },
            },
          }
        : {}),
      stockQuantity: input.stockQuantity,
      deliveryInfo: {
        deliveryType: "DELIVERY",
        deliveryAttributeType: "NORMAL",
        deliveryCompany: config.delivery.deliveryCompany,
        deliveryFee: buildDeliveryFee(config.delivery),
        claimDeliveryInfo: {
          returnDeliveryFee: claimFee,
          exchangeDeliveryFee: claimFee,
        },
      },
      detailAttribute: {
        productInfoProvidedNotice: input.notice,
        originAreaInfo: {
          originAreaCode: input.originAreaInfo.originAreaCode,
          content: input.originAreaInfo.content,
          ...(input.originAreaInfo.importer ? { importer: input.originAreaInfo.importer } : {}),
        },
        ...(input.searchInfo ? { naverShoppingSearchInfo: input.searchInfo } : {}),
        afterServiceInfo: {
          // 커머스 API 는 숫자·-·+ 만 허용한다 — 설정값이 무엇이든 여기서 안전한 형식으로 만든다.
          afterServiceTelephoneNumber: sanitizeAsPhoneNumber(config.afterService.telephoneNumber),
          afterServiceGuideContent: config.afterService.guideContent,
        },
        // 계정 기본 출고지가 국내면 설정에서 null 로 꺼서 필드를 생략한다.
        ...(config.customs.customsTaxType ? { customsTaxType: config.customs.customsTaxType } : {}),
        minorPurchasable: config.product.minorPurchasable,
        ...(purchaseQuantityInfo ? { purchaseQuantityInfo } : {}),
        ...(input.certificationTargetExcludeContent
          ? { certificationTargetExcludeContent: input.certificationTargetExcludeContent }
          : {}),
        ...(input.productCertificationInfos.length > 0
          ? { productCertificationInfos: input.productCertificationInfos }
          : {}),
        ...(input.productAttributes.length > 0 ? { productAttributes: input.productAttributes } : {}),
        ...(input.seoInfo ? { seoInfo: input.seoInfo } : {}),
        sellerCodeInfo: { sellerManagementCode: sellerManagementCodeForListing(input.listingId) },
      },
    },
    smartstoreChannelProduct: {
      channelProductDisplayStatusType: "ON",
      naverShoppingRegistration: true,
    },
  };
}
