import { describe, expect, it } from "vitest";
import { planDiscount } from "../server/materials/pricing.js";
import { buildProductPayload } from "../server/publish/payload.js";
import { loadSellerConfig } from "../server/seller-config.js";

/**
 * 즉시할인의 유일한 불변식: **고객이 내는 값은 움직이지 않는다.**
 * 정가만 역산해 올리고 차액을 할인으로 건다. 화면의 빗금·빨간 가격이 실제 등록과
 * 같은 숫자여야 무대가 거짓말을 하지 않는다.
 */

describe("즉시할인 설계", () => {
  it("고객가를 고정하고 정가를 역산한다", () => {
    const plan = planDiscount(15_000, { targetRate: 15, displayUnit: 100 });
    expect(plan).not.toBeNull();
    expect(plan!.listPrice - plan!.discountKrw).toBe(15_000);
    expect(plan!.listPrice).toBe(17_700); // ceil(15000/0.85 /100)*100
    expect(plan!.discountRate).toBe(15);
  });

  it("표기 할인율은 목표치가 아니라 등록되는 두 금액에서 되계산한 값이다", () => {
    const plan = planDiscount(1_000, { targetRate: 15, displayUnit: 1_000 });
    // 1000원 단위 올림이라 정가가 2000원으로 튄다 → 실제 할인율은 50%다.
    expect(plan!.listPrice).toBe(2_000);
    expect(plan!.discountRate).toBe(50);
    expect(plan!.listPrice - plan!.discountKrw).toBe(1_000);
  });

  it("목표율 0 이면 할인을 걸지 않는다", () => {
    expect(planDiscount(15_000, { targetRate: 0, displayUnit: 100 })).toBeNull();
  });

  it("반올림해서 0% 가 되는 할인은 걸지 않는다 — 0% 빗금은 거짓 연출이다", () => {
    expect(planDiscount(15_000, { targetRate: 0.2, displayUnit: 1 })).toBeNull();
    // 같은 목표라도 100원 단위로 올림하면 실제 1% 가 되므로 이때는 건다.
    expect(planDiscount(15_000, { targetRate: 0.2, displayUnit: 100 })?.discountRate).toBe(1);
  });
});

describe("등록 페이로드", () => {
  const base = {
    listingId: "L",
    title: "테스트 상품",
    leafCategoryId: "50000000",
    representativeImageUrl: "https://example.com/a.jpg",
    optionalImageUrls: [],
    detailContent: "<div></div>",
    stockQuantity: 10,
    config: loadSellerConfig(),
    notice: {},
    originAreaInfo: { originAreaCode: "00", content: "국산" },
    searchInfo: null,
    certificationTargetExcludeContent: null,
    productCertificationInfos: [],
    productAttributes: [],
    seoInfo: null,
  };

  const origin = (payload: Record<string, unknown>) =>
    payload.originProduct as Record<string, unknown>;

  it("할인이 있으면 salePrice 는 정가이고 차액이 즉시할인으로 붙는다", () => {
    const payload = buildProductPayload({
      ...base,
      salePrice: 15_000,
      listPrice: 17_700,
      discountKrw: 2_700,
    });
    expect(origin(payload).salePrice).toBe(17_700);
    expect(origin(payload).customerBenefit).toEqual({
      immediateDiscountPolicy: { discountMethod: { value: 2_700, unitType: "WON" } },
    });
  });

  it("할인이 없으면 customerBenefit 자체를 넣지 않는다", () => {
    const payload = buildProductPayload({ ...base, salePrice: 15_000 });
    expect(origin(payload).salePrice).toBe(15_000);
    expect(origin(payload).customerBenefit).toBeUndefined();
  });

  it("반품·교환비는 정가가 아니라 고객가 기준으로 잡는다", () => {
    const withDiscount = buildProductPayload({
      ...base,
      salePrice: 15_000,
      listPrice: 17_700,
      discountKrw: 2_700,
    });
    const without = buildProductPayload({ ...base, salePrice: 15_000 });
    const fee = (payload: Record<string, unknown>) =>
      (
        (origin(payload).deliveryInfo as Record<string, unknown>).claimDeliveryInfo as Record<
          string,
          number
        >
      ).returnDeliveryFee;
    expect(fee(withDiscount)).toBe(fee(without));
  });
});
