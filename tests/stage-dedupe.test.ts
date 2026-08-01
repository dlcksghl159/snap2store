import { describe, expect, it } from "vitest";
import { applyEvent, initialDerived, type ControlDerived } from "../src/stage-model.js";
import type { LiveEvent } from "../src/domain/types.js";

/**
 * 실런은 같은 산출물을 다시 뱉는다 — 이미지 재시도, 도구 재호출, 링버퍼 재방송.
 * 그때마다 리빌 카드가 또 생기면 이미 걸린 내용이 "장착 대기"로 숨었다 나타나기를
 * 반복한다(깜빡임). 여기서는 "카드는 슬롯당 처음 한 번, 값은 조용히 갱신"을 잠근다.
 */

function live(seq: number, channel: string, label: string, payload: unknown): LiveEvent {
  return { seq, at: "2026-08-01T00:00:00.000Z", listingId: "L", channel, label, payload };
}

function shotDone(seq: number, index: number, url: string): LiveEvent {
  return live(seq, "image", "image.shot_completed", {
    index,
    url,
    kind: index === 0 ? "main_studio" : "lifestyle",
    tookMs: 1000,
  });
}

describe("실런 재방출 내성 — 같은 슬롯의 리빌은 반복되지 않는다", () => {
  it("같은 index 샷 재완료는 URL 만 교체하고 카드를 만들지 않는다", () => {
    let state = applyEvent(initialDerived, shotDone(1, 0, "u1"));
    const cardsAfterFirst = state.cards.length;
    expect(cardsAfterFirst).toBe(1);

    state = applyEvent(state, shotDone(2, 0, "u2"));
    expect(state.cards.length).toBe(cardsAfterFirst);
    expect(state.shots).toHaveLength(1);
    expect(state.shots[0].url).toBe("u2");
    // 완료 수는 계속 센다 — 갤러리 순서 게이트(expectedOrders)가 영영 안 풀리면 안 된다.
    expect(state.shotDone).toBe(2);
  });

  it("같은 URL 재방송도 카드 없이 완료 수만 센다", () => {
    let state = applyEvent(initialDerived, shotDone(1, 1, "same"));
    state = applyEvent(state, shotDone(2, 1, "same"));
    expect(state.cards).toHaveLength(1);
    expect(state.shots).toHaveLength(1);
    expect(state.shotDone).toBe(2);
  });

  it("resolve_category 재호출·재결과는 값만 갱신하고 카드는 한 번만 만든다", () => {
    const call = (seq: number, group: string) =>
      live(seq, "tool_call", "resolve_category", {
        arguments: JSON.stringify({ productGroupName: group, productSummary: "" }),
      });
    const result = (seq: number, path: string, outcome: string) =>
      live(seq, "tool_result", "resolve_category", {
        output: { categoryPath: path, outcome, verificationRounds: 1, comparableListings: 3 },
      });

    let state: ControlDerived = applyEvent(initialDerived, call(1, "노트북 거치대"));
    state = applyEvent(state, call(2, "노트북 받침대"));
    expect(state.cards.filter((card) => card.slot === "title")).toHaveLength(1);
    expect(state.productGroup).toBe("노트북 받침대");

    state = applyEvent(state, result(3, "가전>거치대", "review_required"));
    state = applyEvent(state, result(4, "가전>받침대", "verified"));
    expect(state.cards.filter((card) => card.slot === "crumb")).toHaveLength(1);
    expect(state.categoryPath).toBe("가전>받침대");
    expect(state.categoryVerified).toBe(true);
  });

  it("같은 index 패널 재완료는 교체만 하고 카드를 만들지 않는다", () => {
    const panel = (seq: number, index: number, url: string) =>
      live(seq, "milestone", "image.panel_completed", { index, url, role: "hook", headline: "H", total: 6 });

    let state = applyEvent(initialDerived, panel(1, 2, "p1"));
    state = applyEvent(state, panel(2, 2, "p2"));
    expect(state.cards.filter((card) => card.slot === "panel-2")).toHaveLength(1);
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0].url).toBe("p2");
  });

  it("재료 생산 완료 재방송은 상품명·필수표시 카드를 다시 만들지 않는다", () => {
    const materials = (seq: number, price: number) =>
      live(seq, "milestone", "재료 생산 완료", {
        seoTitle: "노트북 거치대 알루미늄",
        titleStrategy: "accuracy",
        tagCount: 8,
        attributeCount: 3,
        kcStatus: "not_target",
        noticeType: "기타 재화",
        originResolved: true,
        salePrice: price,
      });

    let state = applyEvent(initialDerived, materials(1, 19900));
    const titleCards = state.cards.filter((card) => card.slot === "title").length;
    const metaCards = state.cards.filter((card) => card.slot === "meta").length;

    state = applyEvent(state, materials(2, 18900));
    expect(state.cards.filter((card) => card.slot === "title")).toHaveLength(titleCards);
    expect(state.cards.filter((card) => card.slot === "meta")).toHaveLength(metaCards);
    expect(state.price).toBe(18900);
  });

  it("기획 재완료는 내용만 갱신하고 plan 카드는 한 번만", () => {
    const plan = (seq: number, concept: string) =>
      live(seq, "milestone", "detail.plan_completed", {
        concept,
        angle: "각도",
        panelCount: 4,
        sections: [{ role: "hook", heading: "h", hasPanel: true }],
      });

    let state = applyEvent(initialDerived, plan(1, "첫 기획"));
    state = applyEvent(state, plan(2, "재기획"));
    expect(state.cards.filter((card) => card.slot === "plan")).toHaveLength(1);
    expect(state.plan?.concept).toBe("재기획");
  });

  it("가격 재조회는 값만 갱신하고 price 카드는 한 번만", () => {
    const result = (seq: number, price: number) =>
      live(seq, "tool_result", "research_market_price", {
        output: { salePriceKrw: price, sampleSize: 5, basis: "표본" },
      });

    let state = applyEvent(initialDerived, result(1, 20000));
    state = applyEvent(state, result(2, 21000));
    expect(state.cards.filter((card) => card.slot === "price")).toHaveLength(1);
    expect(state.price).toBe(21000);
  });
});
