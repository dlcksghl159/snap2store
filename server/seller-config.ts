import { readFileSync } from "node:fs";
import { DEFAULT_DISCOUNT_RATE } from "../src/domain/pricing.js";
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
      /**
       * 즉시할인 목표율(%). 0 이면 할인을 걸지 않는다.
       * 산출된 판매가는 **고객이 실제로 내는 값**으로 고정하고, 정가를 이 비율만큼
       * 역산해 올린 뒤 차액을 즉시할인으로 등록한다 — 화면의 빗금·빨간 가격이
       * 실제 스마트스토어 상품 페이지와 같은 숫자가 된다.
       */
      discountRate: z.number().int().min(0).max(50).default(DEFAULT_DISCOUNT_RATE),
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
      galleryCount: z.number().int().min(0).max(4).default(3),
      detailPanelCount: z.number().int().min(0).max(8).default(6),
      /*
        품질은 **샷당 지연을 지배하는 유일한 축**이다 (2026-08-02 gpt-image-2 실측,
        참조 3장 · 회차 2회 평균):
          low    20.6s  — 크기 무관(816² 21.2s / 1024² 20.6s / 1024×1536 20.5s)
          medium 51.5s  — low 의 2.5배
          high  145.1s  — low 의 7배. 이미지 클라이언트 타임아웃(150s)에 걸려
                          2회 중 1회가 실패했다. 사실상 쓸 수 없는 값이다.
        참조 수는 거의 영향이 없다(medium 1장 48.1s vs 3장 51.5s).

        ⚠ mainQuality 는 특히 비싸다. 상세 패널이 대표 컷을 정체성 앵커로 **기다리므로**
        (orchestrator 의 HERO_WAIT_MS) 그 지연이 그대로 임계경로에 얹힌다 —
        medium 이면 전체 런이 ~78s, low 면 ~55s.
        시간이 모자라면 품질보다 galleryCount / detailPanelCount(개수)를 먼저 줄인다.
      */
      /** 갤러리(추가 컷) 품질. */
      quality: z.enum(["low", "medium", "high"]).default("low"),
      /** 대표 컷(썸네일) 품질 — 임계경로에 직결된다. 위 주석 참고. */
      mainQuality: z.enum(["low", "medium", "high"]).default("low"),
      /**
       * 상세 패널 품질. 패널은 **6컷이 한 웨이브로 동시에** 구워지므로 품질을 올려도
       * 벽시계는 샷 하나치만 늘어난다 — 갤러리·대표와 따로 잡을 값어치가 있다.
       * (상세페이지는 구매를 결정짓는 자리라 본문 그림에 품질을 더 쓴다.)
       */
      panelQuality: z.enum(["low", "medium", "high"]).default("medium"),
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
