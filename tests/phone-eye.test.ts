import { describe, expect, it } from "vitest";
import { EYE_TUNING, advanceCharge, countsAsPhone, isPhoneClass } from "../src/phone-eye";

/**
 * 폰 아이의 판정 규칙만 잠근다 — 카메라·모델·wasm 은 여기서 다루지 않는다.
 * (실제 인식률은 실물 폰 앞에서만 판정할 수 있고, 그건 ?eye=1 실험실의 일이다.)
 */

describe("확신 적분", () => {
  it("holdMs 만큼 연속으로 보이면 정확히 가득 찬다", () => {
    let charge = 0;
    // 90ms 주기로 600ms → 마지막 틱에서 1 에 닿아야 한다.
    for (let elapsed = 0; elapsed < EYE_TUNING.holdMs; elapsed += EYE_TUNING.strideMs) {
      charge = advanceCharge(charge, true, EYE_TUNING.strideMs, EYE_TUNING);
    }
    expect(charge).toBeGreaterThanOrEqual(1);
  });

  it("holdMs 의 절반만 보이면 아직 안 찬다 — 스치듯 지나간 폰은 열지 않는다", () => {
    let charge = 0;
    for (let elapsed = 0; elapsed < EYE_TUNING.holdMs / 2; elapsed += EYE_TUNING.strideMs) {
      charge = advanceCharge(charge, true, EYE_TUNING.strideMs, EYE_TUNING);
    }
    expect(charge).toBeLessThan(1);
  });

  /**
   * 적분이 "지난 시간"에만 의존하고 틱 수에는 의존하지 않는다는 계약.
   *
   * 주의 — 실제로 났던 버그는 이 함수가 아니라 **호출부**에 있었다. dt 를 rAF 간격(≈16ms)
   * 으로 재는 바람에 추론을 건너뛴 프레임의 시간이 증발했다. 그 경로는 카메라·모델·rAF 를
   * 전부 흉내 내야 해서 여기서 잠그지 않는다. 이 테스트가 지키는 건 계약이고,
   * 호출부는 phone-eye.ts 의 lastTickAt 주석이 지킨다.
   */
  it("추론 주기를 바꿔도 가득 차는 데 걸리는 시간은 같다", () => {
    const fill = (stride: number) => {
      let charge = 0;
      let elapsed = 0;
      while (charge < 1 && elapsed < 10_000) {
        charge = advanceCharge(charge, true, stride, EYE_TUNING);
        elapsed += stride;
      }
      return elapsed;
    };
    expect(fill(16)).toBeCloseTo(fill(120), -2);
    expect(fill(16)).toBeLessThanOrEqual(EYE_TUNING.holdMs + 16);
  });

  it("사라지면 releaseMs 에 걸쳐 식고, 0 아래로는 안 내려간다", () => {
    let charge = 1;
    charge = advanceCharge(charge, false, EYE_TUNING.releaseMs / 2, EYE_TUNING);
    expect(charge).toBeCloseTo(0.5, 5);
    charge = advanceCharge(charge, false, EYE_TUNING.releaseMs * 5, EYE_TUNING);
    expect(charge).toBe(0);
  });

  it("한 프레임 놓쳐도 확신이 통째로 날아가지 않는다 — 손떨림 내성", () => {
    let charge = 1;
    charge = advanceCharge(charge, false, EYE_TUNING.strideMs, EYE_TUNING);
    expect(charge).toBeGreaterThan(0.85);
  });

  it("1 을 넘겨 쌓이지 않는다 — 계속 들고 있어도 재무장이 즉시 터지지 않게", () => {
    let charge = 0;
    for (let index = 0; index < 500; index += 1) {
      charge = advanceCharge(charge, true, EYE_TUNING.strideMs, EYE_TUNING);
    }
    expect(charge).toBe(1);
  });
});

describe("판정 게이트", () => {
  const big = { score: 0.9, area: 0.2 };

  it("폰 클래스만 센다", () => {
    expect(countsAsPhone({ label: "cell phone", ...big }, EYE_TUNING)).toBe(true);
    expect(countsAsPhone({ label: "remote", ...big }, EYE_TUNING)).toBe(true);
    expect(countsAsPhone({ label: "book", ...big }, EYE_TUNING)).toBe(false);
    expect(countsAsPhone({ label: "person", ...big }, EYE_TUNING)).toBe(false);
  });

  /** 이 규칙이 없으면 책상에 놓인 폰 때문에 페이지를 열자마자 QR 이 튀어나온다. */
  it("멀리 있는(작은) 폰은 확신 있게 잡혀도 세지 않는다", () => {
    expect(
      countsAsPhone({ label: "cell phone", score: 0.95, area: EYE_TUNING.minArea / 2 }, EYE_TUNING),
    ).toBe(false);
  });

  it("크게 보여도 확신이 낮으면 세지 않는다", () => {
    expect(
      countsAsPhone({ label: "cell phone", score: EYE_TUNING.minScore - 0.01, area: 0.3 }, EYE_TUNING),
    ).toBe(false);
  });

  it("문턱은 경계값을 포함한다", () => {
    expect(
      countsAsPhone(
        { label: "cell phone", score: EYE_TUNING.minScore, area: EYE_TUNING.minArea },
        EYE_TUNING,
      ),
    ).toBe(true);
  });

  it("실험실이 문턱을 낮추면 판정도 같이 움직인다", () => {
    const loose = { ...EYE_TUNING, minScore: 0.1, minArea: 0.001 };
    const far = { label: "cell phone", score: 0.15, area: 0.002 };
    expect(countsAsPhone(far, EYE_TUNING)).toBe(false);
    expect(countsAsPhone(far, loose)).toBe(true);
  });

  it("모델 라벨맵의 이름을 그대로 쓴다 (cell_phone 아님)", () => {
    expect(isPhoneClass("cell phone")).toBe(true);
    expect(isPhoneClass("cell_phone")).toBe(false);
    expect(isPhoneClass("cellphone")).toBe(false);
  });
});
