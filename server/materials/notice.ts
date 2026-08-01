import { fetchNoticeTypes, type NaverNoticeTypeInfo } from "../commerce/client.js";
import type { SellerConfig } from "../seller-config.js";
import type { NoticeResolution } from "../../src/domain/types";

/** 고시 타입 → 페이로드 키 매핑 (39종). 알 수 없는 타입은 etc. */
const TYPE_TO_KEY: Record<string, string> = {
  WEAR: "wear",
  SHOES: "shoes",
  BAG: "bag",
  FASHION_ITEMS: "fashionItems",
  SLEEPING_GEAR: "sleepingGear",
  FURNITURE: "furniture",
  IMAGE_APPLIANCES: "imageAppliances",
  HOME_APPLIANCES: "homeAppliances",
  SEASON_APPLIANCES: "seasonAppliances",
  OFFICE_APPLIANCES: "officeAppliances",
  OPTICS_APPLIANCES: "opticsAppliances",
  MICROELECTRONICS: "microElectronics",
  CELLPHONE: "cellPhone",
  NAVIGATION: "navigation",
  CAR_ARTICLES: "carArticles",
  MEDICAL_APPLIANCES: "medicalAppliances",
  KITCHEN_UTENSILS: "kitchenUtensils",
  COSMETIC: "cosmetic",
  JEWELLERY: "jewellery",
  FOOD: "food",
  GENERAL_FOOD: "generalFood",
  DIET_FOOD: "dietFood",
  KIDS: "kids",
  MUSICAL_INSTRUMENT: "musicalInstrument",
  SPORTS_EQUIPMENT: "sportsEquipment",
  BOOKS: "books",
  LODGMENT_RESERVATION: "lodgmentReservation",
  TRAVEL_PACKAGE: "travelPackage",
  AIRLINE_TICKET: "airlineTicket",
  RENT_CAR: "rentCar",
  RENTAL_HA: "rentalHa",
  RENTAL_ETC: "rentalEtc",
  DIGITAL_CONTENTS: "digitalContents",
  GIFT_CARD: "giftCard",
  MOBILE_COUPON: "mobileCoupon",
  MOVIE_SHOW: "movieShow",
  ETC_SERVICE: "etcService",
  BIOCHEMISTRY: "biochemistry",
  BIOCIDAL: "biocidal",
  ETC: "etc",
};

export function noticePayloadKey(type: string): string {
  return TYPE_TO_KEY[type] ?? "etc";
}

const FALLBACK_VALUE = "상세페이지 참조";

export interface NoticeInput {
  categoryId: string | null;
  config: SellerConfig;
  productName: string | null;
  modelName: string | null;
  manufacturerName: string | null;
  importer?: string | null;
}

/** 기본 값 맵 (설정 + 에이전트 사실). */
export function buildBaseValueMap(input: NoticeInput): Record<string, string> {
  const { config } = input;
  return {
    returnCostReason: config.noticeDefaults.returnCostReason,
    noRefundReason: config.noticeDefaults.noRefundReason,
    qualityAssuranceStandard: config.noticeDefaults.qualityAssuranceStandard,
    compensationProcedure: config.noticeDefaults.compensationProcedure,
    troubleShootingContents: config.noticeDefaults.troubleShootingContents,
    itemName: input.productName?.trim() || FALLBACK_VALUE,
    modelName: input.modelName?.trim() || config.product.modelName || FALLBACK_VALUE,
    manufacturer: input.manufacturerName?.trim() || config.product.manufacturer || FALLBACK_VALUE,
    importer: input.importer?.trim() || config.origin.importer || FALLBACK_VALUE,
    afterServiceDirector: config.afterService.director || "판매자 문의",
  };
}

/** 목록에 있는데 값 맵에 없는 필드를 이름 휴리스틱으로 추정한다. */
function guessFieldValue(fieldName: string, base: Record<string, string>): string {
  const key = fieldName.toLowerCase();
  if (/item|product|name/.test(key) && !/model/.test(key)) return base.itemName;
  if (/model/.test(key)) return base.modelName;
  if (/manufacturer|maker/.test(key)) return base.manufacturer;
  if (/importer/.test(key)) return base.importer;
  if (/service|director/.test(key)) return base.afterServiceDirector;
  if (/quality|warranty/.test(key)) return base.qualityAssuranceStandard;
  return FALLBACK_VALUE;
}

export interface ResolveNoticeOptions extends NoticeInput {
  /** 테스트 주입용. */
  fetchTypes?: (categoryId?: string) => Promise<NaverNoticeTypeInfo[]>;
}

/**
 * ⚠ 절대 하지 말 것: 전체 사전 필드를 다 채우는 것.
 * 빈 배열 카테고리에서 ETC 타입 전체 필드 사전을 가져와 전부 채우면
 * "A/S 책임자"와 "소비자 상담 전화"가 동시에 채워져 ExclusiveNotNull 위반으로 등록이 거부된다.
 *
 * ⚠ 빈 배열의 의미 강등: 빈 배열은 "지정 고시 없음"과 "조회 실패"를 구분하지 못한다.
 * ETC 로 진행하되 그 사실을 경고와 typeUnconfirmed 로 남긴다.
 *
 * 고시는 절대 등록을 막지 않는다.
 */
export async function resolveNotice(options: ResolveNoticeOptions): Promise<NoticeResolution> {
  const base = buildBaseValueMap(options);
  const warnings: string[] = [];
  const fetcher = options.fetchTypes ?? fetchNoticeTypes;

  let types: NaverNoticeTypeInfo[] = [];
  let usedFallbackType = false;
  let typeUnconfirmed = false;

  try {
    types = await fetcher(options.categoryId ?? undefined);
  } catch (error) {
    usedFallbackType = true;
    warnings.push(
      `고시 유형 조회에 실패해 기타 재화(ETC)로 등록합니다: ${error instanceof Error ? error.message : String(error)}`,
    );
    types = [];
  }

  if (!usedFallbackType && types.length === 0) {
    typeUnconfirmed = true;
    warnings.push("고시 유형 조회 결과가 비어 있습니다 — 지정 유형을 확인하지 못해 기타 재화(ETC)로 등록합니다.");
  }

  const chosen = types[0] ?? null;
  const noticeType = chosen?.productInfoProvidedNoticeType ?? "ETC";
  const noticeTypeName = chosen?.productInfoProvidedNoticeTypeName ?? null;
  const payloadKey = noticePayloadKey(noticeType);

  const fields = chosen?.productInfoProvidedNoticeContents;
  let values: Record<string, string>;

  if (Array.isArray(fields) && fields.length > 0) {
    // 필드 목록이 있으면 그 필드들만 채운다.
    values = {};
    for (const field of fields) {
      const name = typeof field?.fieldName === "string" ? field.fieldName.trim() : "";
      if (!name) continue;
      values[name] = base[name] ?? guessFieldValue(name, base);
    }
    if (Object.keys(values).length === 0) values = { ...base };
  } else {
    // 필드 목록이 없으면(빈 배열·null) 기본 값 맵만 싣는다.
    values = { ...base };
  }

  return {
    noticeType,
    noticeTypeName,
    payload: {
      productInfoProvidedNoticeType: noticeType,
      [payloadKey]: values,
    },
    usedFallbackType,
    typeUnconfirmed,
    warnings,
  };
}
