import { describe, expect, it } from "vitest";
import { categoryAuthorityBlocked, repairPayloadAfter400, swapCategory } from "../server/publish/register.js";
import { sanitizeAsPhoneNumber } from "../server/publish/payload.js";

/**
 * 400 BAD_REQUEST 는 "확실히 등록되지 않음" — 수리 후 재전송은 중복 위험이 없다.
 * 여기서는 네이버 invalidInputs 지목별 수리와 최후의 최소 페이로드 강하를 잠근다.
 */

function samplePayload(): Record<string, unknown> {
  return {
    originProduct: {
      name: "사무용 의자 [특가!!] ★한정★",
      salePrice: 19930,
      images: {
        representativeImage: { url: "https://img/rep.jpg" },
        optionalImages: [{ url: "https://img/opt.jpg" }],
      },
      detailAttribute: {
        afterServiceInfo: {
          afterServiceTelephoneNumber: "REPLACE_WITH_REAL_PHONE",
          afterServiceGuideContent: "판매자 문의",
        },
        originAreaInfo: { originAreaCode: "00", content: "국산" },
        productAttributes: [{ attributeSeq: 1, attributeValueSeq: 10 }],
        seoInfo: { pageTitle: "t" },
        productInfoProvidedNotice: {
          productInfoProvidedNoticeType: "ETC",
          etc: { itemName: "의자", manufacturer: "몰라요" },
        },
      },
    },
  };
}

function bad(names: string[]): string {
  return JSON.stringify({
    code: "BAD_REQUEST",
    invalidInputs: names.map((name) => ({ name, type: "x", message: "m" })),
  });
}

describe("등록 400 자가수리", () => {
  it("A/S 번호 지목 → 안전한 번호로 교체한다", () => {
    const repaired = repairPayloadAfter400(
      samplePayload(),
      bad(["originProduct.detailAttribute.afterServiceInfo.afterServiceTelephoneNumber"]),
      0,
    );
    expect(repaired).not.toBeNull();
    const detail = (repaired!.payload.originProduct as Record<string, unknown>)
      .detailAttribute as Record<string, unknown>;
    expect((detail.afterServiceInfo as Record<string, unknown>).afterServiceTelephoneNumber).toBe(
      "010-0000-0000",
    );
  });

  it("productAttributes 지목 → 블록째 걷어낸다", () => {
    const repaired = repairPayloadAfter400(
      samplePayload(),
      bad(["originProduct.detailAttribute.productAttributes[0].attributeValueSeq"]),
      0,
    );
    const detail = (repaired!.payload.originProduct as Record<string, unknown>)
      .detailAttribute as Record<string, unknown>;
    expect(detail.productAttributes).toBeUndefined();
    // 다른 블록은 건드리지 않는다.
    expect(detail.seoInfo).toBeDefined();
  });

  it("고시 문자열 리프 지목 → 안전 문구로 일반 수리한다", () => {
    const repaired = repairPayloadAfter400(
      samplePayload(),
      bad(["originProduct.detailAttribute.productInfoProvidedNotice.etc.manufacturer"]),
      0,
    );
    const detail = (repaired!.payload.originProduct as Record<string, unknown>)
      .detailAttribute as Record<string, unknown>;
    const notice = detail.productInfoProvidedNotice as Record<string, unknown>;
    expect((notice.etc as Record<string, unknown>).manufacturer).toBe("상세페이지 참조");
  });

  it("본문을 못 읽어도 1차에서 선택 블록을 걷어 재시도한다", () => {
    const repaired = repairPayloadAfter400(samplePayload(), "not-json", 0);
    expect(repaired).not.toBeNull();
    const detail = (repaired!.payload.originProduct as Record<string, unknown>)
      .detailAttribute as Record<string, unknown>;
    expect(detail.productAttributes).toBeUndefined();
    expect(detail.seoInfo).toBeUndefined();
  });

  it("마지막 시도는 최소 페이로드 — 선택 블록 전부 제거 + 이름·번호 정제", () => {
    const repaired = repairPayloadAfter400(samplePayload(), "whatever", 2);
    expect(repaired).not.toBeNull();
    const origin = repaired!.payload.originProduct as Record<string, unknown>;
    const detail = origin.detailAttribute as Record<string, unknown>;
    expect(detail.productAttributes).toBeUndefined();
    expect(detail.seoInfo).toBeUndefined();
    expect((origin.images as Record<string, unknown>).optionalImages).toBeUndefined();
    expect(String(origin.name)).toBe("사무용 의자 특가 한정");
    expect(String(origin.name)).not.toMatch(/[★!\[\]]/);
    // 필수 블록(고시·원산지·대표이미지)은 남는다.
    expect(detail.productInfoProvidedNotice).toBeDefined();
    expect(detail.originAreaInfo).toBeDefined();
    expect((origin.images as Record<string, unknown>).representativeImage).toBeDefined();
  });
});

/*
  실측 거절 본문. 립톤 복숭아 아이스티·펩시 제로가 이 두 줄 때문에 등록되지 못했다.
  하나는 "없는 칸을 만들어라"(가격표시제), 다른 하나는 페이로드로 못 넘는 권한 벽이다.
*/
const BEVERAGE_REJECTION = JSON.stringify({
  code: "BAD_REQUEST",
  message: "입력한 데이터가 유효하지 않습니다.",
  invalidInputs: [
    {
      name: "originProduct.detailAttribute.unitCapacity.unitPriceYn",
      type: "Required.product.unitPriceYn",
      message: "단위가격 사용여부를 선택해주세요. 가격표시제 대상 품목입니다.",
    },
    {
      type: "NotAuthority.product.category.id",
      message: "등록권한이 있어야만 판매가 가능합니다. 스마트스토어센터에서 권한 신청 후 이용해 주세요.",
    },
  ],
});

describe("가격표시제 필수 필드", () => {
  it("빠진 unitPriceYn 을 빼는 게 아니라 채워 넣는다", () => {
    const repaired = repairPayloadAfter400(samplePayload(), BEVERAGE_REJECTION, 0);
    expect(repaired).not.toBeNull();
    const detail = (repaired!.payload.originProduct as Record<string, unknown>)
      .detailAttribute as Record<string, unknown>;
    expect(detail.unitCapacity).toEqual({ unitPriceYn: false });
    expect(repaired!.notes.join(" ")).toContain("단위가격");
  });

  it("이름 없이 type 만 온 거절도 읽는다 — 권한 벽을 알아본다", () => {
    expect(categoryAuthorityBlocked(BEVERAGE_REJECTION)).toBe(true);
    expect(categoryAuthorityBlocked(JSON.stringify({ invalidInputs: [{ name: "originProduct.name" }] }))).toBe(
      false,
    );
  });
});

describe("판매권한 벽 — 카테고리 갈아타기", () => {
  it("리프를 바꾸고, 카테고리에 매인 값들을 함께 걷어낸다", () => {
    const payload = samplePayload();
    (payload.originProduct as Record<string, unknown>).leafCategoryId = "50002255";
    const detail = (payload.originProduct as Record<string, unknown>).detailAttribute as Record<
      string,
      unknown
    >;
    detail.unitCapacity = { unitPriceYn: false };

    const notes: string[] = [];
    expect(swapCategory(payload, "50022360", notes)).toBe(true);

    const origin = payload.originProduct as Record<string, unknown>;
    expect(origin.leafCategoryId).toBe("50022360");
    // 카테고리별 코드 체계라 옮겨 가지 못한다.
    expect((origin.detailAttribute as Record<string, unknown>).productAttributes).toBeUndefined();
    expect((origin.detailAttribute as Record<string, unknown>).unitCapacity).toBeUndefined();
    // 등록에 반드시 필요한 것들은 남는다.
    expect((origin.detailAttribute as Record<string, unknown>).originAreaInfo).toBeDefined();
    expect((origin.images as Record<string, unknown>).representativeImage).toBeDefined();
  });

  it("같은 카테고리로는 갈아타지 않는다 — 무한 재시도 방지", () => {
    const payload = samplePayload();
    (payload.originProduct as Record<string, unknown>).leafCategoryId = "50022360";
    expect(swapCategory(payload, "50022360", [])).toBe(false);
  });
});

describe("A/S 번호 정규화", () => {
  it("허용 문자만 남기고, 자리표시자는 기본 번호로 대체한다", () => {
    expect(sanitizeAsPhoneNumber("010-1234-5678")).toBe("010-1234-5678");
    expect(sanitizeAsPhoneNumber("010 1234 5678")).toBe("01012345678");
    expect(sanitizeAsPhoneNumber("REPLACE_WITH_REAL_PHONE")).toBe("010-0000-0000");
    expect(sanitizeAsPhoneNumber("판매자문의")).toBe("010-0000-0000");
  });
});
