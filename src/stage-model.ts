import type { LiveEvent, ListingStage } from "./domain/types";

/**
 * 등록 실황 이벤트 → 파생 상태 리듀서 (순수 로직).
 *
 * Theater(무대 셸)와 Assembly(등록안 틀·리빌 디렉터)가 함께 쓰므로 컴포넌트 없는
 * 모듈로 분리한다. 화면의 모든 값은 /api/stream(SSE) 실이벤트에서만 온다.
 *
 * ⚠ 리듀서는 **사실만** 쌓는다. "무엇을 언제 보여줄지"(리빌 목록·순서)는
 *   Assembly 의 collectRevealables 가 파생 상태에서 통째로 계산한다 —
 *   이벤트 도착 시점에 카드를 만들어 큐에 넣으면 재방출·재시도마다 카드가 늘어나고
 *   순서를 되돌리려고 정렬·인내 타이머를 붙이게 된다 (그 구조가 버그의 근원이었다).
 */

/* ── 파생 상태 ───────────────────────────────────────────────── */

export interface Shot {
  /** 서버가 준 서사 위치 = 리빌 키. 재시도로 같은 index 가 와도 키가 같아 다시 열리지 않는다. */
  index: number;
  kind: string;
  caption: string;
  url: string;
  tookMs: number;
}

export interface PanelView {
  index: number;
  role: string;
  headline: string;
  url: string;
}

export interface PlanView {
  concept: string;
  angle: string;
  sections: Array<{ role: string; heading: string; hasPanel: boolean }>;
  panelCount: number;
}

export interface ControlDerived {
  /** 상품군 — 상품명이 아니다. 카테고리·가격·상품명이 전부 여기서 갈린다. */
  productName: string | null;
  categoryPath: string | null;
  categoryVerified: boolean | null;
  categoryRounds: number | null;
  categoryComps: number | null;
  price: number | null;
  /** 정가 — 즉시할인이 걸릴 때만 price 보다 크다. */
  listPrice: number | null;
  discountRate: number | null;
  priceSample: number | null;
  priceBasis: string | null;
  /** 이 가격이 **등록될 값**으로 확정됐는가. 시세 조회 결과(산정 재료)와 구분한다. */
  priceFinal: boolean;
  seoTitle: string | null;
  titleStrategy: string | null;
  tagCount: number | null;
  /** 확정된 태그 본문 — 개수만으로는 무엇으로 검색에 걸리는지 알 수 없다. */
  tags: string[];
  attributeCount: number | null;
  kcStatus: string | null;
  noticeType: string | null;
  originResolved: boolean | null;
  shots: Shot[];
  shotStarts: number;
  shotDone: number;
  webSearches: number;
  planStarted: boolean;
  /** 기획이 실패로 끝났는가 — 없으면 "기획 중…"이 런이 끝날 때까지 남는다. */
  planFailed: boolean;
  /** 패널이 승인된 대표 컷을 기다리는 중 — 이 구간을 "생성 중"으로 말하면 거짓말이다. */
  awaitingHero: boolean;
  plan: PlanView | null;
  panels: PanelView[];
  panelStarts: number;
  panelTotal: number | null;
  registeredMode: "live" | "hold" | null;
  rawCount: number;
  liveStage: ListingStage | null;
  /** 마지막으로 관측된 "진행 중" 스테이지 — 중단 시 멈춘 지점 표시용. */
  lastRunningStage: ListingStage | null;
  liveProgress: number | null;
  liveLabel: string | null;
}

export const initialDerived: ControlDerived = {
  productName: null,
  categoryPath: null,
  categoryVerified: null,
  categoryRounds: null,
  categoryComps: null,
  price: null,
  listPrice: null,
  discountRate: null,
  priceSample: null,
  priceBasis: null,
  priceFinal: false,
  seoTitle: null,
  titleStrategy: null,
  tagCount: null,
  tags: [],
  attributeCount: null,
  kcStatus: null,
  noticeType: null,
  originResolved: null,
  shots: [],
  shotStarts: 0,
  shotDone: 0,
  webSearches: 0,
  planStarted: false,
  planFailed: false,
  awaitingHero: false,
  plan: null,
  panels: [],
  panelStarts: 0,
  panelTotal: null,
  registeredMode: null,
  rawCount: 0,
  liveStage: null,
  lastRunningStage: null,
  liveProgress: null,
  liveLabel: null,
};

/* ── 페이로드 헬퍼 ───────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** ⚠ `payload.arguments` 는 객체가 아니라 JSON 문자열이다. */
export function toolArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments;
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return asRecord(raw);
}

/**
 * ⚠ SDK 의 `output` 형태가 셋으로 흔들린다 — 객체 / JSON 문자열 / { type:"text", text:"{…}" }.
 * 셋 다 처리하지 않으면 값이 화면에 안 뜬다.
 */
export function toolOutput(payload: Record<string, unknown>): Record<string, unknown> {
  let output: unknown = payload.output;
  if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string") {
    output = (output as { text: string }).text;
  }
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return payload;
    }
  }
  if (output && typeof output === "object") return output as Record<string, unknown>;
  return payload;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 빈 배열과 "안 왔다"를 구분한다 — 빈 배열로 기존 값을 덮지 않기 위해서다. */
function strList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return out.length > 0 ? out : null;
}

export const SHOT_CAPTIONS: Record<string, string> = {
  main_studio: "대표 스튜디오",
  alt_studio: "보조 스튜디오",
  lifestyle: "라이프스타일",
  usage: "사용 장면",
  closeup: "클로즈업",
  mood: "무드",
};

const RUNNING_STAGES = new Set<ListingStage>([
  "vision",
  "research",
  "assets",
  "category",
  "materials",
  "validation",
  "publishing",
]);

/* ── 리듀서 ──────────────────────────────────────────────────── */

export function applyEvent(state: ControlDerived, event: LiveEvent): ControlDerived {
  const payload = asRecord(event.payload);

  switch (event.channel) {
    /* 개별 내용은 세컨드 화면(/stream) 담당 — 여기서는 카운터만. */
    case "openai_raw":
      return { ...state, rawCount: state.rawCount + 1 };

    case "status": {
      const stage = str(payload.stage) as ListingStage | null;
      return {
        ...state,
        liveStage: stage ?? state.liveStage,
        // 진행 중 스테이지만 기록한다 — 중단 시 "어디까지 갔는지"를 정직하게 그리기 위해서다.
        lastRunningStage: stage && RUNNING_STAGES.has(stage) ? stage : state.lastRunningStage,
        liveProgress: num(payload.progress) ?? state.liveProgress,
        liveLabel: event.label || state.liveLabel,
      };
    }

    case "image": {
      if (event.label === "image.shot_started") {
        return { ...state, shotStarts: state.shotStarts + 1 };
      }
      if (event.label === "image.shot_completed") {
        const url = str(payload.url);
        if (!url) return { ...state, shotDone: state.shotDone + 1 };
        const kind = str(payload.kind) ?? "shot";
        const shot: Shot = {
          index: num(payload.index) ?? state.shots.length,
          kind,
          caption: SHOT_CAPTIONS[kind] ?? kind,
          url,
          tookMs: num(payload.tookMs) ?? 0,
        };
        // ⚠ 실런은 같은 샷을 다시 뱉는다(재시도·재생성·백로그 재전송).
        //   같은 서사 위치는 **제자리 교체**한다 — 늘리면 갤러리 칸이 밀리고 리빌이 반복된다.
        const at = state.shots.findIndex((existing) => existing.index === shot.index);
        if (at >= 0) {
          const shots = state.shots.slice();
          shots[at] = shot;
          return { ...state, shots, shotDone: state.shotDone + 1 };
        }
        /*
          ⚠ index 로 정렬하지 않는다. 이미지는 병렬 생성이라 완성 순서가 매번 다르고
          (실측: 대표 44.8s / 보조 20.6s / 사용 16.6s → 대표가 꼴찌), 정렬하면 늦게 온
          앞 번호가 앞자리를 빼앗아 **이미 걸린 사진이 옆 칸으로 밀려난다**.
          도착 순서대로 차곡차곡 쌓고, 한 번 앉은 사진은 움직이지 않는다.
        */
        return { ...state, shots: [...state.shots, shot], shotDone: state.shotDone + 1 };
      }
      return state;
    }

    case "tool_call": {
      if (event.label === "resolve_category") {
        // 상품군은 resolve_category 인자에서 나온다 — 첫 와우 모먼트.
        return { ...state, productName: str(toolArgs(payload).productGroupName) ?? state.productName };
      }
      if (event.label === "web_search_call" || event.label.startsWith("web_search")) {
        return { ...state, webSearches: state.webSearches + 1 };
      }
      return state;
    }

    case "tool_result": {
      const output = toolOutput(payload);
      if (event.label === "resolve_category") {
        return {
          ...state,
          categoryPath: str(output.categoryPath) ?? state.categoryPath,
          categoryVerified: output.outcome === "verified" || state.categoryVerified === true,
          categoryRounds: num(output.verificationRounds) ?? state.categoryRounds,
          categoryComps: num(output.comparableListings) ?? state.categoryComps,
        };
      }
      if (event.label === "research_market_price") {
        const price = num(output.salePriceKrw);
        if (price == null) return state;
        return {
          ...state,
          price,
          priceSample: num(output.sampleSize) ?? state.priceSample ?? 0,
          priceBasis: str(output.basis) ?? state.priceBasis,
        };
      }
      return state;
    }

    case "milestone":
      return applyMilestone(state, event, payload);

    default:
      return state;
  }
}

function applyMilestone(
  state: ControlDerived,
  event: LiveEvent,
  payload: Record<string, unknown>,
): ControlDerived {
  const label = event.label;

  if (label === "카테고리 매칭") {
    const outcome = str(payload.outcome);
    return {
      ...state,
      categoryPath: str(payload.categoryName) ?? state.categoryPath,
      categoryVerified:
        outcome === "verified" || outcome === "manual" ? true : (state.categoryVerified ?? false),
      categoryRounds: num(payload.rounds) ?? state.categoryRounds,
    };
  }

  if (label === "detail.plan_started") {
    return { ...state, planStarted: true, panelTotal: num(payload.panelTarget) ?? state.panelTotal };
  }

  if (label === "detail.plan_failed") {
    // 총 수를 지운다 — 오지 않을 패널을 세는 "0/6" 이 남으면 그것도 거짓말이다.
    return { ...state, planFailed: true, panelTotal: null, awaitingHero: false };
  }

  if (label === "detail.awaiting_hero") {
    return { ...state, awaitingHero: true };
  }

  if (label === "detail.plan_completed") {
    const sections = Array.isArray(payload.sections)
      ? (payload.sections as unknown[]).map((entry) => {
          const record = asRecord(entry);
          return {
            role: str(record.role) ?? "",
            heading: str(record.heading) ?? "",
            hasPanel: Boolean(record.hasPanel),
          };
        })
      : [];
    return {
      ...state,
      planStarted: true,
      plan: {
        concept: str(payload.concept) ?? "",
        angle: str(payload.angle) ?? "",
        sections,
        panelCount: num(payload.panelCount) ?? sections.filter((section) => section.hasPanel).length,
      },
    };
  }

  if (label === "image.panel_started") {
    return {
      ...state,
      panelStarts: state.panelStarts + 1,
      panelTotal: num(payload.total) ?? state.panelTotal,
      // 첫 패널이 시작됐다 = 대표 컷 대기가 끝났다.
      awaitingHero: false,
    };
  }

  if (label === "image.panel_completed") {
    const url = str(payload.url);
    if (!url) return state;
    const panel: PanelView = {
      index: num(payload.index) ?? state.panels.length,
      role: str(payload.role) ?? "",
      headline: str(payload.headline) ?? "",
      url,
    };
    const at = state.panels.findIndex((existing) => existing.index === panel.index);
    if (at >= 0) {
      const panels = state.panels.slice();
      panels[at] = panel;
      return { ...state, panels, panelTotal: num(payload.total) ?? state.panelTotal };
    }
    return {
      ...state,
      panels: [...state.panels, panel].sort((a, b) => a.index - b.index),
      panelTotal: num(payload.total) ?? state.panelTotal,
    };
  }

  /*
    ── 개별 재료 방송 ──
    서버가 재료를 완성되는 대로 하나씩 보낸다. `재료 생산 완료` 는 같은 값을 다시
    싣고 오는 요약이자 백스톱이므로, 여기서 먼저 받아 두면 리빌이 재료 구간 전체에
    걸쳐 흩어진다. 늦게 접속한 클라이언트는 요약 하나로 전부 복구한다.
  */
  if (label === "materials.title_resolved") {
    return {
      ...state,
      seoTitle: str(payload.seoTitle) ?? state.seoTitle,
      titleStrategy: str(payload.titleStrategy) ?? state.titleStrategy,
    };
  }

  if (label === "materials.tags_resolved") {
    return {
      ...state,
      tagCount: num(payload.tagCount) ?? state.tagCount,
      tags: strList(payload.tags) ?? state.tags,
    };
  }

  if (label === "materials.price_resolved") {
    return {
      ...state,
      price: num(payload.salePrice) ?? state.price,
      listPrice: num(payload.listPrice) ?? state.listPrice,
      discountRate: num(payload.discountRate) ?? state.discountRate,
      priceBasis: str(payload.priceBasis) ?? state.priceBasis,
      priceSample: num(payload.sampleSize) ?? state.priceSample,
      priceFinal: true,
    };
  }

  if (label === "materials.compliance_resolved") {
    return {
      ...state,
      kcStatus: str(payload.kcStatus) ?? state.kcStatus,
      noticeType: str(payload.noticeType) ?? state.noticeType,
      originResolved:
        typeof payload.originResolved === "boolean" ? payload.originResolved : state.originResolved,
      attributeCount: num(payload.attributeCount) ?? state.attributeCount,
    };
  }

  if (label === "재료 생산 완료") {
    return {
      ...state,
      seoTitle: str(payload.seoTitle) ?? state.seoTitle,
      titleStrategy: str(payload.titleStrategy) ?? state.titleStrategy,
      listPrice: num(payload.listPrice) ?? state.listPrice,
      discountRate: num(payload.discountRate) ?? state.discountRate,
      tagCount: num(payload.tagCount) ?? state.tagCount,
      tags: strList(payload.tags) ?? state.tags,
      attributeCount: num(payload.attributeCount) ?? state.attributeCount,
      kcStatus: str(payload.kcStatus) ?? state.kcStatus,
      noticeType: str(payload.noticeType) ?? state.noticeType,
      originResolved:
        typeof payload.originResolved === "boolean" ? payload.originResolved : state.originResolved,
      price: num(payload.salePrice) ?? state.price,
      priceFinal: state.priceFinal || num(payload.salePrice) != null,
    };
  }

  if (label.includes("등록 완료") || label.startsWith("등록안 완성")) {
    return { ...state, registeredMode: label.includes("등록 완료") ? "live" : "hold" };
  }

  // `단계 소요시간(ms)` 등 나머지는 결과 화면이 레코드에서 읽는다.
  return state;
}

/* ── 7단계 스트립 ────────────────────────────────────────────── */

export const PHASES: Array<{ key: string; label: string }> = [
  { key: "vision", label: "상품 파악" },
  { key: "research", label: "신원 검증" },
  { key: "assets", label: "연출 이미지" },
  { key: "category", label: "카테고리 확정" },
  { key: "materials", label: "등록 재료" },
  { key: "validation", label: "규정 검증" },
  { key: "publishing", label: "스토어 등록" },
];

const STAGE_POSITION: Record<string, number> = {
  queued: 0,
  vision: 1,
  research: 1,
  assets: 1,
  category: 4,
  materials: 5,
  validation: 6,
  publishing: 7,
  complete: 8,
  blocked: 8,
  failed: 8,
};

export type PhaseState = "idle" | "active" | "done" | "skipped" | "blocked";
export type TerminalStatus = "registered" | "needs_review" | "failed" | null;

export function phaseStates(
  derived: ControlDerived,
  stage: ListingStage | null,
  terminal: TerminalStatus,
): PhaseState[] {
  // ⚠ 중단 시 스트립은 lastRunningStage 기준으로 그린다.
  //   서버가 보낸 최종 stage(blocked)를 쓰면 모든 단계가 완료로 보인다 — 거짓말이 된다.
  const interrupted = terminal === "needs_review" || terminal === "failed";
  const effectiveStage = interrupted ? (derived.lastRunningStage ?? stage) : stage;
  const pos = STAGE_POSITION[effectiveStage ?? "queued"] ?? 0;
  const complete = terminal === "registered" || stage === "complete";

  const states: PhaseState[] = PHASES.map((phase, index) => {
    const order = index + 1;
    switch (phase.key) {
      case "vision":
        if (derived.productName || pos > 1) return "done";
        return pos >= 1 ? "active" : "idle";
      case "research":
        // 없이 지나가면 skipped — "에이전트가 판단해서 생략했다"는 자율성 증거다.
        if (derived.webSearches > 0) return pos > 1 || complete ? "done" : "active";
        return pos > 1 || complete || interrupted ? "skipped" : "idle";
      case "assets": {
        // stage 와 무관하게 image.* 이벤트로 점등한다 — 병렬 설계가 눈에 보이는 지점.
        if (derived.shotDone > 0 && (pos > 1 || complete)) return "done";
        if (derived.shotDone > 0 && derived.shotDone >= derived.shotStarts) return "done";
        if (derived.shotStarts > 0) return "active";
        // 중단·실패 종착에서는 실제로 완성된 컷이 있을 때만 done.
        if (interrupted) return derived.shotDone > 0 ? "done" : "idle";
        return complete ? "done" : "idle";
      }
      default:
        if (complete) return "done";
        if (pos > order) return "done";
        if (pos === order) return "active";
        return "idle";
    }
  });

  if (interrupted) {
    let target = -1;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      if (states[index] === "active") {
        target = index;
        break;
      }
    }
    if (target === -1) target = states.findIndex((value) => value === "idle");
    if (target >= 0) states[target] = "blocked";
  }

  return states;
}

/* ── 씬 선택 ─────────────────────────────────────────────────── */

export type SceneKey =
  | "vision"
  | "assets"
  | "category"
  | "materials"
  | "validation"
  | "publishing"
  | "complete";

export function sceneOf(
  stage: ListingStage | null,
  derived: ControlDerived,
  terminal: TerminalStatus,
): SceneKey {
  if (terminal === "registered" || stage === "complete") return "complete";
  if (stage === "category" || stage === "materials" || stage === "validation" || stage === "publishing") {
    return stage;
  }
  // 에이전트 구간(queued/vision/research/assets) — 활동으로 장면을 고른다.
  if (!derived.productName) return "vision";
  if (derived.categoryPath) return "category";
  return "assets";
}

/**
 * 씬 서브카피 — 상품 등록을 한 번도 안 해본 관객이 읽는 줄이다. 무엇을 하는지가
 * 아니라 **왜 그게 필요한지**를 말한다.
 */
export const SCENE_SUB: Record<SceneKey, string> = {
  vision: "라벨의 글자까지 읽습니다 — 무엇을 파는 물건인지가 전부의 출발점입니다",
  assets: "올린 사진은 재료일 뿐 — 스토어에 걸 사진은 따로 만듭니다",
  category: "매대를 잘못 고르면 아무도 못 찾습니다 — 같은 상품군 모델들의 투표로 정합니다",
  materials: "상품명 · 가격 · 태그 · 원산지 · KC · 고시 — 등록 칸을 하나씩 채웁니다",
  validation: "규정에 걸리는 곳이 없는지, 올리기 전에 전부 확인합니다",
  publishing: "이미지를 올리고 등록 요청 한 번 — 같은 상품이 두 번 올라가지 않게 잠급니다",
  complete: "사람 손 없이 여기까지 왔습니다",
};

/** 틀과 헤드라인이 항상 같은 이야기를 하도록 씬 기준으로 고정한다 —
 *  서버 stageLabel 은 씬 전환보다 늦게 도착할 수 있다. */
export function sceneHeadline(scene: SceneKey, stageLabel: string): string {
  if (scene === "assets") return "스토어에 걸 사진을 만들고 있어요";
  if (scene === "category") return "어느 매대에 놓을지 정하고 있어요";
  if (scene === "materials") return "등록 칸을 채우고 있어요";
  if (scene === "validation") return "규정을 검증하고 있어요";
  if (scene === "publishing") return "스마트스토어에 올리고 있어요";
  if (scene === "complete") return "등록이 끝났어요";
  return stageLabel;
}

export const ROLE_LABEL: Record<string, string> = {
  hook: "후킹",
  problem: "공감",
  solution: "해결",
  feature: "기능",
  usage: "사용",
  detail: "디테일",
  trust: "신뢰",
  spec: "스펙",
  closing: "마무리",
};

export const FACT_KIND_LABEL: Record<string, string> = {
  observed: "사진에서 확인",
  verified: "외부 확인",
  configured: "판매자 제공",
  inferred: "추론",
  unresolved: "미확인",
};

export const KC_LABEL: Record<string, string> = {
  not_target: "대상 아님",
  safe_criterion: "안전기준 준수",
  certified: "인증 등록",
  child_fallback: "어린이제품",
  unknown: "확인 실패",
};
