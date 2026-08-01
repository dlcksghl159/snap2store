import { hasCommerceCredentials } from "../env.js";
import { CommerceApiError, ShoppingSearchUnavailableError } from "../commerce/errors.js";
import { searchCatalogModels } from "../commerce/client.js";
import type { ShoppingSearchItem } from "../../src/domain/types";

/**
 * 유사상품(comps) 검색 — 네이버 카탈로그에 등록된 실제 상품 모델.
 *
 * ⚠ 이 소스에는 가격 필드가 없다. 시세 분포 엔진은 이 소스로 동작하지 않는다 —
 *    가격은 에이전트 추정을 공식 경로로 삼는다 (05-materials §5).
 *
 * ⚠ 장애를 빈 결과로 위장하지 않는다. 자격증명 없음 / 401·403 / 전송 실패는
 *    ShoppingSearchUnavailableError 로 던진다 — "정당하게 0건"과 구분되어야
 *    상위 폴백이 올바르게 동작한다.
 */
export async function searchComparableListings(
  query: string,
  size = 30,
): Promise<ShoppingSearchItem[]> {
  if (!hasCommerceCredentials()) {
    throw new ShoppingSearchUnavailableError("커머스 API 자격증명이 없습니다.");
  }
  const trimmed = query.trim();
  if (!trimmed) return [];

  let models;
  try {
    models = await searchCatalogModels(trimmed, size);
  } catch (error) {
    if (error instanceof CommerceApiError && (error.status === 401 || error.status === 403)) {
      throw new ShoppingSearchUnavailableError(`인증 거부 (${error.status})`);
    }
    if (error instanceof CommerceApiError) {
      throw new ShoppingSearchUnavailableError(`API ${error.status}${error.code ? ` ${error.code}` : ""}`);
    }
    throw new ShoppingSearchUnavailableError(error instanceof Error ? error.message : String(error));
  }

  return models.map((model) => ({
    title: (model.name ?? "").trim(),
    categoryPath: (model.wholeCategoryName ?? "")
      .split(">")
      .map((part) => part.trim())
      .filter(Boolean),
    categoryId: model.categoryId ? String(model.categoryId) : null,
    brandName: model.brandName?.trim() || null,
    manufacturerName: model.manufacturerName?.trim() || null,
    // 카탈로그 모델 응답에는 가격이 없다.
    price: null,
    link: null,
  }));
}
