import { describe, expect, it } from "vitest";
import { toProductAttributesPayload } from "../server/materials/attributes.js";
import type { AppliedAttribute } from "../src/domain/types.js";

/**
 * 커머스 API 는 productAttributes[*].attributeValueSeq 를 NotNull 로 검증한다.
 * 실제 400 사고: RANGE 속성을 valueSeq 없이 보냈다가 등록 전체가 거절됐다.
 * "불완전 항목 하나가 등록을 죽이지 않는다"를 여기서 잠근다.
 */

describe("productAttributes 페이로드", () => {
  it("attributeValueSeq 가 없는 항목은 페이로드에서 제외된다", () => {
    const applied: AppliedAttribute[] = [
      {
        attributeSeq: 10,
        attributeValueSeq: 101,
        attributeName: "색상",
        attributeValueName: "블랙",
        confidence: 0.9,
      },
      {
        // RANGE 인데 값 행을 못 찾은 결함 항목 — 통과시키면 등록 전체가 400 으로 죽는다.
        attributeSeq: 20,
        attributeRealValue: "510",
        attributeName: "가로폭",
        attributeValueName: "510",
        confidence: 0.9,
      },
    ];
    const payload = toProductAttributesPayload(applied);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ attributeSeq: 10, attributeValueSeq: 101 });
  });

  it("RANGE 속성은 valueSeq + 실측값 + 단위코드를 함께 나른다", () => {
    const applied: AppliedAttribute[] = [
      {
        attributeSeq: 20,
        attributeValueSeq: 201,
        attributeRealValue: "510",
        attributeRealValueUnitCode: "MM",
        attributeName: "가로폭",
        attributeValueName: "510",
        confidence: 0.9,
      },
    ];
    const payload = toProductAttributesPayload(applied);
    expect(payload).toEqual([
      { attributeSeq: 20, attributeValueSeq: 201, attributeRealValue: "510", attributeRealValueUnitCode: "MM" },
    ]);
  });
});
