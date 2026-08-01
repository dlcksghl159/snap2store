import { describe, expect, it } from "vitest";
import {
  buildProductPayload,
  buildShoppingSearchInfo,
  sellerManagementCodeForListing,
} from "../server/publish/payload.js";
import {
  buildDetailContent,
  buildShowcaseDetailContent,
} from "../server/publish/detail-content.js";
import { runPreflight } from "../server/publish/preflight.js";
import { loadSellerConfig, resetSellerConfigCache } from "../server/seller-config.js";
import type {
  KcResolution,
  NoticeResolution,
  OriginResolution,
  ResolvedCategory,
  TagResolution,
} from "../src/domain/types";

const config = (() => {
  resetSellerConfigCache();
  return loadSellerConfig();
})();

const NAVER = "https://shop-phinf.pstatic.net/2026/main.jpg";
const NAVER2 = "https://shop-phinf.pstatic.net/2026/gallery.jpg";

describe("판매자상품코드", () => {
  it("UUID 에서 대시를 지우고 30자 이하로 자른다", () => {
    const code = sellerManagementCodeForListing("aa11bb22-cc33-dd44-ee55-ff6677889900");
    expect(code).toBe("aa11bb22cc33dd44ee55ff66778899");
    expect(code.length).toBeLessThanOrEqual(30);
    expect(code).not.toContain("-");
  });
});

describe("naverShoppingSearchInfo", () => {
  it("brandVerified 가 false 면 brandName 을 싣지 않는다", () => {
    const info = buildShoppingSearchInfo({
      brandVerified: false,
      brandName: "샤넬",
      manufacturerName: "제조사",
      modelName: "M-1",
    });
    expect(info).not.toHaveProperty("brandName");
    expect(info).toMatchObject({ manufacturerName: "제조사", modelName: "M-1" });
  });

  it("brandVerified 가 true 면 brandName 을 싣는다", () => {
    const info = buildShoppingSearchInfo({
      brandVerified: true,
      brandName: "실브랜드",
      manufacturerName: null,
      modelName: null,
    });
    expect(info).toMatchObject({ brandName: "실브랜드" });
  });

  it("아무 정체도 없으면 생략한다", () => {
    expect(
      buildShoppingSearchInfo({
        brandVerified: false,
        brandName: null,
        manufacturerName: null,
        modelName: null,
      }),
    ).toBeNull();
  });
});

describe("등록 페이로드", () => {
  const base = {
    listingId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
    title: "노트북 거치대 알루미늄",
    leafCategoryId: "50002322",
    representativeImageUrl: NAVER,
    optionalImageUrls: Array.from({ length: 12 }, (_, index) => `${NAVER2}?i=${index}`),
    detailContent: "<div>상세</div>",
    salePrice: 24900,
    stockQuantity: 20,
    config,
    notice: { productInfoProvidedNoticeType: "ETC", etc: {} },
    originAreaInfo: { originAreaCode: "00", content: "국산" },
    searchInfo: null,
    certificationTargetExcludeContent: null,
    productCertificationInfos: [],
    productAttributes: [],
    seoInfo: null,
  };

  it("대표 이미지가 필수이고 추가 이미지는 9장 상한이다", () => {
    const payload = buildProductPayload(base) as any;
    expect(payload.originProduct.images.representativeImage.url).toBe(NAVER);
    expect(payload.originProduct.images.optionalImages).toHaveLength(9);
  });

  it("customsTaxType 이 null 이면 필드를 생략한다", () => {
    const off = { ...config, customs: { customsTaxType: null } };
    const payload = buildProductPayload({ ...base, config: off }) as any;
    expect(payload.originProduct.detailAttribute).not.toHaveProperty("customsTaxType");

    const on = buildProductPayload(base) as any;
    expect(on.originProduct.detailAttribute.customsTaxType).toBe("INCLUDED");
  });

  it("판매자상품코드를 30자 이하로 싣는다", () => {
    const payload = buildProductPayload(base) as any;
    const code = payload.originProduct.detailAttribute.sellerCodeInfo.sellerManagementCode;
    expect(code.length).toBeLessThanOrEqual(30);
  });

  it("반품·교환 배송비를 함께 싣는다", () => {
    const payload = buildProductPayload(base) as any;
    const claim = payload.originProduct.deliveryInfo.claimDeliveryInfo;
    expect(claim.returnDeliveryFee).toBe(claim.exchangeDeliveryFee);
    expect(claim.returnDeliveryFee).toBe(20000);
  });
});

describe("상세 HTML", () => {
  const common = {
    specRows: [{ label: "재질", value: "알루미늄" }],
    noticeLines: ["무료배송"],
    productAlt: "노트북 거치대",
  };

  it("네이버가 아닌 이미지 URL 을 드롭한다", () => {
    const result = buildShowcaseDetailContent({
      ...common,
      headline: "머리말",
      subheadline: "부제",
      hooks: [{ label: "무게", value: "1kg" }],
      sections: [
        { role: "hook", heading: "제목", body: "본문", imageUrl: "http://example.com/a.jpg" },
        { role: "closing", heading: "마무리", body: "본문", imageUrl: NAVER },
      ],
      closing: "끝",
      heroImageUrl: null,
      extraImageUrls: [],
    });
    expect(result.droppedImageUrls).toContain("http://example.com/a.jpg");
    expect(result.html).not.toContain("example.com");
    expect(result.html).toContain(NAVER);
  });

  it("금지 태그와 table 이 등장하지 않는다", () => {
    const result = buildDetailContent({
      title: "제목 <script>alert(1)</script>",
      summary: "요약 & 설명",
      imageUrls: [NAVER],
      sections: [{ heading: "제목", body: "본문" }],
      specRows: common.specRows,
      noticeLines: common.noticeLines,
    });
    expect(/<(a|iframe|script|style|form|table|thead|tbody|tr|td|th)\b/i.test(result.html)).toBe(false);
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("&amp;");
  });

  it("font-size 는 <p> 레벨에 실린다 — <span> 에 싣지 않는다", () => {
    const result = buildDetailContent({
      title: "제목",
      summary: "요약",
      imageUrls: [],
      sections: [{ heading: "제목", body: "본문" }],
      specRows: common.specRows,
      noticeLines: [],
    });
    expect(result.html).toContain('<p style="font-size:');
    expect(/<span[^>]*font-size/i.test(result.html)).toBe(false);
  });

  it("trustAllImageHosts 가 켜지면 로컬 URL 을 허용한다", () => {
    const result = buildDetailContent({
      title: "제목",
      summary: "요약",
      imageUrls: ["/runtime/assets/x/main.jpg"],
      sections: [],
      specRows: [],
      noticeLines: [],
      trustAllImageHosts: true,
    });
    expect(result.html).toContain("/runtime/assets/x/main.jpg");
  });
});

describe("프리플라이트", () => {
  const category: ResolvedCategory = {
    outcome: "verified",
    categoryId: "50002322",
    categoryName: "디지털/가전>노트북액세서리>노트북받침대/쿨러",
    leafName: "노트북받침대/쿨러",
    verified: true,
    match: null,
  };
  const origin: OriginResolution = {
    resolved: true,
    needsReview: false,
    reviewReason: null,
    countryLabel: "국산",
    domestic: true,
    originAreaInfo: { originAreaCode: "00", content: "국산" },
    source: "config",
    warnings: [],
  };
  const kc: KcResolution = {
    status: "not_target",
    statusLabel: "KC 안전관리대상 아님",
    blocking: false,
    blockReason: null,
    certificationTargetExcludeContent: null,
    productCertificationInfos: [],
    warnings: [],
  };
  const notice: NoticeResolution = {
    noticeType: "ETC",
    noticeTypeName: "기타 재화",
    payload: {},
    usedFallbackType: false,
    typeUnconfirmed: false,
    warnings: [],
  };
  const tags: TagResolution = { tags: [], restrictedRemoved: [], dictionaryChecked: true, warnings: [] };

  const base = {
    isLive: false,
    title: "노트북 거치대 알루미늄",
    category,
    salePrice: 24900,
    stockQuantity: 20,
    representativeImageUrl: NAVER,
    optionalImageUrls: [],
    detailContent: "<div><p>상세 설명</p></div>",
    origin,
    kc,
    notice,
    tags,
    config,
  };

  it("대표 이미지가 없으면 에러다", async () => {
    const result = await runPreflight({ ...base, representativeImageUrl: null });
    expect(result.publishAllowed).toBe(false);
    expect(result.errors.join()).toContain("대표 이미지");
  });

  it("카테고리 미확정이면 에러다", async () => {
    const result = await runPreflight({
      ...base,
      category: { ...category, categoryId: null, verified: false },
    });
    expect(result.publishAllowed).toBe(false);
    expect(result.errors.join()).toContain("카테고리");
  });

  it("판매가가 100원 미만이면 에러다", async () => {
    const result = await runPreflight({ ...base, salePrice: 50 });
    expect(result.errors.join()).toContain("최소가");
  });

  it("상세에 <a> 가 있으면 에러다", async () => {
    const result = await runPreflight({
      ...base,
      detailContent: '<div><a href="http://x">링크</a></div>',
    });
    expect(result.errors.join()).toContain("금지 태그");
  });

  it("원산지 미확정이면 에러다", async () => {
    const result = await runPreflight({
      ...base,
      origin: { ...origin, needsReview: true, originAreaInfo: null, reviewReason: "판독 실패" },
    });
    expect(result.errors.join()).toContain("원산지");
  });
});
