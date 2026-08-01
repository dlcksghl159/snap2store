import { searchOriginAreas } from "../commerce/client.js";
import { hasCommerceCredentials } from "../env.js";
import type { SellerConfig } from "../seller-config.js";
import type { OriginResolution } from "../../src/domain/types";

export interface OriginRule {
  label: string;
  pattern: RegExp;
  /** 원산지 검색 API 에 넣을 질의명 (순서대로 시도). */
  queries: string[];
  domestic?: boolean;
}

/** ⚠ 인도네시아를 인도보다 먼저 둔다 — 순서가 오분류를 만든다. */
export const ORIGIN_RULES: OriginRule[] = [
  {
    label: "국산",
    // ⚠ `국산` 은 앞에 한글이 붙지 않을 때만 국산이다.
    //    이 경계가 없으면 "중국산"·"미국산"·"영국산"이 전부 국산으로 분류된다.
    pattern: /made\s*in\s*korea|대한민국|한국산|(?<![가-힣])국산|국내\s*생산/i,
    queries: ["국산", "대한민국"],
    domestic: true,
  },
  { label: "중국", pattern: /made\s*in\s*china|중국산|중국|中国|中國/i, queries: ["중국"] },
  { label: "베트남", pattern: /made\s*in\s*vietnam|베트남/i, queries: ["베트남"] },
  { label: "일본", pattern: /made\s*in\s*japan|일본산|일본/i, queries: ["일본"] },
  { label: "대만", pattern: /made\s*in\s*taiwan|대만/i, queries: ["대만"] },
  {
    label: "미국",
    pattern: /made\s*in\s*(the\s*)?u\.?s\.?a?\.?(\s|$)|미국산|미국/i,
    queries: ["미국"],
  },
  { label: "인도네시아", pattern: /made\s*in\s*indonesia|인도네시아/i, queries: ["인도네시아"] },
  { label: "태국", pattern: /made\s*in\s*thailand|태국/i, queries: ["태국"] },
  { label: "인도", pattern: /made\s*in\s*india|인도(?!네시아)/i, queries: ["인도"] },
  { label: "독일", pattern: /made\s*in\s*germany|독일/i, queries: ["독일"] },
  { label: "이탈리아", pattern: /made\s*in\s*italy|이탈리아/i, queries: ["이탈리아"] },
  { label: "프랑스", pattern: /made\s*in\s*france|프랑스/i, queries: ["프랑스"] },
  { label: "말레이시아", pattern: /made\s*in\s*malaysia|말레이시아/i, queries: ["말레이시아"] },
  { label: "필리핀", pattern: /made\s*in\s*philippines|필리핀/i, queries: ["필리핀"] },
  { label: "캄보디아", pattern: /made\s*in\s*cambodia|캄보디아/i, queries: ["캄보디아"] },
  { label: "방글라데시", pattern: /made\s*in\s*bangladesh|방글라데시/i, queries: ["방글라데시"] },
  { label: "미얀마", pattern: /made\s*in\s*myanmar|미얀마/i, queries: ["미얀마"] },
  {
    label: "튀르키예",
    pattern: /made\s*in\s*turkey|t(ü|u)rkiye|튀르키예|터키/i,
    queries: ["튀르키예", "터키"],
  },
];

const CHINA_SAFE_CODE = "0200037";

export function matchOriginCountry(marking: string | null | undefined): OriginRule | null {
  const value = (marking ?? "").trim();
  if (!value) return null;
  return ORIGIN_RULES.find((rule) => rule.pattern.test(value)) ?? null;
}

/** 사전 규칙에 없는 자유 입력은 20자 이하 + 연속 공백 없음일 때만 직접 해석을 시도한다. */
export function isSearchableFreeInput(marking: string): boolean {
  const value = marking.trim();
  return value.length > 0 && value.length <= 20 && !/\s{2,}/.test(value);
}

export interface OriginInput {
  marking: string | null;
  config: SellerConfig;
  sellerOverride?: { originAreaCode?: string | null; content?: string | null } | null;
  /** 테스트 주입용. */
  search?: (name: string) => Promise<Array<{ code: string; name: string }>>;
}

function configResolution(config: SellerConfig, source: OriginResolution["source"], warnings: string[]): OriginResolution {
  const domestic = config.origin.originAreaCode === "00" || config.origin.content.includes("국산");
  return {
    resolved: true,
    needsReview: false,
    reviewReason: null,
    countryLabel: config.origin.content,
    domestic,
    originAreaInfo: {
      originAreaCode: config.origin.originAreaCode,
      content: config.origin.content,
      // domestic 이면 importer 를 넣지 않는다.
      ...(domestic ? {} : { importer: config.origin.importer }),
    },
    source,
    warnings,
  };
}

export async function resolveOrigin(input: OriginInput): Promise<OriginResolution> {
  const { config } = input;
  const warnings: string[] = [];
  const search = input.search ?? searchOriginAreas;

  // 판매자 해소 입력이 최우선.
  const override = input.sellerOverride;
  if (override?.originAreaCode) {
    const domestic = override.originAreaCode === "00";
    return {
      resolved: true,
      needsReview: false,
      reviewReason: null,
      countryLabel: override.content ?? null,
      domestic,
      originAreaInfo: {
        originAreaCode: override.originAreaCode,
        content: override.content ?? config.origin.content,
        ...(domestic ? {} : { importer: config.origin.importer }),
      },
      source: "seller_input",
      warnings,
    };
  }

  // fixed — 판별·API 왕복 없이 항상 설정값으로 등록한다.
  if (config.origin.mode === "fixed") {
    return configResolution(config, "config", warnings);
  }

  const rule = matchOriginCountry(input.marking);
  const freeInput =
    !rule && input.marking && isSearchableFreeInput(input.marking) ? input.marking.trim() : null;

  if (!rule && !freeInput) {
    if (config.origin.fallbackPolicy === "default") {
      warnings.push("원산지 표기를 판독하지 못해 판매자 설정 기본값으로 진행합니다.");
      return configResolution(config, "config", warnings);
    }
    return {
      resolved: false,
      needsReview: true,
      reviewReason: "원산지 표기를 판독하지 못했습니다.",
      countryLabel: null,
      domestic: false,
      originAreaInfo: null,
      source: "label",
      warnings,
    };
  }

  const queries = rule ? rule.queries : [freeInput!];
  const label = rule ? rule.label : freeInput!;
  const domestic = Boolean(rule?.domestic);

  if (hasCommerceCredentials()) {
    for (const query of queries) {
      try {
        const results = await search(query);
        if (results.length > 0) {
          return {
            resolved: true,
            needsReview: false,
            reviewReason: null,
            countryLabel: label,
            domestic,
            originAreaInfo: {
              originAreaCode: results[0].code,
              content: label,
              ...(domestic ? {} : { importer: config.origin.importer }),
            },
            source: rule ? "label" : "search",
            warnings,
          };
        }
      } catch (error) {
        warnings.push(
          `원산지 코드 조회 실패 ("${query}"): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // 중국 코드 조회에 실패하면 안전 폴백.
  if (rule?.label === "중국") {
    warnings.push("중국 원산지 코드 조회에 실패해 알려진 코드로 진행합니다.");
    return {
      resolved: true,
      needsReview: false,
      reviewReason: null,
      countryLabel: "중국",
      domestic: false,
      originAreaInfo: { originAreaCode: CHINA_SAFE_CODE, content: "중국", importer: config.origin.importer },
      source: "label",
      warnings,
    };
  }
  if (rule?.domestic) {
    warnings.push("국산 원산지 코드 조회에 실패해 알려진 코드로 진행합니다.");
    return {
      resolved: true,
      needsReview: false,
      reviewReason: null,
      countryLabel: "국산",
      domestic: true,
      originAreaInfo: { originAreaCode: "00", content: "국산" },
      source: "label",
      warnings,
    };
  }

  if (config.origin.fallbackPolicy === "default") {
    warnings.push(`원산지("${label}") 코드를 찾지 못해 판매자 설정 기본값으로 진행합니다.`);
    return configResolution(config, "config", warnings);
  }

  return {
    resolved: false,
    needsReview: true,
    reviewReason: `원산지("${label}") 코드를 찾지 못했습니다.`,
    countryLabel: label,
    domestic,
    originAreaInfo: null,
    source: "label",
    warnings,
  };
}
