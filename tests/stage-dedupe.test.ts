import { describe, expect, it } from "vitest";
import { applyEvent, initialDerived, type ControlDerived } from "../src/stage-model.js";
import { collectRevealables } from "../src/Assembly.js";
import type { ListingRecord, LiveEvent } from "../src/domain/types.js";

/**
 * 실런은 같은 산출물을 다시 뱉는다 — 이미지 재시도, 도구 재호출, 링버퍼 재방송.
 * 리빌은 파생 상태에서 **키로** 계산되므로, 재방출이 새 키를 만들지 않는 한
 * 이미 장착된 칸이 "대기"로 숨었다 다시 나타나는 깜빡임은 생길 수 없다.
 * 여기서 잠그는 것은 그 키 안정성이다.
 */

const LISTING = {
  id: "L",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  status: "running",
  stage: "vision",
  stageLabel: "사진을 읽고 있습니다",
  progress: 8,
  photoUrls: [],
  photoPaths: [],
  sellerNote: null,
  draft: null,
  materials: null,
  publication: null,
  blockReasons: [],
  warnings: [],
  error: null,
  events: [],
} as unknown as ListingRecord;

function live(seq: number, channel: string, label: string, payload: unknown): LiveEvent {
  return { seq, at: "2026-08-01T00:00:00.000Z", listingId: "L", channel, label, payload };
}

function keys(state: ControlDerived): string[] {
  return collectRevealables(state, LISTING).map((item) => item.key);
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
  it("같은 index 샷 재완료는 URL 만 교체하고 리빌 키를 늘리지 않는다", () => {
    let state = applyEvent(initialDerived, shotDone(1, 0, "u1"));
    expect(keys(state)).toEqual(["shot-0"]);

    state = applyEvent(state, shotDone(2, 0, "u2"));
    expect(keys(state)).toEqual(["shot-0"]);
    expect(state.shots).toHaveLength(1);
    expect(state.shots[0].url).toBe("u2");
    // 완료 수는 계속 센다 — 스트립의 연출 이미지 단계 판정이 이 수를 본다.
    expect(state.shotDone).toBe(2);
  });

  it("샷은 완성된 순서대로 앞칸부터 쌓이고, 늦게 온 앞 번호가 자리를 빼앗지 않는다", () => {
    // 실런 실측: 대표(index 0)가 44.8초로 꼴찌였다. index 로 정렬하면 이미 걸린
    // 사진이 옆 칸으로 밀려난다 — 관객이 가장 싫어한 움직임.
    let state = applyEvent(initialDerived, shotDone(1, 2, "first"));
    const firstSlot = collectRevealables(state, LISTING).find((item) => item.key === "shot-2")?.slot;
    expect(firstSlot).toBe("thumb");

    state = applyEvent(state, shotDone(2, 1, "second"));
    state = applyEvent(state, shotDone(3, 0, "last"));
    const shots = collectRevealables(state, LISTING).filter((item) => item.key.startsWith("shot-"));
    expect(shots.map((item) => [item.key, item.slot])).toEqual([
      ["shot-2", "thumb"],
      ["shot-1", "gallery-0"],
      ["shot-0", "gallery-1"],
    ]);
  });

  it("resolve_category 재호출·재결과는 값만 갱신하고 키는 그대로다", () => {
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
    // 상품군은 리빌 대상이 아니다 — 상품명이 앉은 뒤 뱃지로만 붙는다.
    expect(keys(state)).toEqual([]);
    expect(state.productName).toBe("노트북 받침대");

    state = applyEvent(state, result(3, "가전>거치대", "review_required"));
    state = applyEvent(state, result(4, "가전>받침대", "verified"));
    expect(keys(state)).toEqual(["category"]);
    expect(state.categoryPath).toBe("가전>받침대");
    expect(state.categoryVerified).toBe(true);
  });

  const panelEvent = (seq: number, index: number, url: string, total = 6) =>
    live(seq, "milestone", "image.panel_completed", {
      index,
      url,
      role: "hook",
      headline: `H${index}`,
      total,
    });

  it("상세 패널은 전부 완성된 뒤 한 덱으로만 리빌한다", () => {
    // 도착 순서(6→3→5→…)를 그대로 노출하면 본문 흐름이 끊긴다.
    let state = applyEvent(initialDerived, panelEvent(1, 5, "p5"));
    state = applyEvent(state, panelEvent(2, 2, "p2"));
    expect(keys(state)).not.toContain("panels-deck");

    for (const index of [0, 4, 1, 3]) {
      state = applyEvent(state, panelEvent(10 + index, index, `p${index}`));
    }
    // 카드는 하나(덱)이고, 그 안의 순서와 장착 대상은 서사 순서다.
    const deck = collectRevealables(state, LISTING).find((item) => item.key === "panels-deck");
    expect(deck).toBeDefined();
    expect(deck!.docks).toEqual([
      "panel-0",
      "panel-1",
      "panel-2",
      "panel-3",
      "panel-4",
      "panel-5",
    ]);
    const content = deck!.content as { type: "panels"; panels: Array<{ index: number }> };
    expect(content.panels.map((panel) => panel.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("같은 index 패널 재완료는 교체만 하고 키를 늘리지 않는다", () => {
    let state = initialDerived;
    for (let index = 0; index < 6; index += 1) {
      state = applyEvent(state, panelEvent(index + 1, index, `p${index}`));
    }
    const before = keys(state);
    state = applyEvent(state, panelEvent(99, 2, "retry"));
    expect(keys(state)).toEqual(before);
    expect(before.filter((key) => key === "panels-deck")).toHaveLength(1);
    expect(state.panels).toHaveLength(6);
    expect(state.panels.find((panel) => panel.index === 2)?.url).toBe("retry");
  });

  it("상세 기획 문구는 리빌 대상이 아니다 — 틀의 제자리에 써진다", () => {
    const state = applyEvent(
      initialDerived,
      live(1, "milestone", "detail.plan_completed", {
        concept: "손에 잡히는 하루의 시작",
        angle: "각도",
        panelCount: 6,
        sections: [{ role: "hook", heading: "h", hasPanel: true }],
      }),
    );
    expect(state.plan?.concept).toBe("손에 잡히는 하루의 시작");
    expect(keys(state)).not.toContain("plan");
  });

  it("재료 생산 완료 재방송은 상품명·필수표시 리빌을 다시 만들지 않는다", () => {
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
    const first = keys(state);
    expect(first).toContain("title-final");
    expect(first).toContain("meta");

    state = applyEvent(state, materials(2, 18900));
    expect(keys(state)).toEqual(first);
    expect(state.price).toBe(18900);
  });

  it("기획 재완료는 내용만 갱신한다", () => {
    const plan = (seq: number, concept: string) =>
      live(seq, "milestone", "detail.plan_completed", {
        concept,
        angle: "각도",
        panelCount: 4,
        sections: [{ role: "hook", heading: "h", hasPanel: true }],
      });

    let state = applyEvent(initialDerived, plan(1, "첫 기획"));
    state = applyEvent(state, plan(2, "재기획"));
    expect(state.plan?.concept).toBe("재기획");
    expect(keys(state)).toEqual([]);
  });

  it("가격은 재료가 끝난 뒤에야 말한다 — 정가·할인이 함께 정해지기 때문", () => {
    const result = (seq: number, price: number) =>
      live(seq, "tool_result", "research_market_price", {
        output: { salePriceKrw: price, sampleSize: 5, basis: "표본" },
      });

    let state = applyEvent(initialDerived, result(1, 20000));
    state = applyEvent(state, result(2, 21000));
    // 시세 조회 결과만으로는 아직 등록될 값이 아니다 — 리빌하지 않는다.
    expect(keys(state)).toEqual([]);
    expect(state.price).toBe(21000);

    state = applyEvent(
      state,
      live(3, "milestone", "재료 생산 완료", {
        salePrice: 21000,
        listPrice: 24800,
        discountRate: 15,
        tagCount: 8,
      }),
    );
    const price = collectRevealables(state, LISTING).find((item) => item.key === "price");
    // 할인을 걸 런에서는 **정가**를 먼저 말한다. 할인가는 등록 직전 박자에서.
    expect(price?.content).toEqual({ type: "price", value: 24800 });

    /*
      할인 박자는 아직 나오지 않는다 — 재료가 끝난 것과 스토어로 넘어가는 것은 다르다.
      재료가 하나씩 도착하게 된 뒤로 이 구분이 실제 시간 차이를 만든다.
    */
    expect(keys(state)).not.toContain("discount");

    state = applyEvent(state, live(4, "status", "규정을 검증하는 중입니다", {
      stage: "validation",
      progress: 74,
    }));
    expect(keys(state)).toContain("discount");
  });

  it("종착하면 할인 박자는 스테이지 이벤트 없이도 열린다", () => {
    const state = applyEvent(
      initialDerived,
      live(1, "milestone", "재료 생산 완료", {
        salePrice: 21000,
        listPrice: 24800,
        discountRate: 15,
        tagCount: 8,
      }),
    );
    // settled=true — 종착 런을 뒤늦게 열어도 이야기가 닫힌다.
    expect(collectRevealables(state, LISTING, true).map((item) => item.key)).toContain("discount");
  });

  describe("재료 개별 방송 — 한 덩어리로 몰아 오지 않는다", () => {
    it("상품명·태그·가격·필수표시가 각자 도착해 각자 선다", () => {
      let state = applyEvent(
        initialDerived,
        live(1, "milestone", "materials.title_resolved", {
          seoTitle: "접이식 노트북 거치대",
          titleStrategy: "composed",
        }),
      );
      expect(keys(state)).toEqual(["title-final"]);

      state = applyEvent(
        state,
        live(2, "milestone", "materials.price_resolved", {
          salePrice: 21000,
          listPrice: 24800,
          discountRate: 15,
          priceBasis: "표본",
          sampleSize: 5,
        }),
      );
      // priceFinal 이 섰으므로 태그를 기다리지 않고 가격이 선다.
      expect(state.priceFinal).toBe(true);
      expect(keys(state)).toContain("price");

      state = applyEvent(
        state,
        live(3, "milestone", "materials.compliance_resolved", {
          noticeType: "ETC",
          kcStatus: "not_target",
          originResolved: true,
          attributeCount: 3,
        }),
      );
      // 필수 표시는 태그와 다른 갈래다 — 태그 없이도 자기 근거로 선다.
      expect(keys(state)).toContain("meta");
      expect(keys(state)).not.toContain("tags");

      state = applyEvent(state, live(4, "milestone", "materials.tags_resolved", { tagCount: 8 }));
      expect(keys(state)).toContain("tags");
    });

    it("요약 밀스톤은 같은 키를 다시 만들지 않는다 — 늦은 접속만 복구한다", () => {
      const split: LiveEvent[] = [
        live(1, "milestone", "materials.title_resolved", { seoTitle: "T", titleStrategy: "composed" }),
        live(2, "milestone", "materials.tags_resolved", { tagCount: 8 }),
        live(3, "milestone", "materials.price_resolved", {
          salePrice: 21000,
          listPrice: 24800,
          discountRate: 15,
        }),
        live(4, "milestone", "materials.compliance_resolved", {
          noticeType: "ETC",
          kcStatus: "not_target",
          originResolved: true,
          attributeCount: 3,
        }),
      ];
      let state = split.reduce(applyEvent, initialDerived);
      const before = keys(state);

      state = applyEvent(
        state,
        live(5, "milestone", "재료 생산 완료", {
          seoTitle: "T",
          titleStrategy: "composed",
          tagCount: 8,
          salePrice: 21000,
          listPrice: 24800,
          discountRate: 15,
          noticeType: "ETC",
          kcStatus: "not_target",
          originResolved: true,
          attributeCount: 3,
        }),
      );
      expect(keys(state)).toEqual(before);
    });
  });

  it("기획 실패는 기다림을 끝낸다 — 오지 않을 패널을 세지 않는다", () => {
    let state = applyEvent(
      initialDerived,
      live(1, "milestone", "detail.plan_started", { panelTarget: 6 }),
    );
    expect(state.planStarted).toBe(true);
    expect(state.panelTotal).toBe(6);

    state = applyEvent(state, live(2, "milestone", "detail.plan_failed", { reason: "스키마 위반" }));
    expect(state.planFailed).toBe(true);
    expect(state.panelTotal).toBeNull();
    expect(keys(state)).toEqual([]);
  });

  it("상품군은 카드로 뜨지 않고, 상품명은 확정된 것만 한 번 꽂힌다", () => {
    let state = applyEvent(
      initialDerived,
      live(1, "tool_call", "resolve_category", {
        arguments: JSON.stringify({ productGroupName: "노트북 거치대" }),
      }),
    );
    state = applyEvent(
      state,
      live(2, "milestone", "재료 생산 완료", {
        seoTitle: "노트북 거치대 알루미늄 6단 각도조절",
        tagCount: 8,
      }),
    );
    const titleReveals = collectRevealables(state, LISTING).filter((item) => item.slot === "title");
    expect(titleReveals.map((item) => item.key)).toEqual(["title-final"]);
    expect(titleReveals[0].content).toEqual({
      type: "title",
      text: "노트북 거치대 알루미늄 6단 각도조절",
    });
    // 상품군은 파생 상태에 남아 있다 — 틀이 뱃지로 쓴다.
    expect(state.productName).toBe("노트북 거치대");
  });

  it("패널 한 장이 실패해도 종착에서는 있는 만큼 건다", () => {
    let state = initialDerived;
    for (const index of [0, 1, 2, 3, 4]) {
      state = applyEvent(state, panelEvent(index + 1, index, `p${index}`));
    }
    // 진행 중에는 6장을 다 기다린다.
    expect(keys(state)).not.toContain("panels-deck");
    // 종착(settled)에는 5장이라도 건다 — 스트립이 영영 비어 있으면 안 된다.
    const deck = collectRevealables(state, LISTING, true).find((item) => item.key === "panels-deck");
    expect(deck!.docks).toEqual(["panel-0", "panel-1", "panel-2", "panel-3", "panel-4"]);
  });
});
