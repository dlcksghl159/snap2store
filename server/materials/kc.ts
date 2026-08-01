import { fetchCategoryDetail, type NaverCategoryDetail } from "../commerce/client.js";
import type { SellerConfig } from "../seller-config.js";
import type { KcResolution } from "../../src/domain/types";

export interface KcCategoryStatus {
  kcRequired: boolean;
  childCertificationRequired: boolean;
  greenCertificationRequired: boolean;
  /** detail === null (조회 실패). "대상 아님"과 절대 동일시하지 않는다. */
  unknown: boolean;
}

export function resolveKcCategoryStatus(detail: NaverCategoryDetail | null): KcCategoryStatus {
  if (!detail) {
    return {
      kcRequired: false,
      childCertificationRequired: false,
      greenCertificationRequired: false,
      unknown: true,
    };
  }
  // ⚠ KC 대상 여부는 오직 exceptionalCategories 플래그로 판정한다.
  //    certificationInfos 는 카테고리별 목록이 아니라 전역 인증 유형 사전(약 58종)이다.
  const flags = new Set(detail.exceptionalCategories ?? []);
  return {
    kcRequired: flags.has("KC_CERTIFICATION"),
    childCertificationRequired: flags.has("CHILD_CERTIFICATION"),
    greenCertificationRequired: flags.has("GREEN_PRODUCTS"),
    unknown: false,
  };
}

const SAFE_CRITERION_WARNING =
  "KC 안전관리대상 카테고리 — 판매자 정책에 따라 '안전기준 준수'로 자동 신고하고 등록합니다. 인증번호 입력 시 인증 등록으로 전환됩니다 (오적용의 법적 책임은 판매자에게 있습니다).";

const CHILD_FALLBACK_WARNING =
  "어린이제품 안전관리대상 카테고리 — '안전기준 준수' 특례가 불가능해 '안전관리대상 아님'으로 신고하고 등록합니다. 인증번호 입력 시 인증 등록으로 전환됩니다 (오적용의 법적 책임은 판매자에게 있습니다).";

export interface KcInput {
  categoryId: string | null;
  config: SellerConfig;
  certificationNumber?: string | null;
  /** 테스트 주입용. */
  detail?: NaverCategoryDetail | null;
  fetchDetail?: (categoryId: string) => Promise<NaverCategoryDetail | null>;
}

export function decideKc(
  status: KcCategoryStatus,
  config: SellerConfig,
  certificationNumber: string | null,
  certificationInfoId: number | null,
  certificationName: string | null,
): KcResolution {
  const warnings: string[] = [];

  // ⚠ 모든 비차단 분기가 이 필드를 공유하도록 분기보다 먼저 계산한다
  //    (형제 분기 간 페이로드 누락 사고 방지).
  const greenField = status.greenCertificationRequired ? {} : { greenCertifiedProductExclusionYn: true };

  if (status.unknown) {
    warnings.push(
      "카테고리 인증 정보를 조회하지 못했습니다 — 인증 필드를 생략하고 등록을 시도합니다 (근거 없이 '대상 아님'을 주장하지 않습니다).",
    );
    return {
      status: "unknown",
      statusLabel: "인증 대상 확인 실패",
      blocking: false,
      blockReason: null,
      certificationTargetExcludeContent: null,
      productCertificationInfos: [],
      warnings,
    };
  }

  const trimmedNumber = certificationNumber?.trim() || null;

  if (status.childCertificationRequired) {
    if (trimmedNumber || config.kc.undocumentedPolicy === "review") {
      if (trimmedNumber) {
        return {
          status: "certified",
          statusLabel: "어린이제품 인증 등록",
          blocking: false,
          blockReason: null,
          certificationTargetExcludeContent: {
            kcCertifiedProductExclusionYn: "FALSE",
            childCertifiedProductExclusionYn: false,
            ...greenField,
          },
          productCertificationInfos: [
            {
              ...(certificationInfoId != null ? { certificationInfoId } : {}),
              certificationKindType: "KC_CERTIFICATION",
              name: certificationName ?? "어린이제품 안전 인증",
              certificationNumber: trimmedNumber,
            },
          ],
          warnings,
        };
      }
      return {
        status: "child_fallback",
        statusLabel: "어린이제품 인증 보류",
        blocking: true,
        blockReason:
          "어린이제품 안전관리대상 카테고리인데 인증 정보가 없고 판매자 정책이 '검토'입니다 — 인증번호가 필요합니다.",
        certificationTargetExcludeContent: null,
        productCertificationInfos: [],
        warnings,
      };
    }
    warnings.push(CHILD_FALLBACK_WARNING);
    return {
      status: "child_fallback",
      statusLabel: "어린이제품 — 안전관리대상 아님 신고",
      blocking: false,
      blockReason: null,
      certificationTargetExcludeContent: {
        kcCertifiedProductExclusionYn: "TRUE",
        childCertifiedProductExclusionYn: true,
        ...greenField,
      },
      productCertificationInfos: [],
      warnings,
    };
  }

  if (!status.kcRequired) {
    return {
      status: "not_target",
      statusLabel: "KC 안전관리대상 아님",
      blocking: false,
      blockReason: null,
      certificationTargetExcludeContent: {
        kcCertifiedProductExclusionYn: "TRUE",
        childCertifiedProductExclusionYn: true,
        ...greenField,
      },
      productCertificationInfos: [],
      warnings,
    };
  }

  if (trimmedNumber) {
    return {
      status: "certified",
      statusLabel: "KC 인증 등록",
      blocking: false,
      blockReason: null,
      certificationTargetExcludeContent: {
        kcCertifiedProductExclusionYn: "FALSE",
        childCertifiedProductExclusionYn: true,
        ...greenField,
      },
      productCertificationInfos: [
        {
          ...(certificationInfoId != null ? { certificationInfoId } : {}),
          certificationKindType: "KC_CERTIFICATION",
          name: certificationName ?? "KC 인증",
          certificationNumber: trimmedNumber,
        },
      ],
      warnings,
    };
  }

  if (config.kc.undocumentedPolicy === "review") {
    return {
      status: "safe_criterion",
      statusLabel: "KC 인증 보류",
      blocking: true,
      blockReason:
        "KC 안전관리대상 카테고리인데 인증 정보가 없고 판매자 정책이 '검토'입니다 — 인증번호가 필요합니다.",
      certificationTargetExcludeContent: null,
      productCertificationInfos: [],
      warnings,
    };
  }

  // 판매자 센터 UI 에 "KC인증 없음 → 안전기준 준수" 선택지가 실제로 존재한다.
  // 그 선택을 자동화한 것이므로 사실 날조가 아니다. 다만 반드시 경고로 기록한다.
  warnings.push(SAFE_CRITERION_WARNING);
  return {
    status: "safe_criterion",
    statusLabel: "KC 안전기준 준수 자동 신고",
    blocking: false,
    blockReason: null,
    certificationTargetExcludeContent: {
      kcCertifiedProductExclusionYn: "KC_EXEMPTION_OBJECT",
      kcExemptionType: "SAFE_CRITERION",
      childCertifiedProductExclusionYn: true,
      ...greenField,
    },
    productCertificationInfos: [],
    warnings,
  };
}

export async function resolveKc(input: KcInput): Promise<KcResolution> {
  let detail: NaverCategoryDetail | null = input.detail ?? null;
  if (!detail && input.categoryId) {
    const fetcher = input.fetchDetail ?? fetchCategoryDetail;
    try {
      detail = await fetcher(input.categoryId);
    } catch {
      detail = null;
    }
  }

  const status = resolveKcCategoryStatus(detail);

  // kindTypes 에 KC_CERTIFICATION 이 포함된 항목만 선택지로 쓴다.
  const kcInfo =
    detail?.certificationInfos?.find((info) => (info.kindTypes ?? []).includes("KC_CERTIFICATION")) ?? null;

  return decideKc(
    status,
    input.config,
    input.certificationNumber ?? null,
    kcInfo?.id ?? null,
    kcInfo?.name ?? null,
  );
}
