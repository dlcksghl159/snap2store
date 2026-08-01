import { readFileSync } from "node:fs";
import { z } from "zod";
import { env } from "./env.js";

/**
 * 판매자 정책. 모든 필드에 안전한 기본값을 둔다 — 파일이 없어도 서버는 뜬다.
 */
const CategoryOverrideSchema = z.object({
  includes: z.array(z.string().trim().min(1)).min(1),
  categoryId: z.string().trim().min(1),
  categoryName: z.string().trim().min(1),
});

const SellerConfigSchema = z.object({
  categoryOverrides: z.array(CategoryOverrideSchema).default([]),
  delivery: z
    .object({
      deliveryCompany: z.string().trim().default("CJGLS"),
      deliveryFeeType: z.enum(["FREE", "PAID", "CONDITIONAL_FREE"]).default("FREE"),
      baseFee: z.number().int().min(0).default(3000),
      freeConditionalAmount: z.number().int().min(0).nullable().default(null),
    })
    .prefault({}),
  afterService: z
    .object({
      telephoneNumber: z.string().trim().default("010-0000-0000"),
      guideContent: z.string().trim().default("판매자에게 문의해주세요"),
      director: z.string().trim().default("판매자 문의"),
    })
    .prefault({}),
  origin: z
    .object({
      mode: z.enum(["auto", "fixed"]).default("auto"),
      fallbackPolicy: z.enum(["review", "default"]).default("review"),
      originAreaCode: z.string().trim().default("0200037"),
      content: z.string().trim().default("중국"),
      importer: z.string().trim().default("수입자에게 문의"),
    })
    .prefault({}),
  noticeDefaults: z
    .object({
      returnCostReason: z.string().trim().default("초기불량, 오배송에 한해 무료반품"),
      noRefundReason: z.string().trim().default("개봉 후 사용한 상품은 교환/반품 불가"),
      qualityAssuranceStandard: z.string().trim().default("소비자분쟁해결기준에 따름"),
      compensationProcedure: z.string().trim().default("소비자분쟁해결기준에 따름"),
      troubleShootingContents: z.string().trim().default("판매자 문의"),
    })
    .prefault({}),
  product: z
    .object({
      manufacturer: z.string().trim().default("상세페이지 참조"),
      modelName: z.string().trim().default("상세페이지 참조"),
      minorPurchasable: z.boolean().default(true),
      stockQuantityDefault: z.number().int().min(0).default(20),
      maxPurchaseQuantityPerId: z.number().int().min(1).default(99),
      maxPurchaseQuantityPerOrder: z.number().int().min(1).default(99),
    })
    .prefault({}),
  pricing: z
    .object({
      displayUnit: z.number().int().min(1).default(100),
      anchor: z.enum(["conservative", "median"]).default("conservative"),
      minSalePrice: z.number().int().min(100).default(1000),
      fallbackPolicy: z.enum(["review", "agent"]).default("review"),
    })
    .prefault({}),
  kc: z
    .object({
      // 기본은 무보류 자동 신고다.
      undocumentedPolicy: z.enum(["safe_criterion", "review"]).default("safe_criterion"),
    })
    .prefault({}),
  customs: z
    .object({
      customsTaxType: z.enum(["INCLUDED", "PAID"]).nullable().default("INCLUDED"),
    })
    .prefault({}),
  media: z
    .object({
      galleryCount: z.number().int().min(0).max(4).default(2),
      detailPanelCount: z.number().int().min(0).max(8).default(6),
      // 산출물 품질이 이 제품의 절반이다. 지연이 모자라면 여기가 아니라
      // galleryCount / detailPanelCount 를 먼저 줄인다.
      quality: z.enum(["low", "medium", "high"]).default("high"),
      mainQuality: z.enum(["low", "medium", "high"]).default("high"),
    })
    .prefault({}),
});

export type SellerConfig = z.infer<typeof SellerConfigSchema>;
export type CategoryOverride = z.infer<typeof CategoryOverrideSchema>;

let cached: SellerConfig | null = null;

/** 프로세스 수명 내 1회 로드. */
export function loadSellerConfig(): SellerConfig {
  if (cached) return cached;
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(env.resolvedSmartstoreDefaultsPath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(`[seller-config] 설정 파일을 읽지 못했습니다 — 기본값으로 진행합니다: ${String(error)}`);
    }
    raw = {};
  }
  const parsed = SellerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[seller-config] 설정 스키마 위반 — 기본값으로 진행합니다: ${parsed.error.message}`);
    cached = SellerConfigSchema.parse({});
    return cached;
  }
  cached = parsed.data;
  return cached;
}

/** 테스트용 리셋. */
export function resetSellerConfigCache(): void {
  cached = null;
}

/**
 * 실전송 차단 검증. A/S 전화번호가 기본값이어도 막지 않는다 — 그 값으로도 등록된다.
 */
export function validateSellerConfigForLive(config: SellerConfig): string[] {
  const errors: string[] = [];
  if (config.delivery.deliveryFeeType === "PAID" && config.delivery.baseFee <= 0) {
    errors.push("유료배송으로 설정됐지만 기본배송비가 0원입니다 — config/smartstore.local.json 의 delivery.baseFee 를 채우세요.");
  }
  if (
    config.delivery.deliveryFeeType === "CONDITIONAL_FREE" &&
    (config.delivery.freeConditionalAmount == null || config.delivery.freeConditionalAmount <= 0)
  ) {
    errors.push("조건부 무료배송으로 설정됐지만 무료 기준 금액이 없습니다 — delivery.freeConditionalAmount 를 채우세요.");
  }
  return errors;
}

export function sellerConfigWarningsForLive(config: SellerConfig): string[] {
  const warnings: string[] = [];
  if (config.afterService.telephoneNumber === "010-0000-0000" || config.afterService.telephoneNumber === "REPLACE_WITH_REAL_PHONE") {
    warnings.push("A/S 전화번호가 기본 자리표시자입니다 — 실번호로 교체를 권장합니다.");
  }
  return warnings;
}
