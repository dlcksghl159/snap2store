import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatElapsed, formatPrice } from "./api";
import { ListingFrame, RevealCard, useRevealDirector } from "./Assembly";
import {
  PHASES,
  REVEAL_ORDER,
  ROLE_LABEL,
  SCENE_HEADLINE,
  SCENE_SUB,
  applyEvent,
  initialDerived,
  phaseStates,
  sceneOf,
  type ControlDerived,
} from "./stage-model";
import type { ListingRecord, LiveEvent } from "./domain/types";

const TERMINAL = new Set(["registered", "needs_review", "failed"]);

export interface MissionControlProps {
  listing: ListingRecord;
  /** 리허설 드라이버 전용 — 주어지면 SSE 를 구독하지 않는다. */
  feed?: LiveEvent[];
  rehearsal?: boolean;
  /** 종착 보고를 닫는다. 파이프라인 입력이 아니라 화면 이동일 뿐이다. */
  onDismiss?: () => void;
  onOpenList?: () => void;
}

export function MissionControl({
  listing,
  feed,
  rehearsal = false,
  onDismiss,
  onOpenList,
}: MissionControlProps) {
  const [derived, setDerived] = useState<ControlDerived>(initialDerived);
  const [elapsed, setElapsed] = useState(0);
  const listingIdRef = useRef(listing.id);
  const lastSeqRef = useRef(0);
  const slotsRef = useRef(new Map<string, HTMLElement>());

  listingIdRef.current = listing.id;

  /* SSE 구독 */
  useEffect(() => {
    if (feed) return;
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
  }, [feed]);

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

  /* T+ 시계 */
  useEffect(() => {
    const started = new Date(listing.createdAt).getTime();
    const base = Number.isNaN(started) ? Date.now() : started;
    const tick = () => setElapsed(Date.now() - base);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [listing.createdAt]);

  const terminalStatus = TERMINAL.has(listing.status)
    ? (listing.status as "registered" | "needs_review" | "failed")
    : null;
  const isTerminal = terminalStatus !== null;
  const stage = derived.liveStage ?? listing.stage;
  const scene = sceneOf(stage, derived, terminalStatus);
  const states = phaseStates(derived, stage, terminalStatus);
  const progress = terminalStatus === "registered" ? 1 : Math.min(1, (derived.liveProgress || listing.progress) / 100);
  const liveRegistered =
    listing.publication?.mode === "live" && listing.publication?.liveStatus === "registered";

  const registerSlot = useCallback((key: string, node: HTMLElement | null) => {
    if (node) slotsRef.current.set(key, node);
    else slotsRef.current.delete(key);
  }, []);

  const slotRef = useCallback((key: string) => slotsRef.current.get(key) ?? null, []);
  const shotUrlBySlot = useCallback(
    (slot: string) => {
      if (slot === "thumb") return derived.shots.find((shot) => shot.index === 0)?.url ?? null;
      const gallery = slot.match(/^gallery-(\d+)$/);
      if (gallery) return derived.shots.filter((shot) => shot.index > 0)[Number(gallery[1])]?.url ?? null;
      const panel = slot.match(/^panel-(\d+)$/);
      if (panel) return derived.panels[Number(panel[1])]?.url ?? null;
      return null;
    },
    [derived.panels, derived.shots],
  );

  /**
   * 아직 도착하지 않았지만 곧 올 산출물의 서사 순번.
   * 리빌 디렉터가 이걸 보고 앞 순번을 기다린다 — 병렬 실행이어도 화면은 순서대로 읽힌다.
   */
  const expectedOrders = useMemo(() => {
    const pending: number[] = [];
    if (!derived.productGroup) pending.push(REVEAL_ORDER.productGroup);
    if (!derived.categoryPath) pending.push(REVEAL_ORDER.category);
    if (!derived.shots.some((shot) => shot.index === 0)) pending.push(REVEAL_ORDER.mainImage);
    if (derived.shotDone < derived.shotStarts) pending.push(REVEAL_ORDER.gallery);
    if (derived.price == null) pending.push(REVEAL_ORDER.price);
    if (!derived.seoTitle) pending.push(REVEAL_ORDER.title);
    if (!derived.noticeType) pending.push(REVEAL_ORDER.requiredFields);
    if (derived.planStarted && !derived.plan) pending.push(REVEAL_ORDER.detailPlan);
    return pending;
  }, [
    derived.categoryPath,
    derived.noticeType,
    derived.plan,
    derived.planStarted,
    derived.price,
    derived.productGroup,
    derived.seoTitle,
    derived.shotDone,
    derived.shotStarts,
    derived.shots,
  ]);

  const reveal = useRevealDirector({
    cards: derived.cards,
    slotRef,
    terminal: isTerminal,
    expectedOrders,
    shotUrlBySlot,
  });

  const headline = SCENE_HEADLINE[scene] ?? derived.liveLabel ?? listing.stageLabel;
  // 상품명 2단 착지는 **한 번만** 일어난다: 상품군 → 확정된 등록 상품명.
  // draft.title 을 중간에 끼우면 교체가 두 번 일어나 "대충 만든 이름"으로 읽힌다.
  const finalTitle = listing.materials?.registrationTitle ?? null;
  const revealMedia = reveal.card?.slot ? shotUrlBySlot(reveal.card.slot) : null;

  return (
    <div className="stage" role="region" aria-label="등록 실황">
      <div className="stage-top">
        <span className="stage-brand">
          Snap2Store<em>등록 실황</em>
        </span>
        <div className="stage-chips">
          {rehearsal ? <span className="stage-chip">녹화된 실런 재생 — 실제 에이전트 실행 아님</span> : null}
          <span className="stage-chip stage-chip-mono stage-chip-run">RUN {listing.id.slice(0, 8)}</span>
          <span className="stage-chip stage-chip-mono">T+{formatElapsed(elapsed)}</span>
          <a
            className="stage-chip stage-chip-mono stage-chip-link stage-chip-raw"
            href="/stream"
            target="_blank"
            rel="noreferrer"
          >
            RAW {derived.rawCount.toLocaleString("ko-KR")} ↗
          </a>
        </div>
      </div>

      <div className="stage-lede">
        <h2 className={scene === "complete" ? "finish" : ""} aria-live="polite">
          {headline}
        </h2>
        <p>{SCENE_SUB[scene]}</p>
      </div>

      <div className="stage-arena">
        <ListingFrame
          derived={derived}
          finalTitle={finalTitle}
          tags={(listing.materials?.tags.tags ?? []).map((tag) => tag.text)}
          complete={terminalStatus === "registered"}
          live={liveRegistered}
          targetSlot={reveal.targetSlot}
          heldSlots={reveal.heldSlots}
          registerSlot={registerSlot}
        />
        {reveal.card ? <div className="reveal-scrim" /> : null}
        {reveal.card ? (
          <RevealCard card={reveal.card} cardRef={reveal.cardRef} mediaUrl={revealMedia} />
        ) : null}
        {terminalStatus && terminalStatus !== "registered" ? (
          <HaltOverlay
            listing={listing}
            terminal={terminalStatus}
            onDismiss={onDismiss}
            onOpenList={onOpenList}
          />
        ) : null}
      </div>

      <div>
        <div className="stage-strip">
          <div className="evidence" data-launch-target="evidence">
            {listing.photoUrls[0] ? <img src={listing.photoUrls[0]} alt="내가 올린 사진" /> : null}
          </div>
          <ol className="phase-rail">
            {PHASES.map((phase, index) => (
              <li key={phase.key} className={`phase ${states[index]}`}>
                <i />
                <b>{index + 1}</b>
                {phase.label}
                {states[index] === "skipped" ? <u>생략</u> : null}
                <span className="sr-only">{phaseStateLabel(states[index])}</span>
              </li>
            ))}
          </ol>
        </div>
        <div
          className={`progress ${terminalStatus === "registered" ? "done" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ "--p": progress } as React.CSSProperties} />
        </div>
      </div>
    </div>
  );
}

function phaseStateLabel(state: string): string {
  switch (state) {
    case "active":
      return "진행 중";
    case "done":
      return "완료";
    case "skipped":
      return "에이전트 판단으로 생략";
    case "blocked":
      return "여기서 중단";
    default:
      return "대기";
  }
}

/** 해소 폼을 두지 않는다 — 차단 사유 표시까지만. */
function HaltOverlay({
  listing,
  terminal,
  onDismiss,
  onOpenList,
}: {
  listing: ListingRecord;
  terminal: "needs_review" | "failed";
  onDismiss?: () => void;
  onOpenList?: () => void;
}) {
  const refused = listing.blockReasons.some((reason) => reason.includes("거부"));
  const copy =
    terminal === "needs_review"
      ? refused
        ? {
            h2: "에이전트가 등록을 거부했습니다",
            p: "자율 판정 — 고위험 의심 상품은 스스로 거르는 것까지가 이 에이전트의 일입니다.",
          }
        : {
            h2: "등록 결과를 보고합니다",
            p: "자동 재전송은 중복 등록 위험이 있어 하지 않습니다 — 사유를 그대로 보고합니다.",
          }
      : { h2: "등록을 완료하지 못했습니다", p: listing.error ?? "실행 중 오류가 발생했습니다." };

  const reasons = listing.blockReasons.length > 0 ? listing.blockReasons : listing.error ? [listing.error] : [];

  return (
    <div className="halt">
      <div className="halt-card">
        <h2>{copy.h2}</h2>
        <p>{copy.p}</p>
        {reasons.length > 0 ? (
          <ul className="halt-reasons">
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        ) : null}
        {/* 해소 폼이 아니다 — 종착 보고를 읽고 나가는 화면 이동일 뿐이다. */}
        {onDismiss || onOpenList ? (
          <div className="rs-actions" style={{ marginBottom: 0 }}>
            {onOpenList ? (
              <button type="button" className="btn btn-ghost-dark" onClick={onOpenList}>
                올린 물건 목록
              </button>
            ) : null}
            {onDismiss ? (
              <button type="button" className="btn btn-ghost-dark" onClick={onDismiss}>
                새 상품 올리기
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ═════════ 결과 화면 ═════════ */

export interface ResultShowcaseProps {
  listing: ListingRecord;
  onNew: () => void;
  onList: () => void;
}

export function ResultShowcase({ listing, onNew, onList }: ResultShowcaseProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const materials = listing.materials;
  const publication = listing.publication;
  const live = publication?.mode === "live" && publication.liveStatus === "registered";
  const holds = publication?.holdReasons ?? [];

  const mainUrl = materials?.media.mainUrl ?? listing.photoUrls[0] ?? null;
  const galleryUrls = materials?.media.galleryUrls ?? [];
  // 패널 URL 은 materials 에서 읽는다 — 이벤트는 160건에서 잘리므로 신뢰하지 않는다.
  const panelUrls = materials?.media.panelUrls ?? [];
  const timings = materials?.timings;

  useEffect(() => {
    if (!previewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewOpen]);

  return (
    <div className="rs">
      <div className="rs-head">
        <span className={`rs-badge ${live ? "" : "hold"}`}>
          <i aria-hidden>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5 6.2 11.7 13 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </i>
          {live ? "스마트스토어에 등록됐습니다" : "등록안이 완성됐습니다"}
        </span>
        <h1>{materials?.registrationTitle ?? listing.draft?.title ?? "등록안"}</h1>
        <div className="rs-facts">
          <b>{formatPrice(materials?.price.salePrice ?? listing.draft?.salePrice)}</b>
          <span>·</span>
          <span>{materials?.category.leafName ?? materials?.category.categoryName ?? "카테고리 미확정"}</span>
          {publication?.channelProductNo ? (
            <>
              <span>·</span>
              <span className="mono">상품번호 {publication.channelProductNo}</span>
            </>
          ) : null}
        </div>
        {holds.length > 0 ? (
          <div className="rs-hold">
            <b>스토어에 올리지는 못했습니다 — 등록안은 완성됐습니다</b>
            <ul>
              {holds.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* 완성 보드 — 원본 → 대표 + 추가컷 + 상세컷을 첫 화면에 통째로 */}
      <div className="rs-board">
        <div className="rs-before">
          {listing.photoUrls[0] ? <img src={listing.photoUrls[0]} alt="내가 올린 사진" /> : null}
          <span className="rs-cap">내가 올린 사진</span>
        </div>
        <div className="rs-arrow" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="rs-after">
          <div className="rs-main">
            {mainUrl ? <img src={mainUrl} alt="대표 이미지" /> : null}
            <span className="rs-cap">대표 이미지</span>
          </div>
          <div className="rs-cuts">
            {galleryUrls.length > 0 ? (
              <div>
                <div className="rs-cut-row">
                  {galleryUrls.map((url, index) => (
                    <img key={url} src={url} alt={`추가 컷 ${index + 1}`} />
                  ))}
                </div>
                <span className="rs-cap" style={{ textAlign: "left", display: "block", marginTop: 4 }}>
                  추가 컷 {galleryUrls.length}장
                </span>
              </div>
            ) : null}
            {panelUrls.length > 0 ? (
              <div>
                <div className="rs-cut-row panels">
                  {panelUrls.map((url, index) => (
                    <img key={url} src={url} alt={`상세 ${index + 1}컷`} />
                  ))}
                </div>
                <span className="rs-cap" style={{ textAlign: "left", display: "block", marginTop: 4 }}>
                  상세페이지 {panelUrls.length}컷
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rs-actions">
        {publication?.productUrl ? (
          <a className="btn btn-primary" href={publication.productUrl} target="_blank" rel="noreferrer">
            스마트스토어에서 보기 <span className="arrow">↗</span>
          </a>
        ) : null}
        {materials?.media.detailPreviewUrl ? (
          <button type="button" className="btn btn-ghost" onClick={() => setPreviewOpen(true)}>
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

      <div className="rs-grid">
        {materials?.detailPlan ? (
          <section className="rs-cell" style={{ "--i": 0 } as React.CSSProperties}>
            <h3>상세페이지 기획</h3>
            <p className="rs-quote">“{materials.detailPlan.concept}”</p>
            <p className="rs-sub">{materials.detailPlan.angle}</p>
            <div className="rs-roles">
              {materials.detailPlan.sections.map((section, index) => (
                <div className="rs-role" key={index}>
                  <u>{ROLE_LABEL[section.role] ?? section.role}</u>
                  <span>{section.heading}</span>
                  <i className={section.panel ? "on" : ""} />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="rs-cell" style={{ "--i": 1 } as React.CSSProperties}>
          <h3>판매가</h3>
          <p className="rs-quote">{formatPrice(materials?.price.salePrice)}</p>
          <p className="rs-sub">{materials?.price.priceBasis ?? listing.draft?.priceBasis ?? "—"}</p>
        </section>

        <section className="rs-cell" style={{ "--i": 2 } as React.CSSProperties}>
          <h3>카테고리</h3>
          <p className="rs-quote" style={{ fontSize: 15 }}>
            {materials?.category.categoryName ?? "미확정"}
          </p>
          {/* 의미 없는 0을 크게 띄우지 않는다 — 라운드 수는 실재할 때만 말한다. */}
          <p className="rs-sub">
            {materials?.category.verified
              ? `검증 통과${
                  (materials.category.match?.attempts.length ?? 0) > 0
                    ? ` · ${materials.category.match!.attempts.length}라운드`
                    : ""
                }`
              : "후보 채택 — 검증 미통과"}
          </p>
        </section>

        <section className="rs-cell" style={{ "--i": 3 } as React.CSSProperties}>
          <h3>검색 태그</h3>
          <div className="tag-row" style={{ gap: 6 }}>
            {(materials?.tags.tags ?? []).map((tag) => (
              <span key={tag.text} className={`tag-chip ${tag.official ? "" : "unofficial"}`}>
                {tag.text}
              </span>
            ))}
          </div>
          <p className="rs-note">
            {materials?.tags.dictionaryChecked
              ? "공식 사전 대조 완료 — 회색 칩은 비공식 태그"
              : "태그 정규화 적용 — 공식 사전 대조 미완"}
          </p>
        </section>

        <section className="rs-cell" style={{ "--i": 4 } as React.CSSProperties}>
          <h3>등록 정보</h3>
          <div className="rs-kv">
            <div>
              <b>원산지</b>
              <span>{materials?.origin.originAreaInfo?.content ?? "—"}</span>
            </div>
            <div>
              <b>KC</b>
              <span>{materials?.kc.statusLabel ?? "—"}</span>
            </div>
            <div>
              <b>고시</b>
              <span>
                {materials?.notice.typeUnconfirmed
                  ? "고시 유형 미확인 — 기타 재화로 등록"
                  : (materials?.notice.noticeTypeName ?? materials?.notice.noticeType ?? "—")}
              </span>
            </div>
            <div>
              <b>이미지</b>
              <span>
                대표 1 · 추가 {galleryUrls.length} · 상세 {panelUrls.length}
              </span>
            </div>
            {timings ? (
              <div>
                <b>소요</b>
                <span className="mono">
                  카테고리 {(timings.category / 1000).toFixed(1)}s · 재료 {(timings.materials / 1000).toFixed(1)}s ·
                  상세 {(timings.detail / 1000).toFixed(1)}s · 등록 {(timings.register / 1000).toFixed(1)}s
                </span>
              </div>
            ) : null}
            <div>
              <b>시각</b>
              <span>{formatDate(listing.createdAt)}</span>
            </div>
          </div>
        </section>
      </div>

      {previewOpen && materials?.media.detailPreviewUrl ? (
        <div className="modal" onClick={() => setPreviewOpen(false)} role="presentation">
          <div className="modal-frame" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="상세페이지 미리보기">
            <div className="modal-bar">
              상세페이지 미리보기
              <button
                type="button"
                className="drawer-close"
                onClick={() => setPreviewOpen(false)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>
            <iframe src={materials.media.detailPreviewUrl} title="상세페이지 미리보기" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function useWarningList(listing: ListingRecord): string[] {
  return useMemo(() => [...new Set(listing.warnings)], [listing.warnings]);
}
