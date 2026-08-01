import type { LiveEvent, ListingStage } from "./domain/types";

/* ── 파생 상태 ───────────────────────────────────────────────── */

export interface Shot {
  kind: string;
  index: number;
  url: string;
  tookMs: number;
}

export interface PanelView {
  role: string;
  headline: string;
  url: string;
  index: number;
}

export interface PlanView {
  concept: string;
  angle: string;
  sections: Array<{ role: string; heading: string; hasPanel: boolean }>;
}

/**
 * 리빌 표시 순서 — 등록 서사 그대로다.
 * 파이프라인은 최단시간을 위해 병렬로 돌기 때문에 산출물 **도착 순서가 매번 다르다**.
 * 도착 순서로 보여 주면 관객이 이야기를 못 따라오므로, 표시 순서만 여기서 고정한다.
 * (파이프라인 실행 순서는 건드리지 않는다 — 연출과 실행을 분리한다.)
 */
export const REVEAL_ORDER = {
  productGroup: 10,
  category: 20,
  mainImage: 30,
  gallery: 40,
  price: 50,
  title: 60,
  requiredFields: 70,
  detailPlan: 80,
  detailPanel: 90,
  other: 100,
} as const;

export interface FeedCard {
  id: string;
  /** 이벤트 seq — 같은 order 안에서 도착 순서를 유지하는 타이브레이커. */
  seq: number;
  at: string;
  channel: string;
  kicker: string;
  title: string;
  detail: string;
  why: string | null;
  tech: string | null;
  slot: string | null;
  size: "hero" | "medium" | "quick";
  /** 낮을수록 먼저 보여 준다. 도착 순서가 아니라 이 값이 순서를 정한다. */
  order?: number;
}

/** 리빌 카드가 "어느 칸으로 들어가는지"를 도착 전에 말한다. */
export function slotLabel(slot: string | null): string | null {
  if (!slot) return null;
  if (slot === "thumb") return "대표 이미지";
  if (slot.startsWith("gallery-")) return "추가 컷";
  if (slot === "crumb") return "카테고리";
  if (slot === "title") return "상품명";
  if (slot === "price") return "판매가";
  if (slot === "tags") return "검색 태그";
  if (slot === "meta") return "필수 표시 항목";
  if (slot === "plan") return "상세페이지";
  if (slot.startsWith("panel-")) return `상세 ${Number(slot.slice(6)) + 1}컷`;
  return null;
}

/** 슬롯이 서사 위치를 이미 말해 준다 — 예외인 카드만 order 를 직접 준다. */
export function revealOrderForSlot(slot: string | null): number {
  if (!slot) return REVEAL_ORDER.other;
  if (slot === "title") return REVEAL_ORDER.productGroup;
  if (slot === "crumb") return REVEAL_ORDER.category;
  if (slot === "thumb") return REVEAL_ORDER.mainImage;
  if (slot.startsWith("gallery-")) return REVEAL_ORDER.gallery;
  if (slot === "price") return REVEAL_ORDER.price;
  if (slot === "tags") return REVEAL_ORDER.title;
  if (slot === "meta") return REVEAL_ORDER.requiredFields;
  if (slot === "plan") return REVEAL_ORDER.detailPlan;
  if (slot.startsWith("panel-")) return REVEAL_ORDER.detailPanel;
  return REVEAL_ORDER.other;
}

export interface ControlDerived {
  productName: string | null;
  productGroup: string | null;
  categoryPath: string | null;
  categoryVerified: boolean;
  categoryRounds: number;
  categoryComps: number;
  categoryCandidates: Array<{ categoryPath: string; votes: number }>;
  price: number | null;
  priceSample: number;
  priceBasis: string | null;
  seoTitle: string | null;
  tagCount: number;
  attributeCount: number;
  kcStatus: string | null;
  noticeType: string | null;
  originResolved: boolean | null;
  shots: Shot[];
  shotStarts: number;
  shotDone: number;
  webSearches: number;
  planStarted: boolean;
  plan: PlanView | null;
  panels: PanelView[];
  panelStarts: number;
  panelTotal: number;
  registeredMode: "live" | "hold" | null;
  cards: FeedCard[];
  rawCount: number;
  liveStage: ListingStage | null;
  lastRunningStage: ListingStage | null;
  liveProgress: number;
  liveLabel: string | null;
}

export const initialDerived: ControlDerived = {
  productName: null,
  productGroup: null,
  categoryPath: null,
  categoryVerified: false,
  categoryRounds: 0,
  categoryComps: 0,
  categoryCandidates: [],
  price: null,
  priceSample: 0,
  priceBasis: null,
  seoTitle: null,
  tagCount: 0,
  attributeCount: 0,
  kcStatus: null,
  noticeType: null,
  originResolved: null,
  shots: [],
  shotStarts: 0,
  shotDone: 0,
  webSearches: 0,
  planStarted: false,
  plan: null,
  panels: [],
  panelStarts: 0,
  panelTotal: 0,
  registeredMode: null,
  cards: [],
  rawCount: 0,
  liveStage: null,
  lastRunningStage: null,
  liveProgress: 0,
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

const RUNNING_STAGES = new Set<ListingStage>([
  "vision",
  "research",
  "assets",
  "category",
  "materials",
  "validation",
  "publishing",
]);

/**
 * ⚠ 한 이벤트가 카드를 둘 이상 만들 수 있다 (재료 생산 완료 → 상품명 + 필수 표시 항목).
 * id 를 seq 만으로 만들면 둘이 겹쳐 뒤엣것이 중복으로 걸러지고 화면에서 조용히 사라진다.
 */
function card(input: Omit<FeedCard, "id" | "seq">, seq: number): FeedCard {
  return {
    ...input,
    seq,
    id: `c${seq}-${input.slot ?? input.kicker}`,
    order: input.order ?? revealOrderForSlot(input.slot),
  };
}

/* ── 리듀서 ──────────────────────────────────────────────────── */

export function applyEvent(state: ControlDerived, event: LiveEvent): ControlDerived {
  const payload = asRecord(event.payload);
  const seq = event.seq;
  const at = event.at;

  switch (event.channel) {
    /* 개별 내용은 세컨드 화면 담당 — 여기서는 카운터만. */
    case "openai_raw":
      return { ...state, rawCount: state.rawCount + 1 };

    case "status": {
      const stage = str(payload.stage) as ListingStage | null;
      const progress = num(payload.progress) ?? state.liveProgress;
      return {
        ...state,
        liveStage: stage ?? state.liveStage,
        // 진행 중 스테이지만 기록한다 — 중단 시 "어디까지 갔는지"를 정직하게 그리기 위해서다.
        lastRunningStage:
          stage && RUNNING_STAGES.has(stage) ? stage : state.lastRunningStage,
        liveProgress: progress,
        liveLabel: event.label || state.liveLabel,
      };
    }

    case "image": {
      if (event.label === "image.shot_started") {
        return { ...state, shotStarts: state.shotStarts + 1 };
      }
      if (event.label === "image.shot_completed") {
        const url = str(payload.url);
        if (!url) return state;
        const shot: Shot = {
          kind: str(payload.kind) ?? "shot",
          index: num(payload.index) ?? state.shots.length,
          url,
          tookMs: num(payload.tookMs) ?? 0,
        };
        if (state.shots.some((existing) => existing.url === url)) return state;
        const isMain = shot.index === 0;
        return {
          ...state,
          shots: [...state.shots, shot].sort((a, b) => a.index - b.index),
          shotDone: state.shotDone + 1,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "image",
                kicker: isMain ? "대표 이미지 완성" : "추가 컷 완성",
                title: isMain ? "대표 이미지" : `추가 컷 ${shot.index}`,
                detail: `${shot.kind} · ${(shot.tookMs / 1000).toFixed(1)}초`,
                why: isMain
                  ? "검색 결과에 뜨는 첫 얼굴 — 누를지 말지가 여기서 갈립니다"
                  : "상세로 들어오기 전, 상품을 여러 각도로 확인시킵니다",
                tech: "gpt-image-2 · 올린 사진을 재료로 생성",
                slot: isMain ? "thumb" : `gallery-${Math.max(0, shot.index - 1)}`,
                size: isMain ? "hero" : "medium",
                order: isMain ? REVEAL_ORDER.mainImage : REVEAL_ORDER.gallery,
              },
              seq,
            ),
          ],
        };
      }
      return state;
    }

    case "tool_call": {
      const args = toolArgs(payload);
      if (event.label === "resolve_category") {
        // resolve_category 의 args 에서 productGroupName 을 뽑는다 — 첫 와우 모먼트.
        const group = str(args.productGroupName);
        return {
          ...state,
          productGroup: group ?? state.productGroup,
          productName: state.productName ?? group,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_call",
                kicker: "상품군 인식",
                title: group ?? "카테고리 조회",
                detail: str(args.productSummary) ?? "",
                why: "무엇을 파는 물건인지가 정해져야 나머지 아홉 칸이 채워집니다",
                tech: "resolve_category · 에이전트가 직접 호출",
                slot: "title",
                size: "hero",
                order: REVEAL_ORDER.productGroup,
              },
              seq,
            ),
          ],
        };
      }
      if (event.label === "research_market_price") {
        return {
          ...state,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_call",
                kicker: "시세 조회 시작",
                title: str(args.searchQuery) ?? "판매가 조사",
                detail: "",
                why: null,
                tech: "research_market_price",
                slot: null,
                size: "quick",
                order: REVEAL_ORDER.other,
              },
              seq,
            ),
          ],
        };
      }
      if (event.label === "web_search_call" || event.label.startsWith("web_search")) {
        return {
          ...state,
          webSearches: state.webSearches + 1,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_call",
                kicker: "신원 검증",
                title: "웹 검색으로 브랜드를 확인합니다",
                detail: "",
                why: "인쇄된 로고만으로는 정품 여부를 말할 수 없습니다",
                tech: "hosted web_search",
                slot: null,
                size: "medium",
                order: REVEAL_ORDER.other,
              },
              seq,
            ),
          ],
        };
      }
      if (event.label === "generate_image_suite") {
        return {
          ...state,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_call",
                kicker: "이미지 진행 확인",
                title: "연출 이미지 상태를 확인합니다",
                detail: "",
                why: null,
                tech: "generate_image_suite · 논블로킹",
                slot: null,
                size: "quick",
                order: REVEAL_ORDER.other,
              },
              seq,
            ),
          ],
        };
      }
      return state;
    }

    case "tool_result": {
      const output = toolOutput(payload);
      if (event.label === "resolve_category") {
        const categoryPath = str(output.categoryPath);
        const verified = output.outcome === "verified";
        const rounds = num(output.verificationRounds) ?? 0;
        const comps = num(output.comparableListings) ?? 0;
        const candidates = Array.isArray(output.topCandidates)
          ? (output.topCandidates as unknown[])
              .map((entry) => {
                const record = asRecord(entry);
                return {
                  categoryPath: str(record.categoryPath) ?? "",
                  votes: num(record.votes) ?? 0,
                };
              })
              .filter((entry) => entry.categoryPath)
          : state.categoryCandidates;
        return {
          ...state,
          categoryPath: categoryPath ?? state.categoryPath,
          categoryVerified: verified,
          categoryRounds: rounds,
          categoryComps: comps,
          categoryCandidates: candidates,
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_result",
                kicker: "카테고리 결정",
                // 정직성 분기 — 검증 루프를 통과했을 때만 "확정".
                title: verified ? "카테고리 확정 — 카탈로그 투표" : "카테고리 후보 선정 — 검증 미통과",
                detail: categoryPath ?? "",
                why: "매대를 잘못 고르면 아무도 못 찾습니다",
                tech: `같은 상품군 모델 ${comps}건 투표 · 검증 ${rounds}라운드`,
                slot: "crumb",
                size: "hero",
                order: REVEAL_ORDER.category,
              },
              seq,
            ),
          ],
        };
      }
      if (event.label === "research_market_price") {
        const price = num(output.salePriceKrw);
        const sample = num(output.sampleSize) ?? 0;
        if (price == null) return state;
        return {
          ...state,
          price,
          priceSample: sample,
          priceBasis: str(output.basis),
          cards: [
            ...state.cards,
            card(
              {
                at,
                channel: "tool_result",
                kicker: "판매가 결정",
                // 정직성 분기 — 시세 표본이 실재할 때만 "시세 기반".
                title: sample > 0 ? "시세 기반 판매가 산출" : "판매가 산출 — 에이전트 추정",
                detail:
                  sample > 0
                    ? `${price.toLocaleString("ko-KR")}원 · 표본 ${sample}건`
                    : `${price.toLocaleString("ko-KR")}원 · 사진·상품 정보 근거`,
                why: "비싸면 안 팔리고 싸면 손해 — 팔리는 선을 잡습니다",
                tech:
                  sample > 0
                    ? `실판매 표본 ${sample}건 · IQR 정제 후 보수적 백분위`
                    : "시세 표본 없음 — 사진·상품 정보 근거 추정",
                slot: "price",
                size: "hero",
                order: REVEAL_ORDER.price,
              },
              seq,
            ),
          ],
        };
      }
      return state;
    }

    case "milestone":
      return applyMilestone(state, event, payload, seq, at);

    case "error":
      return {
        ...state,
        cards: [
          ...state.cards,
          card(
            {
              at,
              channel: "error",
              kicker: "중단",
              title: event.label,
              detail: Array.isArray(payload.issues)
                ? (payload.issues as unknown[]).map(String).join(" · ")
                : (str(payload.message) ?? ""),
              why: null,
              tech: null,
              slot: null,
              size: "medium",
              order: REVEAL_ORDER.other,
            },
            seq,
          ),
        ],
      };

    default:
      return state;
  }
}

function applyMilestone(
  state: ControlDerived,
  event: LiveEvent,
  payload: Record<string, unknown>,
  seq: number,
  at: string,
): ControlDerived {
  const label = event.label;

  if (label === "카테고리 매칭") {
    const outcome = str(payload.outcome);
    const verified = outcome === "verified" || outcome === "manual";
    return {
      ...state,
      categoryPath: str(payload.categoryName) ?? state.categoryPath,
      categoryVerified: state.categoryVerified || verified,
      categoryRounds: num(payload.rounds) ?? state.categoryRounds,
    };
  }

  if (label === "detail.plan_started") {
    return { ...state, planStarted: true, panelTotal: num(payload.panelTarget) ?? state.panelTotal };
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
    const plan: PlanView = {
      concept: str(payload.concept) ?? "",
      angle: str(payload.angle) ?? "",
      sections,
    };
    return {
      ...state,
      plan,
      cards: [
        ...state.cards,
        card(
          {
            at,
            channel: "milestone",
            kicker: "상세페이지 기획 확정",
            title: plan.concept,
            detail: plan.angle,
            why: "본문 — 구매를 결정짓는 자리. 무엇을 왜 보여줄지 먼저 정합니다",
            tech: `${sections.length}개 섹션 · 패널 ${num(payload.panelCount) ?? 0}컷 설계`,
            slot: "plan",
            size: "hero",
            order: REVEAL_ORDER.detailPlan,
          },
          seq,
        ),
      ],
    };
  }

  if (label === "image.panel_started") {
    return {
      ...state,
      panelStarts: state.panelStarts + 1,
      panelTotal: num(payload.total) ?? state.panelTotal,
    };
  }

  if (label === "image.panel_completed") {
    const url = str(payload.url);
    if (!url || state.panels.some((panel) => panel.url === url)) return state;
    const index = num(payload.index) ?? state.panels.length;
    const panel: PanelView = {
      role: str(payload.role) ?? "",
      headline: str(payload.headline) ?? "",
      url,
      index,
    };
    return {
      ...state,
      panels: [...state.panels, panel].sort((a, b) => a.index - b.index),
      panelTotal: num(payload.total) ?? state.panelTotal,
      cards: [
        ...state.cards,
        card(
          {
            at,
            channel: "milestone",
            kicker: "상세 컷 완성",
            title: panel.headline || `상세 ${index + 1}컷`,
            detail: panel.role,
            why: null,
            tech: "gpt-image-2 · 세로 2:3 패널",
            slot: `panel-${index}`,
            size: "medium",
            order: REVEAL_ORDER.detailPanel,
          },
          seq,
        ),
      ],
    };
  }

  if (label === "재료 생산 완료") {
    const confirmedTitle = str(payload.seoTitle);
    const titleStrategy = str(payload.titleStrategy);
    const titleCard = confirmedTitle
      ? [
          card(
            {
              at,
              channel: "milestone",
              kicker: "상품명 확정",
              title: confirmedTitle,
              detail: `${confirmedTitle.length}자`,
              why: "검색창에 뭘 치는지가 노출을 정합니다 — 상품군 명사를 앞에 두고 검색 어휘로 다시 씁니다",
              tech:
                titleStrategy === "composed"
                  ? "근거 토큰 조합 · 발명 단어 차단"
                  : `어순 전략 ${titleStrategy ?? "accuracy"} · 검색 수요 최대 조합`,
              slot: "title",
              size: "hero",
              order: REVEAL_ORDER.title,
            },
            seq,
          ),
        ]
      : [];

    return {
      ...state,
      seoTitle: confirmedTitle ?? state.seoTitle,
      tagCount: num(payload.tagCount) ?? state.tagCount,
      attributeCount: num(payload.attributeCount) ?? state.attributeCount,
      kcStatus: str(payload.kcStatus) ?? state.kcStatus,
      noticeType: str(payload.noticeType) ?? state.noticeType,
      originResolved:
        typeof payload.originResolved === "boolean" ? payload.originResolved : state.originResolved,
      price: num(payload.salePrice) ?? state.price,
      cards: [
        ...state.cards,
        ...titleCard,
        card(
          {
            at,
            channel: "milestone",
            kicker: "필수 표시 항목 채움",
            title: "원산지 · KC · 고시",
            detail: [
              payload.originResolved ? "원산지 확정" : "원산지 설정 기본값",
              str(payload.kcStatus),
              str(payload.noticeType),
            ]
              .filter(Boolean)
              .join(" · "),
            why: "원산지 · KC · 고시는 법으로 요구되는 칸 — 하나만 비어도 등록이 막힙니다",
            tech: `검색 태그 ${num(payload.tagCount) ?? 0}개 · 상품속성 ${num(payload.attributeCount) ?? 0}건`,
            slot: "meta",
            size: "hero",
            order: REVEAL_ORDER.requiredFields,
          },
          seq,
        ),
      ],
    };
  }

  if (label.includes("등록 완료") || label.startsWith("등록안 완성")) {
    return { ...state, registeredMode: label.includes("등록 완료") ? "live" : "hold" };
  }

  if (label === "실등록 보류 판정") {
    return {
      ...state,
      cards: [
        ...state.cards,
        card(
          {
            at,
            channel: "milestone",
            kicker: "실등록 보류",
            title: "등록안은 완성됐습니다",
            detail: Array.isArray(payload.reasons)
              ? (payload.reasons as unknown[]).map(String).join(" · ")
              : "",
            why: null,
            tech: null,
            slot: null,
            size: "medium",
            order: REVEAL_ORDER.other,
          },
          seq,
        ),
      ],
    };
  }

  // `단계 소요시간(ms)` 는 결과 화면이 레코드에서 읽는다.
  return state;
}

/* ── 7단계 스트립 ────────────────────────────────────────────── */

export const PHASES = [
  { key: "vision", label: "상품 파악" },
  { key: "research", label: "신원 검증" },
  { key: "assets", label: "연출 이미지" },
  { key: "category", label: "카테고리 확정" },
  { key: "materials", label: "등록 재료" },
  { key: "validation", label: "규정 검증" },
  { key: "publishing", label: "스토어 등록" },
] as const;

export const STAGE_POSITION: Record<string, number> = {
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

export function phaseStates(
  derived: ControlDerived,
  stage: ListingStage | null,
  terminal: "registered" | "needs_review" | "failed" | null,
): PhaseState[] {
  // ⚠ 중단 시 스트립은 lastRunningStage 기준으로 그린다.
  //   서버가 보낸 최종 stage(blocked)를 쓰면 모든 단계가 완료로 보인다.
  const interrupted = terminal === "needs_review" || terminal === "failed";
  const effectiveStage = interrupted ? (derived.lastRunningStage ?? stage) : stage;
  const pos = STAGE_POSITION[effectiveStage ?? "queued"] ?? 0;
  const complete = terminal === "registered";

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
    // 마지막 active (역방향 탐색, 없으면 첫 idle)에 blocked 표시
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
  terminal: "registered" | "needs_review" | "failed" | null,
): SceneKey {
  if (terminal === "registered" || stage === "complete") return "complete";
  if (stage === "category" || stage === "materials" || stage === "validation" || stage === "publishing") {
    return stage;
  }
  if (!derived.productName) return "vision";
  if (derived.categoryPath) return "category";
  return "assets";
}

/** 씬 헤드라인은 씬 기준으로 고정한다 — 서버 stageLabel 은 씬 전환보다 늦게 도착할 수 있다. */
export const SCENE_HEADLINE: Record<SceneKey, string | null> = {
  vision: null,
  assets: "스토어에 걸 사진을 만들고 있어요",
  category: "어느 매대에 놓을지 정하고 있어요",
  materials: "등록 칸을 채우고 있어요",
  validation: "규정을 검증하고 있어요",
  publishing: "스마트스토어에 올리고 있어요",
  complete: "등록이 끝났어요",
};

/** 씬 서브카피는 "무엇을"이 아니라 "왜 그게 필요한지"를 말한다. */
export const SCENE_SUB: Record<SceneKey, string> = {
  vision: "라벨의 글자까지 읽습니다 — 무엇을 파는 물건인지가 전부의 출발점입니다",
  assets: "올린 사진은 재료일 뿐 — 스토어에 걸 사진은 따로 만듭니다",
  category: "매대를 잘못 고르면 아무도 못 찾습니다 — 같은 상품군 모델들의 투표로 정합니다",
  materials: "상품명 · 가격 · 태그 · 원산지 · KC · 고시 — 등록 칸을 하나씩 채웁니다",
  validation: "규정에 걸리는 곳이 없는지, 올리기 전에 전부 확인합니다",
  publishing: "이미지를 올리고 등록 요청 한 번 — 같은 상품이 두 번 올라가지 않게 잠급니다",
  complete: "사람 손 없이 여기까지 왔습니다",
};

export const ROLE_LABEL: Record<string, string> = {
  hook: "후킹",
  problem: "공감",
  solution: "해결",
  feature: "기능",
  usage: "사용",
  detail: "디테일",
  trust: "신뢰",
  closing: "마무리",
};

export const FACT_KIND_LABEL: Record<string, string> = {
  observed: "사진에서 확인",
  verified: "외부 확인",
  configured: "판매자 제공",
  inferred: "추론",
  unresolved: "미확인",
};
