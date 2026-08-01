import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BroadcastIcon,
  CameraIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ListingRecord, LiveEvent } from "./domain/types";
import {
  applyEvent,
  initialDerived,
  KC_LABEL,
  PHASES,
  phaseStates,
  ROLE_LABEL,
  SCENE_SUB,
  sceneHeadline,
  sceneOf,
} from "./stage-model";
import type { ControlDerived, TerminalStatus } from "./stage-model";
import { AssemblyStage } from "./Assembly";

/**
 * 등록 실황 스테이지 — 풀블리드 · 등록안 조립형.
 *
 * 원거리: 상단 헤드라인 한 문장이 현 단계를 말한다.
 * 근거리: 스마트스토어 상품 페이지 모양의 "틀"이 상주하고, 산출물이 완성될 때마다
 * 화면 중앙에 크게 등장했다가 제자리에 장착된다.
 * 좌하단 원본 사진과 하단 7단계 스트립이 실황을 받친다.
 * 화면의 모든 값은 /api/stream(SSE) 실이벤트에서만 온다.
 */

const TERMINAL = new Set(["registered", "needs_review", "failed"]);

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function useElapsed(listing: ListingRecord, running: boolean, tapeMs: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || tapeMs != null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, tapeMs]);
  /*
    리허설은 **녹화된 런의 시계**를 보여 준다. 재생 벽시계로 세면 압축 재생에서
    "20초 만에 등록됐다"는 거짓이 되고, 녹화 시각을 기준으로 세면 T+180분이 뜬다.
    테이프의 첫 이벤트와 마지막 적용 이벤트 사이가 그 런에 실제로 걸린 시간이다.
  */
  if (tapeMs != null) return formatClock(tapeMs);
  const started = new Date(listing.createdAt).getTime();
  const base = Number.isNaN(started) ? now : started;
  // 종착 후에는 시계를 멈춘다 — 끝난 런의 T+ 가 계속 오르면 아직 도는 것처럼 읽힌다.
  const end = running ? now : new Date(listing.updatedAt).getTime() || now;
  return formatClock(end - base);
}

export interface MissionControlProps {
  listing: ListingRecord;
  /** 리허설 드라이버 전용 — 주어지면 SSE 를 구독하지 않는다. */
  feed?: LiveEvent[];
  rehearsal?: boolean;
  /** 리허설 고지에 덧붙일 단서 (압축 재생·할인 투영 등). 무대는 배너를 가리므로 여기로 받는다. */
  rehearsalNote?: string;
  /** 판정 결과 확인 — 목록의 상세로 보낸다. */
  onReview?: () => void;
  /** 종착 보고를 닫는다. 파이프라인 입력이 아니라 화면 이동일 뿐이다. */
  onDismiss?: () => void;
  /** 조립 연출이 아직 남았는지 — 결과 화면 전환이 이걸 기다린다. */
  onPlayingChange?: (playing: boolean) => void;
}

export function MissionControl({
  listing,
  feed,
  rehearsal = false,
  rehearsalNote,
  onReview,
  onDismiss,
  onPlayingChange,
}: MissionControlProps) {
  const [derived, setDerived] = useState<ControlDerived>(initialDerived);
  const listingIdRef = useRef(listing.id);
  const lastSeqRef = useRef(0);
  listingIdRef.current = listing.id;

  /* 실전: SSE 구독. 리허설(feed 제공) 시에는 구독하지 않는다. */
  useEffect(() => {
    if (feed) return;
    setDerived(initialDerived);
    lastSeqRef.current = 0;
    const source = new EventSource("/api/stream");
    const onLive = (message: MessageEvent<string>) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      if (event.listingId !== listingIdRef.current) return;
      // ⚠ 재연결 시 서버가 링버퍼 백로그를 재전송한다 — seq 중복 제거가 없으면
      //   카운터가 두 배로 뛰고 씬이 역행한다.
      if (typeof event.seq === "number") {
        if (event.seq <= lastSeqRef.current) return;
        lastSeqRef.current = event.seq;
      }
      setDerived((current) => applyEvent(current, event));
    };
    source.addEventListener("live", onLive as EventListener);
    return () => {
      source.removeEventListener("live", onLive as EventListener);
      source.close();
    };
  }, [listing.id, feed]);

  /* 리허설 재생 — 주입된 배열을 리듀서에 통과시킨다.
     ⚠ seq 커서를 상태 업데이터 **안에서** 옮기면 안 된다. React 가 업데이터를
     두 번 호출할 때(StrictMode) 두 번째 호출이 전부 "이미 본 이벤트"로 걸러
     파생 상태가 통째로 비어 버린다. 커서 이동은 반드시 업데이터 바깥에서. */
  useEffect(() => {
    if (!feed) return;
    const fresh = feed.filter(
      (event) => typeof event.seq !== "number" || event.seq > lastSeqRef.current,
    );
    if (fresh.length === 0) return;
    for (const event of fresh) {
      if (typeof event.seq === "number" && event.seq > lastSeqRef.current) {
        lastSeqRef.current = event.seq;
      }
    }
    setDerived((current) => fresh.reduce(applyEvent, current));
  }, [feed]);

  const terminal: TerminalStatus = TERMINAL.has(listing.status)
    ? (listing.status as "registered" | "needs_review" | "failed")
    : null;
  // 중단·실패 시에는 마지막 진행 지점 기준으로 그린다 — 가보지 않은 단계가
  // "완료"로 보이면 거짓말이 된다.
  const stage =
    terminal === "needs_review" || terminal === "failed"
      ? (derived.lastRunningStage ?? "queued")
      : derived.liveStage && !terminal
        ? derived.liveStage
        : listing.stage;
  const progress = Math.max(derived.liveProgress ?? 0, listing.progress ?? 0);
  const stageLabel = (!terminal && derived.liveLabel) || listing.stageLabel;
  const states = useMemo(() => phaseStates(derived, stage, terminal), [derived, stage, terminal]);
  const live =
    derived.registeredMode === "live" ||
    (listing.publication?.mode === "live" && listing.publication?.liveStatus === "registered");
  const scene = sceneOf(stage, derived, terminal);
  // 리허설이면 테이프가 시계를 갖고 있다 — 재생 속도와 무관하게 실런의 경과를 말한다.
  const tapeMs = useMemo(() => {
    if (!feed || feed.length === 0) return null;
    const first = Date.parse(feed[0].at);
    const last = Date.parse(feed[feed.length - 1].at);
    return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null;
  }, [feed]);
  const elapsed = useElapsed(listing, terminal == null, tapeMs);
  const blockReasons = listing.blockReasons ?? listing.draft?.blockReasons ?? [];
  const halted = terminal === "needs_review" || terminal === "failed";

  return (
    <div
      className={`stage${terminal === "registered" ? " is-complete" : ""}${halted ? " is-halted" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="등록 실황"
    >
      <header className="stage-top">
        <span className="stage-brand">
          Snap2Store <span className="stage-brand-chip">등록 실황</span>
        </span>
        <div className="stage-top-meta">
          <span className="stage-chip stage-chip-mono stage-chip-run">
            {rehearsal ? "REHEARSAL" : `RUN ${listing.id.slice(0, 8).toUpperCase()}`}
          </span>
          {/* 실행 모드 칩은 두지 않는다 — 진짜로 등록된다는 건 전제이지 상태가
              아니다. 리허설(녹화 재생)만은 표기해야 거짓 실황이 되지 않는다. */}
          {rehearsal ? <span className="stage-chip stage-chip-rehearsal">리허설</span> : null}
          <span className="stage-chip stage-chip-mono" aria-label="경과 시간">
            T+{elapsed}
          </span>
          <a
            className="stage-chip stage-chip-link stage-chip-mono stage-chip-raw"
            href="/stream"
            target="_blank"
            rel="noreferrer"
            aria-label={`Raw API Stream — 수신 ${derived.rawCount}건, 세컨드 화면에 열기`}
          >
            <BroadcastIcon size={12} weight="bold" aria-hidden="true" /> RAW{" "}
            {derived.rawCount.toLocaleString("ko-KR")}
            <ArrowUpRightIcon size={11} weight="bold" aria-hidden="true" />
          </a>
        </div>
      </header>

      <div className="stage-lede" key={scene} aria-live="polite">
        <h1>{sceneHeadline(scene, stageLabel)}</h1>
        <p>{SCENE_SUB[scene]}</p>
        {rehearsal ? (
          <p className="stage-rehearsal-tag">
            녹화된 실런 재생 — 실제 에이전트 실행 아님{rehearsalNote ? ` · ${rehearsalNote}` : ""}
          </p>
        ) : null}
      </div>

      <div className="stage-arena">
        <AssemblyStage
          derived={derived}
          listing={listing}
          scene={scene}
          live={live}
          terminal={terminal}
          canOpenProduct={!rehearsal}
          onPlayingChange={onPlayingChange}
        />
      </div>

      <footer className="stage-strip" aria-label="파이프라인 단계">
        <div className="stage-strip-row">
          <figure className={`stage-origin${derived.productName ? "" : " is-scanning"}`}>
            {/* 발사 전환의 착지점은 사진 칸이다 — figure 에 붙이면 캡션까지 포함한
                넓은 사각형이 되어 사진이 캡션 위로 내려앉는다. */}
            <span className="stage-origin-img" data-launch-target="evidence">
              {listing.photoUrls[0] ? <img src={listing.photoUrls[0]} alt="업로드한 상품 사진" /> : null}
              <span className="stage-scanline" aria-hidden="true" />
            </span>
            <figcaption>
              <span className="stage-origin-k">
                <CameraIcon size={11} weight="bold" aria-hidden="true" /> 원본
              </span>
              {derived.productName ? `“${derived.productName}”` : "판독 중"}
            </figcaption>
          </figure>
          <ol>
            {PHASES.map((phase, index) => (
              <li key={phase.key} className={`ph is-${states[index]}`}>
                <span className="ph-dot" aria-hidden="true">
                  {states[index] === "done" ? (
                    <CheckCircleIcon size={12} weight="fill" />
                  ) : states[index] === "blocked" ? (
                    <WarningCircleIcon size={12} weight="fill" />
                  ) : null}
                </span>
                {phase.label}
                {states[index] === "skipped" ? <span className="ph-skip">생략</span> : null}
                <span className="sr-only">{phaseStateLabel(states[index])}</span>
              </li>
            ))}
          </ol>
        </div>
        <div
          className="stage-progress"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="전체 진행률"
        >
          <span style={{ transform: `scaleX(${Math.min(100, Math.max(0, progress)) / 100})` }} />
        </div>
      </footer>

      {halted ? (
        <HaltOverlay
          listing={listing}
          terminal={terminal}
          blockReasons={blockReasons}
          onReview={onReview}
          onDismiss={onDismiss}
        />
      ) : null}
    </div>
  );
}

function phaseStateLabel(state: string): string {
  switch (state) {
    case "active":
      return " 진행 중";
    case "done":
      return " 완료";
    case "skipped":
      return " 에이전트 판단으로 생략";
    case "blocked":
      return " 여기서 중단";
    default:
      return " 대기";
  }
}

/** 해소 폼을 두지 않는다 — 차단 사유 표시까지만. */
function HaltOverlay({
  listing,
  terminal,
  blockReasons,
  onReview,
  onDismiss,
}: {
  listing: ListingRecord;
  terminal: "needs_review" | "failed";
  blockReasons: string[];
  onReview?: () => void;
  onDismiss?: () => void;
}) {
  // ⚠ "거부" 문자열 매칭은 오판을 만든다 — 네이버 API 거절 메시지에도 "거부"가 들어간다.
  //   에이전트의 자율 거부 판정은 "고위험" 문구로만 식별한다.
  const refused = blockReasons.some((reason) => reason.includes("고위험"));
  const reasons = blockReasons.length > 0 ? blockReasons : listing.error ? [listing.error] : [];

  return (
    <div className="stage-halt" role="alert">
      <div className="stage-halt-card">
        <WarningCircleIcon size={28} weight="fill" aria-hidden="true" />
        <h2>
          {terminal === "needs_review"
            ? refused
              ? "에이전트가 등록을 거부했습니다"
              : "등록 결과를 보고합니다"
            : "등록을 완료하지 못했습니다"}
        </h2>
        <p>
          {terminal === "needs_review"
            ? refused
              ? "자율 판정 — 고위험 의심 상품은 스스로 거르는 것까지가 이 에이전트의 일입니다."
              : "자동 재전송은 중복 등록 위험이 있어 하지 않습니다 — 사유를 그대로 보고합니다."
            : (listing.error ?? "다시 시도해 주세요.")}
        </p>
        {reasons.length > 0 ? (
          <ul>
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        ) : null}
        <div className="stage-halt-actions">
          {terminal === "needs_review" && onReview ? (
            <button type="button" className="btn btn-primary" onClick={onReview}>
              판정 결과 확인
            </button>
          ) : null}
          {onDismiss ? (
            <button type="button" className="btn btn-ghost-dark" onClick={onDismiss}>
              닫기
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ═════════ 결과 쇼케이스 ═════════ */

/** 시세 분포 속 판매가 위치 — 단일 축 스트립 (min–IQR–median–max + 마커). */
function PriceStrip({
  distribution,
  price,
}: {
  distribution: { sampleSize: number; min: number; p25: number; median: number; p75: number; max: number };
  price: number;
}) {
  const span = Math.max(1, distribution.max - distribution.min);
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - distribution.min) / span) * 100));
  const format = (value: number) => `${new Intl.NumberFormat("ko-KR").format(value)}원`;
  return (
    <div
      className="pricestrip"
      role="img"
      aria-label={`시세 ${distribution.sampleSize}건 분포에서 판매가 ${format(price)} 위치`}
    >
      <div className="pricestrip-track">
        <span
          className="pricestrip-iqr"
          style={{
            left: `${pct(distribution.p25)}%`,
            width: `${pct(distribution.p75) - pct(distribution.p25)}%`,
          }}
        />
        <span className="pricestrip-median" style={{ left: `${pct(distribution.median)}%` }} />
        <span className="pricestrip-marker" style={{ left: `${pct(price)}%` }} />
      </div>
      <div className="pricestrip-labels">
        <span>최저 {format(distribution.min)}</span>
        <span>중앙값 {format(distribution.median)}</span>
        <span>최고 {format(distribution.max)}</span>
      </div>
      <p className="pricestrip-note">
        실판매 {distribution.sampleSize}건 · IQR 정제 후 보수적 백분위 → <strong>{format(price)}</strong>
      </p>
    </div>
  );
}

export interface ResultShowcaseProps {
  listing: ListingRecord;
  /** 리허설 재생 결과 — 녹화 런임을 표기한다. */
  rehearsal?: boolean;
  onNew: () => void;
  onList: () => void;
}

/** 완료의 한 방 — 산출물 전시 + 상세 기획 공개. */
export function ResultShowcase({ listing, rehearsal = false, onNew, onList }: ResultShowcaseProps) {
  const [showDetail, setShowDetail] = useState(false);
  const materials = listing.materials;
  const publication = listing.publication;
  const media = materials?.media ?? null;
  const plan = materials?.detailPlan ?? null;
  const draft = listing.draft;

  const beforeUrl = listing.photoUrls[0] ?? null;
  const afterMain = media?.mainUrl ?? listing.photoUrls[0] ?? null;
  const gallery = media?.galleryUrls ?? [];
  // 패널 URL 은 materials 에서 읽는다 — 이벤트는 잘릴 수 있어 신뢰하지 않는다.
  const panelUrls = media?.panelUrls ?? [];
  const productUrl = publication?.productUrl ?? null;
  const detailPreviewUrl = media?.detailPreviewUrl ?? null;
  const isLive = publication?.mode === "live" && publication?.liveStatus === "registered";
  const holds = publication?.holdReasons ?? [];

  const distribution = materials?.price?.distribution ?? null;
  const salePrice = materials?.price?.salePrice ?? draft?.salePrice ?? null;
  const tags = materials?.tags?.tags ?? (draft?.tags ?? []).map((text) => ({ text, official: true }));
  const categoryPath = (materials?.category?.categoryName ?? draft?.categoryName ?? "")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  const timings = materials?.timings ?? null;
  const attempts = materials?.category?.match?.attempts ?? [];

  const priceText = useMemo(
    () => (salePrice ? `${new Intl.NumberFormat("ko-KR").format(salePrice)}원` : ""),
    [salePrice],
  );

  useEffect(() => {
    if (!showDetail) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowDetail(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDetail]);

  return (
    <section className="rs">
      <header className="rs-head">
        <p className={`rs-status${isLive ? " is-live" : ""}`}>
          <CheckCircleIcon size={15} weight="fill" aria-hidden="true" />
          {isLive ? "스마트스토어에 등록됐습니다" : "등록안이 완성됐습니다"}
        </p>
        {rehearsal ? (
          <p className="rs-rehearsal">리허설 재생 결과 — 녹화된 실런의 산출물입니다</p>
        ) : null}
        <h2>{materials?.registrationTitle ?? draft?.title ?? "등록안"}</h2>
        <p className="rs-head-meta">
          <strong>{priceText}</strong>
          {categoryPath.length > 0 ? <span> · {categoryPath[categoryPath.length - 1]}</span> : null}
          {publication?.channelProductNo ? (
            <span className="mono"> · 상품번호 {publication.channelProductNo}</span>
          ) : null}
        </p>
        {holds.length > 0 ? (
          <div className="rs-hold" role="note">
            <strong>스토어에 올리지는 못했습니다 — 등록안은 완성됐습니다</strong>
            <ul>
              {holds.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </header>

      {/*
        완성 보드 — 첫 화면에서 "사진 한 장이 이만큼이 됐다"가 통째로 보여야 한다.
        대표 이미지 하나만 크게 걸면 무엇이 더 만들어졌는지가 스크롤 아래로 숨는다.
      */}
      <div className="rs-board" aria-label="에이전트가 만든 등록물">
        <figure className="rs-src">
          {beforeUrl ? <img src={beforeUrl} alt="업로드한 원본 사진" /> : null}
          <figcaption>내가 올린 사진</figcaption>
        </figure>

        <span className="rs-flow" aria-hidden="true">
          <ArrowRightIcon size={17} weight="bold" />
        </span>

        <div className="rs-made">
          <figure className="rs-hero">
            {afterMain ? <img src={afterMain} alt="에이전트가 만든 대표 이미지" /> : null}
            <figcaption>대표 이미지</figcaption>
          </figure>

          <div className="rs-made-rest">
            {gallery.length > 0 ? (
              <figure className="rs-shots">
                <div className="rs-shots-row">
                  {gallery.slice(0, 3).map((url, index) => (
                    <img
                      key={url}
                      src={url}
                      alt="추가 연출 컷"
                      style={{ animationDelay: `${240 + index * 90}ms` }}
                    />
                  ))}
                </div>
                <figcaption>추가 컷 {gallery.length}장</figcaption>
              </figure>
            ) : null}

            {panelUrls.length > 0 ? (
              <figure className="rs-panels">
                <div className="rs-panels-row">
                  {panelUrls.slice(0, 6).map((url, index) => (
                    <img
                      key={url}
                      src={url}
                      alt="상세페이지 패널"
                      style={{ animationDelay: `${380 + index * 70}ms` }}
                    />
                  ))}
                </div>
                <figcaption>상세페이지 {panelUrls.length}컷</figcaption>
              </figure>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rs-actions">
        {productUrl ? (
          <a className="btn btn-primary" href={productUrl} target="_blank" rel="noreferrer">
            스마트스토어에서 보기 <ArrowUpRightIcon size={15} weight="bold" aria-hidden="true" />
          </a>
        ) : null}
        {detailPreviewUrl ? (
          <button
            type="button"
            className={productUrl ? "btn btn-ghost" : "btn btn-primary"}
            onClick={() => setShowDetail(true)}
          >
            상세페이지 보기
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onNew}>
          새 상품 올리기
        </button>
        <button type="button" className="btn btn-ghost" onClick={onList}>
          올린 물건 목록
        </button>
      </div>

      <p className="rs-more" aria-hidden="true">
        등록에 들어간 내용
      </p>

      <div className="rs-grid">
        {plan ? (
          <article className="rs-cell rs-plan">
            <h3>상세페이지 기획</h3>
            <p className="rs-concept">“{plan.concept}”</p>
            <p className="rs-angle">{plan.angle}</p>
            <ol className="rs-sections">
              {plan.sections.map((section, index) => (
                <li key={`${section.role}-${index}`}>
                  <span className="rs-role">{ROLE_LABEL[section.role] ?? section.role}</span>
                  <span>{section.heading}</span>
                  {section.panel ? <i className="rs-panel-dot" aria-hidden="true" /> : null}
                </li>
              ))}
            </ol>
            <p className="rs-cell-note">
              세로 패널 {media?.panelCount ?? panelUrls.length}장 · 서사 순서대로 본문에 배치됨
              {detailPreviewUrl ? (
                <button type="button" className="rs-inline-btn" onClick={() => setShowDetail(true)}>
                  상세페이지 열기
                </button>
              ) : null}
            </p>
          </article>
        ) : null}

        <article className="rs-cell">
          <h3>판매가</h3>
          <p className="rs-price">{priceText || "—"}</p>
          {distribution && salePrice ? (
            <PriceStrip distribution={distribution} price={salePrice} />
          ) : (
            <p className="rs-cell-note">{materials?.price?.priceBasis ?? draft?.priceBasis ?? "—"}</p>
          )}
        </article>

        <article className="rs-cell">
          <h3>카테고리</h3>
          <p className="rs-breadcrumb">
            {categoryPath.length > 0
              ? categoryPath.map((part, index) => (
                  <span key={`${part}-${index}`}>
                    {part}
                    {index < categoryPath.length - 1 ? <i aria-hidden="true">›</i> : null}
                  </span>
                ))
              : "미확정"}
          </p>
          {/* 의미 없는 0을 크게 띄우지 않는다 — 라운드 수는 실재할 때만 말한다. */}
          <p className="rs-cell-note">
            {materials?.category?.verified
              ? `LLM 검증 통과${attempts.length > 0 ? ` · ${attempts.length}라운드` : ""}`
              : "후보 채택 — 검증 미통과"}
          </p>
        </article>

        <article className="rs-cell">
          <h3>태그 {tags.length}</h3>
          <p className="rs-tags">
            {tags.slice(0, 8).map((tag) => (
              <span key={tag.text} className={tag.official ? "" : "is-unofficial"}>
                #{tag.text}
              </span>
            ))}
          </p>
          <p className="rs-cell-note">
            {materials?.tags?.dictionaryChecked
              ? "공식 태그 사전 대조 완료 — 회색 칩은 비공식 태그"
              : "태그 정규화 적용 — 공식 사전 대조 미완"}
          </p>
        </article>

        <article className="rs-cell">
          <h3>등록 정보</h3>
          <ul className="rs-checks">
            <li>원산지 {materials?.origin?.originAreaInfo?.content ?? "—"}</li>
            {/* statusLabel 이 이미 "KC …" 로 시작한다 — 키를 덧붙이면 KC 가 두 번 나온다. */}
            <li>KC {materials?.kc ? (KC_LABEL[materials.kc.status] ?? materials.kc.statusLabel) : "—"}</li>
            <li>
              고시{" "}
              {materials?.notice?.typeUnconfirmed
                ? "유형 미확인 — 기타 재화로 등록"
                : (materials?.notice?.noticeTypeName ?? materials?.notice?.noticeType ?? "—")}
            </li>
            <li>
              이미지 {(media?.galleryCount ?? gallery.length) + (media?.mainUrl ? 1 : 0)}장 · 상세 패널{" "}
              {media?.panelCount ?? panelUrls.length}장
            </li>
          </ul>
          {timings ? (
            <p className="rs-timings">
              카테고리 {(timings.category / 1000).toFixed(1)}s · 재료 {(timings.materials / 1000).toFixed(1)}s
              · 상세 {(timings.detail / 1000).toFixed(1)}s · 등록 {(timings.register / 1000).toFixed(1)}s
            </p>
          ) : null}
        </article>
      </div>

      {showDetail && detailPreviewUrl ? (
        <div className="detail-modal" role="dialog" aria-modal="true" onClick={() => setShowDetail(false)}>
          <div className="detail-modal-frame" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="detail-modal-close" onClick={() => setShowDetail(false)}>
              닫기
            </button>
            <iframe src={detailPreviewUrl} title="상세페이지 미리보기" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
