import { describe, expect, it } from "vitest";
import { dedupeTags, normalizeTag, pickOfficialSpelling } from "../server/materials/tags.js";
import {
  applyDisplayUnit,
  buildDistribution,
  calcReturnExchangeFeeKrw,
} from "../server/materials/pricing.js";
import { matchOriginCountry, resolveOrigin } from "../server/materials/origin.js";
import { readsAsProductName } from "../server/materials/title-seo.js";
import { decideKc, resolveKcCategoryStatus } from "../server/materials/kc.js";
import { resolveNotice } from "../server/materials/notice.js";
import { normalizePath, resolveLeafFromDisplayPath, type CategoryTree } from "../server/catalog/categories.js";
import { loadSellerConfig, resetSellerConfigCache } from "../server/seller-config.js";
import type { NaverCategory } from "../server/commerce/client.js";

const config = (() => {
  resetSellerConfigCache();
  return loadSellerConfig();
})();

describe("태그 정규화", () => {
  it("선행 #를 제거하고 모든 공백을 없앤다", () => {
    expect(normalizeTag("##usb 충전식")).toBe("usb충전식");
    expect(normalizeTag("  노트북 거치대  ")).toBe("노트북거치대");
  });

  it("NFKC로 전각을 반각으로 정규화한다", () => {
    expect(normalizeTag("ＵＳＢ충전")).toBe("USB충전");
  });

  it("중복을 제거하고 10개로 자른다", () => {
    const input = ["#태그", "태그", "타 그", "타그", ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
    const output = dedupeTags(input);
    expect(output).toHaveLength(10);
    expect(output[0]).toBe("태그");
    expect(output.filter((tag) => tag === "태그")).toHaveLength(1);
    // "타 그" → "타그" 로 정규화되어 뒤의 "타그"와 중복 제거된다
    expect(output.filter((tag) => tag === "타그")).toHaveLength(1);
  });
});

describe("공식 태그 철자 채택", () => {
  it("정규화 키가 정확히 일치할 때만 공식으로 인정하고 네이버 철자를 따른다", () => {
    const rows = [{ text: "usb충전식" }, { text: "usb충전식케이블" }];
    const picked = pickOfficialSpelling(rows, "USB충전식");
    expect(picked.official).toBe(true);
    expect(picked.text).toBe("usb충전식");
  });

  it("접두어만 일치하면 공식이 아니다", () => {
    const rows = [{ text: "노트북거치대알루미늄" }];
    const picked = pickOfficialSpelling(rows, "노트북거치대");
    expect(picked.official).toBe(false);
    expect(picked.text).toBe("노트북거치대");
  });
});

describe("상품명 자연스러움", () => {
  it("머리명사가 뒤로 밀린 명사 나열을 거부한다 — 회귀 방지", () => {
    // 실제로 이렇게 등록됐다: 마지막 명사가 '커버'라 커버 상품으로 읽힌다.
    expect(readsAsProductName("텀블러 손잡이 크림 투명 커버", "텀블러")).toBe(false);
    expect(readsAsProductName("거치대 알루미늄 각도조절 접이식 휴대", "거치대")).toBe(false);
  });

  it("상품군 명사로 끝나거나 스펙이 뒤따르면 통과한다", () => {
    expect(readsAsProductName("스테인리스 보온 텀블러", "텀블러")).toBe(true);
    expect(readsAsProductName("크림 손잡이 텀블러 500ml", "텀블러")).toBe(true);
    expect(readsAsProductName("알루미늄 접이식 노트북 거치대", "거치대")).toBe(true);
    expect(readsAsProductName("노트북 거치대 알루미늄 6단 휴대용", "거치대")).toBe(true);
  });

  it("상품군 명사가 아예 없으면 거부한다", () => {
    expect(readsAsProductName("크림 투명 커버 손잡이", "텀블러")).toBe(false);
  });

  it("한 단어이거나 지나치게 길면 거부한다", () => {
    expect(readsAsProductName("텀블러", "텀블러")).toBe(false);
    expect(readsAsProductName("가 나 다 라 마 바 사 아 자 텀블러", "텀블러")).toBe(false);
  });
});

describe("가격 분포", () => {
  it("IQR 펜스로 이상치를 제거한다", () => {
    const prices = [10000, 11000, 12000, 11500, 10500, 900000];
    const built = buildDistribution(prices, "conservative");
    expect(built).not.toBeNull();
    expect(built!.distribution.removedOutliers).toBe(1);
    expect(built!.distribution.max).toBeLessThan(900000);
  });

  it("제거 후 표본이 너무 적으면 제거를 취소한다", () => {
    const prices = [1000, 100000];
    const built = buildDistribution(prices, "conservative");
    expect(built!.distribution.removedOutliers).toBe(0);
    expect(built!.distribution.keptSize).toBe(2);
  });

  it("conservative 앵커는 p25다", () => {
    const built = buildDistribution([10000, 20000, 30000, 40000], "conservative");
    expect(built!.anchorPrice).toBe(built!.distribution.p25);
    const median = buildDistribution([10000, 20000, 30000, 40000], "median");
    expect(median!.anchorPrice).toBe(median!.distribution.median);
  });

  it("displayUnit 단위로 올리고 minSalePrice를 하한으로 쓴다", () => {
    expect(applyDisplayUnit(12345, 100, 1000)).toBe(12400);
    expect(applyDisplayUnit(120, 100, 1000)).toBe(1000);
  });
});

describe("반품/교환비", () => {
  it("clamp(price*0.2, 20000, 200000)", () => {
    expect(calcReturnExchangeFeeKrw(10000)).toBe(20000);
    expect(calcReturnExchangeFeeKrw(500000)).toBe(100000);
    expect(calcReturnExchangeFeeKrw(5_000_000)).toBe(200000);
  });
});

describe("원산지", () => {
  it("'Made in China' 를 중국 규칙으로 잡는다", () => {
    expect(matchOriginCountry("Made in China")?.label).toBe("중국");
    expect(matchOriginCountry("중국산")?.label).toBe("중국");
  });

  it("'~국산' 접미가 국산으로 오분류되지 않는다 — 회귀 방지", () => {
    expect(matchOriginCountry("미국산")?.label).toBe("미국");
    expect(matchOriginCountry("국산")?.label).toBe("국산");
    expect(matchOriginCountry("한국산")?.label).toBe("국산");
  });

  it("'국산' 은 domestic 이고 importer 를 넣지 않는다", async () => {
    const rule = matchOriginCountry("국산");
    expect(rule?.domestic).toBe(true);

    const resolution = await resolveOrigin({
      marking: "국산",
      config: { ...config, origin: { ...config.origin, mode: "auto" } },
      search: async () => [{ code: "00", name: "국산" }],
    });
    expect(resolution.domestic).toBe(true);
    expect(resolution.originAreaInfo?.importer).toBeUndefined();
  });

  it("'인도네시아' 가 인도 규칙에 걸리지 않는다", () => {
    expect(matchOriginCountry("인도네시아")?.label).toBe("인도네시아");
    expect(matchOriginCountry("Made in India")?.label).toBe("인도");
  });

  it("fixed 모드는 판별 없이 설정값을 쓴다", async () => {
    const resolution = await resolveOrigin({
      marking: "Made in China",
      config,
      search: async () => {
        throw new Error("호출되면 안 된다");
      },
    });
    expect(resolution.source).toBe("config");
    expect(resolution.originAreaInfo?.originAreaCode).toBe(config.origin.originAreaCode);
  });
});

describe("KC 결정표", () => {
  const notTarget = resolveKcCategoryStatus({ id: "1", exceptionalCategories: [] });
  const kcTarget = resolveKcCategoryStatus({ id: "1", exceptionalCategories: ["KC_CERTIFICATION"] });
  const child = resolveKcCategoryStatus({ id: "1", exceptionalCategories: ["CHILD_CERTIFICATION"] });
  const unknown = resolveKcCategoryStatus(null);

  it("unknown 을 '대상 아님'과 동일시하지 않는다 — 인증 필드를 생략한다", () => {
    expect(unknown.unknown).toBe(true);
    const decision = decideKc(unknown, config, null, null, null);
    expect(decision.blocking).toBe(false);
    expect(decision.certificationTargetExcludeContent).toBeNull();
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  it("대상 아님이면 안전관리대상 아님으로 신고한다", () => {
    const decision = decideKc(notTarget, config, null, null, null);
    expect(decision.blocking).toBe(false);
    expect(decision.certificationTargetExcludeContent).toMatchObject({
      kcCertifiedProductExclusionYn: "TRUE",
      childCertifiedProductExclusionYn: true,
      greenCertifiedProductExclusionYn: true,
    });
  });

  it("KC 대상 + 정책 safe_criterion 이면 보류 없이 자동 신고한다", () => {
    const decision = decideKc(kcTarget, config, null, null, null);
    expect(decision.blocking).toBe(false);
    expect(decision.certificationTargetExcludeContent).toMatchObject({
      kcCertifiedProductExclusionYn: "KC_EXEMPTION_OBJECT",
      kcExemptionType: "SAFE_CRITERION",
    });
    expect(decision.warnings.join()).toContain("안전기준 준수");
  });

  it("KC 대상 + 인증번호가 있으면 인증 등록으로 전환한다", () => {
    const decision = decideKc(kcTarget, config, "KC-12345", 7, "전기용품 안전인증");
    expect(decision.certificationTargetExcludeContent).toMatchObject({
      kcCertifiedProductExclusionYn: "FALSE",
    });
    expect(decision.productCertificationInfos[0]).toMatchObject({
      certificationInfoId: 7,
      certificationKindType: "KC_CERTIFICATION",
      certificationNumber: "KC-12345",
    });
  });

  it("어린이제품은 안전기준준수 특례가 불가능해 '안전관리대상 아님'으로 폴백한다", () => {
    const decision = decideKc(child, config, null, null, null);
    expect(decision.status).toBe("child_fallback");
    expect(decision.blocking).toBe(false);
    expect(decision.certificationTargetExcludeContent).toMatchObject({
      kcCertifiedProductExclusionYn: "TRUE",
    });
  });

  it("정책이 review 면 KC 대상에서 차단한다", () => {
    const reviewConfig = { ...config, kc: { undocumentedPolicy: "review" as const } };
    expect(decideKc(kcTarget, reviewConfig, null, null, null).blocking).toBe(true);
  });
});

describe("상품정보제공고시", () => {
  const base = {
    categoryId: "123",
    config,
    productName: "노트북 거치대",
    modelName: null,
    manufacturerName: null,
  };

  it("빈 필드 목록이면 기본 값 맵만 싣는다 — 전체 사전 필드를 채우지 않는다", async () => {
    const resolution = await resolveNotice({
      ...base,
      fetchTypes: async () => [
        { productInfoProvidedNoticeType: "ETC", productInfoProvidedNoticeContents: [] },
      ],
    });
    const values = resolution.payload.etc as Record<string, string>;
    expect(Object.keys(values).sort()).toEqual(
      [
        "afterServiceDirector",
        "compensationProcedure",
        "importer",
        "itemName",
        "manufacturer",
        "modelName",
        "noRefundReason",
        "qualityAssuranceStandard",
        "returnCostReason",
        "troubleShootingContents",
      ].sort(),
    );
  });

  it("빈 배열 응답은 '미확인'으로 강등하고 경고를 남긴다", async () => {
    const resolution = await resolveNotice({ ...base, fetchTypes: async () => [] });
    expect(resolution.noticeType).toBe("ETC");
    expect(resolution.typeUnconfirmed).toBe(true);
    expect(resolution.usedFallbackType).toBe(false);
    expect(resolution.warnings.join()).toContain("확인하지 못해");
  });

  it("조회 예외일 때만 usedFallbackType 이 true 다", async () => {
    const resolution = await resolveNotice({
      ...base,
      fetchTypes: async () => {
        throw new Error("network");
      },
    });
    expect(resolution.usedFallbackType).toBe(true);
    expect(resolution.typeUnconfirmed).toBe(false);
  });

  it("필드 목록이 있으면 그 필드들만 채운다", async () => {
    const resolution = await resolveNotice({
      ...base,
      fetchTypes: async () => [
        {
          productInfoProvidedNoticeType: "WEAR",
          productInfoProvidedNoticeContents: [{ fieldName: "material" }, { fieldName: "modelName" }],
        },
      ],
    });
    const values = resolution.payload.wear as Record<string, string>;
    expect(Object.keys(values).sort()).toEqual(["material", "modelName"]);
    expect(values.material).toBe("상세페이지 참조");
  });
});

describe("카테고리 leaf 해석", () => {
  const nodes: NaverCategory[] = [
    { id: "1", name: "디지털/가전", last: false, wholeCategoryName: "디지털/가전" },
    {
      id: "2",
      name: "노트북받침대/쿨러",
      last: true,
      wholeCategoryName: "디지털/가전>노트북액세서리>노트북받침대/쿨러",
    },
    {
      id: "3",
      name: "마우스패드",
      last: true,
      wholeCategoryName: "디지털/가전>노트북액세서리>마우스패드",
    },
    {
      id: "4",
      name: "마우스패드",
      last: true,
      wholeCategoryName: "생활/건강>사무용품>마우스패드",
    },
  ];

  const tree: CategoryTree = {
    syncedAt: new Date().toISOString(),
    byId: new Map(nodes.map((node) => [node.id, node])),
    byWholeName: new Map(nodes.map((node) => [normalizePath(node.wholeCategoryName), node])),
    leaves: nodes.filter((node) => node.last),
    stale: false,
  };

  it("전체 경로가 일치하면 채택한다", () => {
    const resolved = resolveLeafFromDisplayPath(tree, ["디지털/가전", "노트북액세서리", "노트북받침대/쿨러"]);
    expect(resolved?.category.id).toBe("2");
    expect(resolved?.matchKind).toBe("exact_path");
  });

  it("접미 일치가 1건이면 채택한다", () => {
    const resolved = resolveLeafFromDisplayPath(tree, ["아무거나", "노트북액세서리", "노트북받침대/쿨러"]);
    expect(resolved?.category.id).toBe("2");
  });

  it("이름 일치가 여러 건이면 채택하지 않는다", () => {
    expect(resolveLeafFromDisplayPath(tree, ["마우스패드"])).toBeNull();
  });
});
