import { describe, expect, it } from "vitest";
import { repairPayloadAfter400 } from "../server/publish/register.js";
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

describe("A/S 번호 정규화", () => {
  it("허용 문자만 남기고, 자리표시자는 기본 번호로 대체한다", () => {
    expect(sanitizeAsPhoneNumber("010-1234-5678")).toBe("010-1234-5678");
    expect(sanitizeAsPhoneNumber("010 1234 5678")).toBe("01012345678");
    expect(sanitizeAsPhoneNumber("REPLACE_WITH_REAL_PHONE")).toBe("010-0000-0000");
    expect(sanitizeAsPhoneNumber("판매자문의")).toBe("010-0000-0000");
  });
});
