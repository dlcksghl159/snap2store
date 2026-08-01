import { useEffect, useMemo, useRef, useState } from "react";
import { MissionControl, ResultShowcase } from "./Theater";
import { DEFAULT_DISCOUNT_RATE, planDiscount } from "./domain/pricing";
import type { ListingRecord, LiveEvent } from "./domain/types";

/**
 * 리허설 드라이버 — 프론트 전용. 서버·실등록을 절대 건드리지 않는다.
 *
 * 규칙
 * 1. 리허설은 언제나 **녹화된 실런을 그대로 재생**한다. 사용자가 올린 사진으로 바꿔치기하지 않는다.
 * 2. 화면에 "리허설 / 녹화된 실런 재생 — 실제 에이전트 실행 아님"을 명시한다.
 * 3. **심사 중 사용 금지.** 발표 전 리허설과 디자인 QA 용도만.
 * 4. 종착 화면은 15초 유지.
 *
 * 리허설에 쓸 자산이 없으면 가짜로 채우지 않는다 — 해당 행이 비는 게 맞다.
 */

export type PreviewMode = "control" | "blocked" | "result" | "launch";

const MODES = new Set<PreviewMode>(["control", "blocked", "result", "launch"]);
const TERMINAL_HOLD_MS = 15_000;

export function previewModeFromLocation(): PreviewMode | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("preview");
  return value && MODES.has(value as PreviewMode) ? (value as PreviewMode) : null;
}

function seekSeconds(): number {
  const value = new URLSearchParams(window.location.search).get("at");
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 재생 속도 — `?pace=real|normal|fast`. 기본은 `normal`(압축)이다.
 *
 * 실런의 간격을 그대로 재생하면 이미지 생성 구간에서 16초씩 아무 일도 안 일어난다.
 * 리허설의 목적은 시간 재현이 아니라 **순서와 연출 확인**이므로 간격만 줄인다.
 * 순서·인과·이벤트 내용은 손대지 않는다 — 줄이는 건 기다림뿐이다.
 *
 * ⚠ 무한정 줄이면 안 된다. 리빌 디렉터는 카드 하나에 1.4초쯤 쓰므로 이벤트가
 * 그보다 빨리 쏟아지면 큐가 밀려 홀드가 260ms 로 깎이고 전부 흐릿하게 지나간다.
 * 그래서 상·하한을 둔다.
 */
const PACES = {
  real: null,
  normal: { scale: 0.25, min: 260, max: 1100 },
  fast: { scale: 0.12, min: 140, max: 520 },
} as const;

type PaceKey = keyof typeof PACES;

function paceFromLocation(): PaceKey {
  const value = new URLSearchParams(window.location.search).get("pace");
  return value && value in PACES ? (value as PaceKey) : "normal";
}

/** 원본 간격을 압축해 각 이벤트의 재생 시각을 만든다. 시킹 이후 분만 대상이다. */
function compressSchedule(
  pending: Array<{ offsetMs: number }>,
  seekAt: number,
  pace: PaceKey,
): number[] {
  const rule = PACES[pace];
  if (!rule) return pending.map((event) => Math.max(0, event.offsetMs - seekAt));
  const out: number[] = [];
  let previous = seekAt;
  let clock = 0;
  for (const event of pending) {
    const gap = Math.max(0, event.offsetMs - previous);
    clock += gap === 0 ? 0 : Math.min(rule.max, Math.max(rule.min, gap * rule.scale));
    out.push(clock);
    previous = event.offsetMs;
  }
  return out;
}

interface RehearsalTape {
  /** 녹화된 실런의 최종 레코드. */
  listing: ListingRecord;
  /** 타임라인 — offsetMs 는 런 시작 기준. */
  events: Array<LiveEvent & { offsetMs: number }>;
}

/**
 * 할인 투영 — 즉시할인 도입 **이전에** 녹화된 테이프에 현재 규칙을 적용해 보여 준다.
 *
 * ⚠ 이건 녹화된 사실이 아니라 **투영**이다. 그래서
 *   ① 계산은 실서버와 같은 `planDiscount` 로만 하고 (숫자를 지어내지 않는다),
 *   ② 화면에 "할인은 현재 규칙으로 재계산" 을 항상 띄우며,
 *   ③ `?discount=off` 로 끄면 녹화된 그대로 재생한다.
 * 테이프에 이미 할인이 실려 있으면(=새 규칙으로 녹화된 런) 투영하지 않는다.
 */
function projectDiscount(tape: RehearsalTape): { tape: RehearsalTape; projected: boolean } {
  const price = tape.listing.materials?.price;
  if (!price?.salePrice) return { tape, projected: false };
  if (price.listPrice && price.discountRate) return { tape, projected: false };

  const plan = planDiscount(price.salePrice, {
    targetRate: DEFAULT_DISCOUNT_RATE,
    displayUnit: 100,
  });
  if (!plan) return { tape, projected: false };

  const events = tape.events.map((event) =>
    event.label === "재료 생산 완료" && event.payload
      ? {
          ...event,
          payload: {
            ...(event.payload as Record<string, unknown>),
            listPrice: plan.listPrice,
            discountKrw: plan.discountKrw,
            discountRate: plan.discountRate,
          },
        }
      : event,
  );
  return {
    projected: true,
    tape: {
      events,
      listing: {
        ...tape.listing,
        materials: {
          ...tape.listing.materials!,
          price: { ...price, ...plan },
        },
      },
    },
  };
}

export function PreviewApp({ mode }: { mode: PreviewMode }) {
  const [tape, setTape] = useState<RehearsalTape | null>(null);
  const [missing, setMissing] = useState(false);
  const [feed, setFeed] = useState<LiveEvent[]>([]);
  const [phase, setPhase] = useState<"stage" | "result">(mode === "result" ? "result" : "stage");
  const timers = useRef<number[]>([]);
  const seekAt = useMemo(() => seekSeconds() * 1000, []);
  const pace = useMemo(paceFromLocation, []);
  const [projected, setProjected] = useState(false);
  /** 무대에 아직 재생할 조립 연출이 남았는가 — 실앱과 같은 규칙으로 결과 전환을 미룬다. */
  const [stagePlaying, setStagePlaying] = useState(false);

  /*
    ⚠ 종착까지 재생해야 리허설이다.
    예전에는 테이프 끝까지 status 를 "running" 으로 고정해서, 실런에서 실제로 벌어지는
    "등록 완료가 뜨는 순간"을 리허설로는 볼 수 없었다 — 그 순간이 바로 조립 연출이
    통째로 사라지던 지점이었는데, 재현할 방법 자체가 없었던 셈이다.
  */
  const reachedTerminal = useMemo(
    () =>
      feed.some(
        (event) =>
          event.channel === "milestone" &&
          (event.label.includes("등록 완료") || event.label.startsWith("등록안 완성")),
      ),
    [feed],
  );

  useEffect(() => {
    let cancelled = false;
    void fetch("/showcase/rehearsal.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: RehearsalTape | null) => {
        if (cancelled) return;
        if (data?.listing && Array.isArray(data.events)) {
          // 할인 도입 이전 테이프에는 현재 규칙을 투영해 연출을 볼 수 있게 한다.
          const wantsDiscount =
            new URLSearchParams(window.location.search).get("discount") !== "off";
          const result = wantsDiscount ? projectDiscount(data) : { tape: data, projected: false };
          setTape(result.tape);
          setProjected(result.projected);
        } else setMissing(true);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!tape || mode === "result") return;
    const sorted = [...tape.events].sort((a, b) => a.offsetMs - b.offsetMs);

    // 시킹 — RAW 카운터는 백필로 절대치를 유지한다.
    const backfilled = sorted.filter((event) => event.offsetMs <= seekAt);
    const pending = sorted.filter((event) => event.offsetMs > seekAt);
    setFeed(backfilled);

    const playAt = compressSchedule(pending, seekAt, pace);
    pending.forEach((event, index) => {
      const handle = window.setTimeout(() => setFeed((current) => [...current, event]), playAt[index]);
      timers.current.push(handle);
    });

    const held = timers.current;
    return () => {
      for (const handle of held) window.clearTimeout(handle);
      timers.current = [];
    };
  }, [mode, pace, seekAt, tape]);

  /* 결과 전환은 실앱과 같은 규칙을 쓴다 — 남은 조립 연출을 끝까지 재생한 뒤 3.2초. */
  useEffect(() => {
    if (mode !== "launch" || !reachedTerminal || stagePlaying) return;
    const handle = window.setTimeout(() => setPhase("result"), 3200);
    return () => window.clearTimeout(handle);
  }, [mode, reachedTerminal, stagePlaying]);

  // 종착 화면은 15초 유지한 뒤 처음으로.
  useEffect(() => {
    if (phase !== "result") return;
    const handle = window.setTimeout(() => window.location.reload(), TERMINAL_HOLD_MS);
    return () => window.clearTimeout(handle);
  }, [phase]);

  const banner = (
    <div className="rehearsal">
      리허설 · 녹화된 실런 재생 — 실제 에이전트 실행 아님
      {pace === "real" ? "" : " · 대기 구간 압축"}
      {projected ? " · 할인은 현재 규칙으로 재계산(녹화 당시 미적용)" : ""}
    </div>
  );

  if (missing) {
    return (
      <main className="library">
        <div className="library-empty">
          <h2>리허설 자산이 없습니다</h2>
          <p>
            녹화된 실런을 <code>public/showcase/rehearsal.json</code> 에 넣으면 재생됩니다.
            <br />
            리허설은 언제나 실런 녹화를 그대로 재생합니다 — 합성 이벤트를 만들지 않습니다.
          </p>
        </div>
        {banner}
      </main>
    );
  }

  if (!tape) {
    return (
      <main className="library">
        <div className="library-empty">
          <h2>리허설 테이프를 불러오는 중…</h2>
        </div>
        {banner}
      </main>
    );
  }

  const listing: ListingRecord =
    mode === "blocked"
      ? {
          ...tape.listing,
          status: "needs_review",
          stage: "blocked",
          stageLabel: "에이전트 판정 보고",
        }
      : phase === "result" || mode === "result" || reachedTerminal
        ? // 종착 밀스톤이 재생된 뒤에는 녹화된 최종 레코드를 그대로 쓴다.
          tape.listing
        : { ...tape.listing, status: "running", stage: "vision", progress: 8 };

  // 무대는 톱밴드에 이미 리허설 칩을 띄운다 — 배너를 겹쳐 스트립을 가리지 않는다.
  if (phase === "result" || mode === "result") {
    return (
      <>
        <ResultShowcase
          listing={tape.listing}
          rehearsal
          onNew={() => window.location.reload()}
          onList={() => window.location.reload()}
        />
        {banner}
      </>
    );
  }
  const note = [
    pace === "real" ? null : "대기 구간 압축 재생",
    projected ? "할인은 현재 규칙으로 재계산(녹화 당시 미적용)" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <MissionControl
      listing={listing}
      feed={feed}
      rehearsal
      rehearsalNote={note || undefined}
      onPlayingChange={setStagePlaying}
    />
  );
}
