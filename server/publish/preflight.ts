import { getCategoryTree } from "../catalog/categories.js";
import { validateTitle } from "../materials/title-gate.js";
import { NAVER_TRUSTED_HOST_RE } from "./detail-content.js";
import {
  sellerConfigWarningsForLive,
  validateSellerConfigForLive,
  type SellerConfig,
} from "../seller-config.js";
import type {
  KcResolution,
  NoticeResolution,
  OriginResolution,
  ResolvedCategory,
  TagResolution,
} from "../../src/domain/types";

const FORBIDDEN_TAG_RE = /<(a|iframe|script|style|form|table|thead|tbody|tr|td|th)\b/i;

export interface PreflightInput {
  isLive: boolean;
  title: string;
  category: ResolvedCategory;
  salePrice: number;
  stockQuantity: number;
  representativeImageUrl: string | null;
  optionalImageUrls: string[];
  detailContent: string;
  origin: OriginResolution;
  kc: KcResolution;
  notice: NoticeResolution;
  tags: TagResolution;
  config: SellerConfig;
}

export interface PreflightResult {
  errors: string[];
  warnings: string[];
  publishAllowed: boolean;
}

/**
 * POST 전에 페이로드 재료를 전부 시뮬레이션 검사한다.
 * 네이버 400 을 받고 역추적하는 대신, 어떤 재료가 왜 미달인지
 * 사람이 읽을 수 있는 문장으로 먼저 알린다.
 *
 * 프리플라이트 실패는 런을 죽이지 않는다 — 오케스트레이터가 실전송만 강등한다.
 */
export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 상품명
  const titleGate = validateTitle(input.title, "registration");
  errors.push(...titleGate.errors.map((error) => `상품명: ${error}`));
  warnings.push(...titleGate.warnings.map((warning) => `상품명: ${warning}`));

  // 카테고리
  if (!input.category.categoryId) {
    errors.push("판매 카테고리를 확정하지 못했습니다 — 등록에는 leaf 카테고리가 반드시 필요합니다.");
  } else {
    try {
      const tree = await getCategoryTree();
      const node = tree.byId.get(input.category.categoryId);
      if (!node) {
        errors.push(`카테고리 ${input.category.categoryId} 를 카테고리 트리에서 찾지 못했습니다.`);
      } else if (!node.last) {
        errors.push(`카테고리 "${node.name}" 는 판매 가능한 최하위(leaf) 카테고리가 아닙니다.`);
      }
    } catch {
      warnings.push("카테고리 트리를 확인하지 못해 카테고리 유효성을 검증하지 못했습니다.");
    }
    if (!input.category.verified) {
      warnings.push("카테고리 검증 루프를 통과하지 못했습니다 — 후보 채택 상태로 등록합니다.");
    }
  }

  // 판매가
  if (!Number.isInteger(input.salePrice)) {
    errors.push("판매가가 정수가 아닙니다.");
  } else if (input.salePrice < 100) {
    errors.push(`판매가가 플랫폼 최소가(100원) 미만입니다 (현재 ${input.salePrice}원).`);
  } else if (input.salePrice > 999_999_990) {
    errors.push(`판매가가 상한(999,999,990원)을 넘습니다 (현재 ${input.salePrice}원).`);
  }

  // 재고
  if (!Number.isInteger(input.stockQuantity)) errors.push("재고 수량이 정수가 아닙니다.");
  else if (input.stockQuantity < 1) errors.push("재고 수량이 1 미만입니다.");

  // 대표 이미지
  if (!input.representativeImageUrl) {
    errors.push("대표 이미지가 없습니다 — 이미지 없는 상품은 등록할 수 없습니다.");
  } else if (input.isLive && !NAVER_TRUSTED_HOST_RE.test(input.representativeImageUrl)) {
    errors.push("대표 이미지가 네이버에 업로드된 URL 이 아닙니다.");
  }

  // 추가 이미지
  if (input.isLive) {
    const foreign = input.optionalImageUrls.filter((url) => !NAVER_TRUSTED_HOST_RE.test(url));
    if (foreign.length > 0) {
      errors.push(`추가 이미지 ${foreign.length}장이 네이버에 업로드된 URL 이 아닙니다.`);
    }
  }
  if (input.optionalImageUrls.length > 9) {
    warnings.push(`추가 이미지가 9장을 넘어 앞 9장만 등록합니다 (현재 ${input.optionalImageUrls.length}장).`);
  }

  // 상세
  const detail = input.detailContent;
  if (!detail || (!detail.includes("<img") && !/>[^<>]+</.test(detail))) {
    errors.push("상세페이지 내용이 비어 있습니다.");
  }
  if (detail && FORBIDDEN_TAG_RE.test(detail)) {
    errors.push("상세페이지에 모바일 렌더를 깨뜨리는 금지 태그가 있습니다 (a/iframe/script/style/form/table).");
  }

  // 원산지
  if (input.origin.needsReview || !input.origin.originAreaInfo) {
    errors.push(`원산지를 확정하지 못했습니다: ${input.origin.reviewReason ?? "원산지 정보 없음"}`);
  }
  warnings.push(...input.origin.warnings);

  // KC
  if (input.kc.blocking) {
    errors.push(input.kc.blockReason ?? "KC 인증 요건을 충족하지 못했습니다.");
  }
  warnings.push(...input.kc.warnings);

  // 태그
  if (input.tags.restrictedRemoved.length > 0) {
    warnings.push(`제한 태그 ${input.tags.restrictedRemoved.length}개를 제외했습니다.`);
  }
  if (!input.tags.dictionaryChecked) {
    warnings.push("태그 정규화 적용 — 공식 사전 대조 미완.");
  }

  // 고시
  if (input.notice.typeUnconfirmed) {
    warnings.push("고시 유형 미확인 — 기타 재화로 등록합니다.");
  }
  if (input.notice.usedFallbackType) {
    warnings.push("고시 유형 조회에 실패해 기타 재화로 등록합니다.");
  }

  // 설정
  if (input.isLive) {
    errors.push(...validateSellerConfigForLive(input.config));
  }
  warnings.push(...sellerConfigWarningsForLive(input.config));

  const uniqueErrors = [...new Set(errors.filter(Boolean))];
  return {
    errors: uniqueErrors,
    warnings: [...new Set(warnings.filter(Boolean))],
    publishAllowed: uniqueErrors.length === 0,
  };
}
