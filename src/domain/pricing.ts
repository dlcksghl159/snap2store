/**
 * 가격 정책 — 서버와 프론트가 **같은 규칙**을 쓴다.
 * 무대가 띄우는 정가·할인율이 등록 페이로드와 한 글자도 어긋나면 안 되므로,
 * 계산은 한 곳에만 둔다 (서버는 여기서 가져다 쓰고, 리허설 드라이버도 같은 함수를 쓴다).
 */

/** 즉시할인 목표율 기본값(%). seller-config 의 기본값이자 리허설 투영의 기준. */
export const DEFAULT_DISCOUNT_RATE = 15;

export interface DiscountPlan {
  /** 정가 — 등록 페이로드의 originProduct.salePrice 가 된다. */
  listPrice: number;
  /** 즉시할인액(원). WON 단위로 거는 이유는 아래 주석 참조. */
  discountKrw: number;
  /** 실제 할인율(%) — 등록되는 두 금액에서 나온 값이지 목표치가 아니다. */
  discountRate: number;
}

/**
 * 즉시할인 설계 — **고객이 내는 값(salePrice)을 고정**하고 정가를 역산해 올린다.
 *
 * 반대로(정가 고정 + 할인 계산) 하면 할인 후 금액이 시세 근거에서 떨어져 나가고,
 * 반품비·상세페이지·결과 화면이 모두 다른 숫자를 말하게 된다.
 *
 * ⚠ 할인은 PERCENT 가 아니라 **WON** 으로 건다. 퍼센트로 걸면 플랫폼 쪽 반올림이
 * 끼어들어 고객가가 몇 원 어긋날 수 있다. 화면에 띄우는 할인율은 등록된 두 금액에서
 * 되계산한 실제값이다 — 목표치(config)를 그대로 보여 주지 않는다.
 */
export function planDiscount(
  salePrice: number,
  options: { targetRate: number; displayUnit: number },
): DiscountPlan | null {
  const target = options.targetRate;
  if (!Number.isFinite(target) || target <= 0 || target >= 100) return null;
  if (!Number.isFinite(salePrice) || salePrice <= 0) return null;

  const unit = Math.max(1, options.displayUnit);
  const listPrice = Math.ceil(salePrice / (1 - target / 100) / unit) * unit;
  const discountKrw = listPrice - salePrice;
  if (discountKrw <= 0) return null;

  const discountRate = Math.round((discountKrw / listPrice) * 100);
  // 1% 미만으로 떨어지면 할인이라 부를 값이 아니다 — 걸지 않는다.
  if (discountRate < 1) return null;
  if (listPrice > 999_999_990) return null;

  return { listPrice, discountKrw, discountRate };
}
