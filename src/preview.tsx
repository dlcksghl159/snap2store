import { useEffect, useMemo, useRef, useState } from "react";
import { MissionControl, ResultShowcase } from "./Theater";
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

interface RehearsalTape {
  /** 녹화된 실런의 최종 레코드. */
  listing: ListingRecord;
  /** 타임라인 — offsetMs 는 런 시작 기준. */
  events: Array<LiveEvent & { offsetMs: number }>;
}

export function PreviewApp({ mode }: { mode: PreviewMode }) {
  const [tape, setTape] = useState<RehearsalTape | null>(null);
  const [missing, setMissing] = useState(false);
  const [feed, setFeed] = useState<LiveEvent[]>([]);
  const [phase, setPhase] = useState<"stage" | "result">(mode === "result" ? "result" : "stage");
  const timers = useRef<number[]>([]);
  const seekAt = useMemo(() => seekSeconds() * 1000, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/showcase/rehearsal.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: RehearsalTape | null) => {
        if (cancelled) return;
        if (data?.listing && Array.isArray(data.events)) setTape(data);
        else setMissing(true);
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

    for (const event of pending) {
      const handle = window.setTimeout(
        () => setFeed((current) => [...current, event]),
        Math.max(0, event.offsetMs - seekAt),
      );
      timers.current.push(handle);
    }

    const last = pending[pending.length - 1]?.offsetMs ?? seekAt;
    if (mode === "launch") {
      const handle = window.setTimeout(() => setPhase("result"), Math.max(0, last - seekAt) + 3200);
      timers.current.push(handle);
    }

    const held = timers.current;
    return () => {
      for (const handle of held) window.clearTimeout(handle);
      timers.current = [];
    };
  }, [mode, seekAt, tape]);

  // 종착 화면은 15초 유지한 뒤 처음으로.
  useEffect(() => {
    if (phase !== "result") return;
    const handle = window.setTimeout(() => window.location.reload(), TERMINAL_HOLD_MS);
    return () => window.clearTimeout(handle);
  }, [phase]);

  const banner = (
    <div className="rehearsal">리허설 · 녹화된 실런 재생 — 실제 에이전트 실행 아님</div>
  );

  if (missing) {
    return (
      <main className="list">
        <div className="empty" style={{ marginTop: 80 }}>
          <b>리허설 자산이 없습니다</b>
          <span>
            녹화된 실런을 <code>public/showcase/rehearsal.json</code> 에 넣으면 재생됩니다.
            <br />
            리허설은 언제나 실런 녹화를 그대로 재생합니다 — 합성 이벤트를 만들지 않습니다.
          </span>
        </div>
        {banner}
      </main>
    );
  }

  if (!tape) {
    return (
      <main className="list">
        <div className="empty" style={{ marginTop: 80 }}>
          <b>리허설 테이프를 불러오는 중…</b>
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
      : phase === "result" || mode === "result"
        ? tape.listing
        : { ...tape.listing, status: "running", stage: "vision", progress: 8 };

  // 무대는 톱밴드에 이미 리허설 칩을 띄운다 — 배너를 겹쳐 스트립을 가리지 않는다.
  if (phase === "result" || mode === "result") {
    return (
      <>
        <ResultShowcase
          listing={tape.listing}
          onNew={() => window.location.reload()}
          onList={() => window.location.reload()}
        />
        {banner}
      </>
    );
  }
  return <MissionControl listing={listing} feed={feed} rehearsal />;
}
