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
  salePrice: number;
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
  const claimFee = calcReturnExchangeFeeKrw(input.salePrice);
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
      salePrice: input.salePrice,
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
          afterServiceTelephoneNumber: config.afterService.telephoneNumber,
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
