import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControlDerived, FeedCard } from "./stage-model";
import { ROLE_LABEL } from "./stage-model";

/* ═════════ 조립 틀 ═════════
   스마트스토어 상품 페이지 모양의 틀. 빈 슬롯이 스스로 칸 이름을 말한다 — 회색 사각형 금지. */

const GALLERY_SLOTS = 3;
const PANEL_SLOTS = 6;

interface SlotProps {
  slotKey: string;
  className?: string;
  filled: boolean;
  target: boolean;
  ghostTitle: string;
  ghostHint?: string;
  register: (key: string, node: HTMLElement | null) => void;
  children?: React.ReactNode;
}

function Slot({
  slotKey,
  className = "",
  filled,
  target,
  ghostTitle,
  ghostHint,
  register,
  children,
}: SlotProps) {
  const ref = useCallback(
    (node: HTMLElement | null) => register(slotKey, node),
    [register, slotKey],
  );
  return (
    <div
      ref={ref}
      data-slot={slotKey}
      className={`slot ${className} ${filled ? "is-filled" : ""} ${target && !filled ? "is-target" : ""}`}
    >
      {filled ? (
        children
      ) : (
        <div className="slot-ghost">
          <b>{ghostTitle}</b>
          {ghostHint ? <span>{ghostHint}</span> : null}
        </div>
      )}
    </div>
  );
}

export interface ListingFrameProps {
  derived: ControlDerived;
  finalTitle: string | null;
  /** 레코드에 저장된 실제 태그. 없으면 개수만 표기한다. */
  tags: string[];
  complete: boolean;
  live: boolean;
  targetSlot: string | null;
  registerSlot: (key: string, node: HTMLElement | null) => void;
}

export function ListingFrame({
  derived,
  finalTitle,
  tags,
  complete,
  live,
  targetSlot,
  registerSlot,
}: ListingFrameProps) {
  const main = derived.shots.find((shot) => shot.index === 0) ?? null;
  const gallery = derived.shots.filter((shot) => shot.index > 0);
  const crumbParts = (derived.categoryPath ?? "").split(">").map((part) => part.trim()).filter(Boolean);

  // 상품명 2단 착지 — 처음 꽂히는 값은 상품명이 아니라 인식한 상품군이다.
  const provisional = derived.productGroup;
  const settled = finalTitle ?? derived.seoTitle;
  const titleFilled = Boolean(provisional || settled);

  return (
    <div className="frame">
      <div className="frame-chrome">
        <div className="frame-dots">
          <i />
          <i />
          <i />
        </div>
        <div className="frame-url">
          {complete && live ? (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M3 8.5 6.2 11.7 13 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
          smartstore.naver.com
        </div>
        <div className="frame-state">
          {complete ? (live ? "등록됨" : "등록안 완성") : "조립 중"}
        </div>
      </div>

      <div className="frame-body">
        <div className="frame-media">
          <Slot
            slotKey="thumb"
            className="slot-thumb"
            filled={Boolean(main)}
            target={targetSlot === "thumb"}
            ghostTitle="대표 이미지"
            ghostHint="검색 결과에 뜨는 첫 얼굴"
            register={registerSlot}
          >
            {main ? <img src={main.url} alt="대표 이미지" /> : null}
          </Slot>

          <div className="frame-gallery">
            {Array.from({ length: GALLERY_SLOTS }, (_, index) => {
              const shot = gallery[index];
              return (
                <Slot
                  key={index}
                  slotKey={`gallery-${index}`}
                  className="slot-gal"
                  filled={Boolean(shot)}
                  target={targetSlot === `gallery-${index}`}
                  ghostTitle="추가 컷"
                  register={registerSlot}
                >
                  {shot ? <img src={shot.url} alt={`추가 컷 ${index + 1}`} /> : null}
                </Slot>
              );
            })}
          </div>

        </div>

        {/* 상세 밴드는 틀 전체 폭을 쓴다 — media 안에 두면 갤러리와 행이 충돌한다. */}
        <div className="frame-detail">
          <Slot
            slotKey="plan"
            className="slot-text"
            filled={Boolean(derived.plan)}
            target={targetSlot === "plan"}
            ghostTitle="상세페이지"
            ghostHint="본문 — 구매를 결정짓는 자리"
            register={registerSlot}
          >
            {derived.plan ? (
              <div className="detail-head">
                <b>상세 기획</b>
                <span className="detail-concept">{derived.plan.concept}</span>
                <span className="detail-angle">{derived.plan.angle}</span>
              </div>
            ) : null}
          </Slot>

          <div className="panel-row">
            {Array.from({ length: PANEL_SLOTS }, (_, index) => {
              const panel = derived.panels[index];
              const planned = derived.plan?.sections.filter((section) => section.hasPanel)[index];
              return (
                <Slot
                  key={index}
                  slotKey={`panel-${index}`}
                  className="panel-slot"
                  filled={Boolean(panel)}
                  target={targetSlot === `panel-${index}`}
                  ghostTitle={planned ? (ROLE_LABEL[planned.role] ?? planned.role) : String(index + 1)}
                  register={registerSlot}
                >
                  {panel ? <img src={panel.url} alt={panel.headline || `상세 ${index + 1}컷`} /> : null}
                </Slot>
              );
            })}
          </div>
        </div>

        <div className="frame-info">
          <Slot
            slotKey="crumb"
            className="slot-text"
            filled={crumbParts.length > 0}
            target={targetSlot === "crumb"}
            ghostTitle="카테고리"
            register={registerSlot}
          >
            <>
              <div className="slot-label">카테고리</div>
              <div className="slot-value crumb">
                {crumbParts.map((part, index) => (
                  <span key={index}>
                    {index > 0 ? " › " : ""}
                    {index === crumbParts.length - 1 ? <b>{part}</b> : part}
                  </span>
                ))}
                {!derived.categoryVerified && crumbParts.length > 0 ? (
                  <span className="title-provisional">
                    {" "}
                    <u>검증 미통과</u>
                  </span>
                ) : null}
              </div>
            </>
          </Slot>

          <Slot
            slotKey="title"
            className="slot-text"
            filled={titleFilled}
            target={targetSlot === "title"}
            ghostTitle="상품명"
            register={registerSlot}
          >
            <>
              <div className="slot-label">상품명</div>
              {settled ? (
                <div className="slot-value title-swap" key={settled}>
                  {settled}
                </div>
              ) : (
                <>
                  <div className="slot-value title-provisional">
                    <u>상품군</u> {provisional}
                  </div>
                  <div className="title-note">상품명은 검색 수요로 다시 씁니다</div>
                </>
              )}
            </>
          </Slot>

          <Slot
            slotKey="price"
            className="slot-text"
            filled={derived.price != null}
            target={targetSlot === "price"}
            ghostTitle="판매가"
            register={registerSlot}
          >
            <>
              <div className="slot-label">판매가</div>
              <div className="slot-value price">
                {derived.price != null ? `${derived.price.toLocaleString("ko-KR")}원` : ""}
              </div>
              <div className="title-note">
                {derived.priceSample > 0
                  ? `시세 표본 ${derived.priceSample}건`
                  : "에이전트 추정 — 사진·상품 정보 근거"}
              </div>
            </>
          </Slot>

          <Slot
            slotKey="tags"
            className="slot-text"
            filled={derived.tagCount > 0}
            target={targetSlot === "tags"}
            ghostTitle="검색 태그"
            register={registerSlot}
          >
            {/* 태그 본문은 재료가 레코드에 저장된 뒤에야 실재한다.
                그 전에는 개수만 말한다 — 이름을 지어내지 않는다. */}
            <>
              <div className="slot-label">검색 태그</div>
              {tags.length > 0 ? (
                <div className="tag-row">
                  {tags.slice(0, 10).map((tag, index) => (
                    <span key={tag} style={{ "--i": index } as React.CSSProperties}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : (
                <>
                  <div className="slot-value">{derived.tagCount}개</div>
                  <div className="title-note">정규화 · 제한 태그 대조를 거친 검색 태그</div>
                </>
              )}
            </>
          </Slot>

          <Slot
            slotKey="meta"
            className="slot-text"
            filled={Boolean(derived.noticeType || derived.kcStatus || derived.originResolved != null)}
            target={targetSlot === "meta"}
            ghostTitle="필수 표시 항목"
            ghostHint="법으로 요구되는 칸"
            register={registerSlot}
          >
            <>
              <div className="slot-label">필수 표시 항목</div>
              <div className="meta-grid">
                <div className="meta-cell">
                  <b>원산지</b>
                  <span>{derived.originResolved ? "확정" : "설정 기본값"}</span>
                </div>
                <div className="meta-cell">
                  <b>KC</b>
                  <span>{kcLabel(derived.kcStatus)}</span>
                </div>
                <div className="meta-cell">
                  <b>고시</b>
                  <span>{derived.noticeType ?? "—"}</span>
                </div>
                <div className="meta-cell">
                  <b>상품속성</b>
                  <span>{derived.attributeCount}건</span>
                </div>
              </div>
            </>
          </Slot>
        </div>
      </div>

      {/* 등록필 도장 — 실제로 스토어에 올라갔을 때만 찍는다. */}
      {complete && live ? (
        <div className="frame-stamp">
          등록<u>SMARTSTORE</u>
        </div>
      ) : null}
    </div>
  );
}

function kcLabel(status: string | null): string {
  switch (status) {
    case "not_target":
      return "대상 아님";
    case "safe_criterion":
      return "안전기준 준수";
    case "certified":
      return "인증 등록";
    case "child_fallback":
      return "어린이제품";
    case "unknown":
      return "확인 실패";
    default:
      return "—";
  }
}

/* ═════════ 리빌 디렉터 ═════════
   산출물이 완성될 때마다 화면 중앙에 크게 등장했다가 축소되며 슬롯에 장착된다 (FLIP + WAAPI). */

const MOUNT_GRACE_MS = 700;

function holdMs(size: FeedCard["size"], backlog: number): number {
  if (backlog > 4) return 260;
  if (backlog > 2) return 560;
  if (size === "hero") return 1650;
  if (size === "medium") return 1050;
  return 420;
}

function enterMs(size: FeedCard["size"]): number {
  return size === "quick" ? 220 : 380;
}

function flyMs(size: FeedCard["size"]): number {
  return size === "quick" ? 400 : 640;
}

export interface RevealDirectorOptions {
  cards: FeedCard[];
  slotRef: (key: string) => HTMLElement | null;
  terminal: boolean;
  shotUrlBySlot: (slot: string) => string | null;
}

export interface RevealState {
  card: FeedCard | null;
  targetSlot: string | null;
  cardRef: (node: HTMLDivElement | null) => void;
}

export function useRevealDirector({
  cards,
  slotRef,
  terminal,
  shotUrlBySlot,
}: RevealDirectorOptions): RevealState {
  const [active, setActive] = useState<FeedCard | null>(null);
  const queueRef = useRef<FeedCard[]>([]);
  const seenRef = useRef(new Set<string>());
  const busyRef = useRef(false);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const mountedAtRef = useRef(0);
  const reduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);

  const pump = useCallback(() => {
    if (busyRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    busyRef.current = true;
    setActive(next);
  }, []);

  // 새 산출물 감지 → 큐 적재
  useEffect(() => {
    let added = false;
    for (const card of cards) {
      if (seenRef.current.has(card.id)) continue;
      seenRef.current.add(card.id);
      // 마운트 직후 700ms 안에 도착하는 산출물(백필·새로고침)은 소리 없이 장착한다.
      if (Date.now() - mountedAtRef.current < MOUNT_GRACE_MS) continue;
      if (!card.slot) continue;
      queueRef.current.push(card);
      added = true;
    }
    if (added) pump();
  }, [cards, pump]);

  // 종착·reduced-motion — 대기 중인 리빌을 전부 즉시 장착하고 오버레이를 끈다.
  useEffect(() => {
    if (!terminal && !reduced) return;
    queueRef.current = [];
    busyRef.current = false;
    setActive(null);
  }, [terminal, reduced]);

  // 등장 → 홀드 → 비행 → docked
  useEffect(() => {
    if (!active) return;
    if (reduced || terminal) {
      busyRef.current = false;
      setActive(null);
      return;
    }
    const node = nodeRef.current;
    if (!node) return;

    let cancelled = false;
    const backlog = queueRef.current.length;
    const enter = enterMs(active.size);
    const hold = holdMs(active.size, backlog);
    const fly = flyMs(active.size);

    // 등장은 translate / opacity 만. scale 등장 금지.
    node.animate(
      [
        { opacity: 0, transform: "translate3d(-50%, calc(-50% + 18px), 0)" },
        { opacity: 1, transform: "translate3d(-50%, -50%, 0)" },
      ],
      { duration: enter, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
    );

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const target = active.slot ? slotRef(active.slot) : null;
      const from = node.getBoundingClientRect();

      if (!target || from.width === 0) {
        node.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 220,
          easing: "ease",
          fill: "both",
        }).finished.finally(() => {
          if (cancelled) return;
          busyRef.current = false;
          setActive(null);
          pump();
        });
        return;
      }

      const to = target.getBoundingClientRect();
      // 화질 규칙: 축소 방향만 쓴다.
      const scale = Math.min(1, to.width / from.width);
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);

      node
        .animate(
          [
            { opacity: 1, transform: "translate3d(-50%, -50%, 0) scale(1)" },
            {
              opacity: 0,
              transform: `translate3d(calc(-50% + ${dx}px), calc(-50% + ${dy}px), 0) scale(${scale})`,
            },
          ],
          { duration: fly, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
        )
        .finished.finally(() => {
          if (cancelled) return;
          busyRef.current = false;
          setActive(null);
          pump();
        });
    }, enter + hold);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, pump, reduced, slotRef, terminal]);

  const cardRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
  }, []);

  void shotUrlBySlot;
  return { card: active, targetSlot: active?.slot ?? null, cardRef };
}

export function RevealCard({
  card,
  cardRef,
  mediaUrl,
}: {
  card: FeedCard;
  cardRef: (node: HTMLDivElement | null) => void;
  mediaUrl: string | null;
}) {
  return (
    <div
      ref={cardRef}
      className="reveal-card"
      style={{ left: "50%", top: "50%", transform: "translate3d(-50%, -50%, 0)" }}
      aria-hidden
    >
      <div className="reveal-kicker">{card.kicker}</div>
      {mediaUrl ? (
        <div className="reveal-media">
          <img src={mediaUrl} alt="" />
        </div>
      ) : null}
      <div className="reveal-content">{card.title}</div>
      {card.detail ? <div className="reveal-detail">{card.detail}</div> : null}
      {card.why ? <div className="reveal-why">{card.why}</div> : null}
      {card.tech ? <div className="reveal-tech">{card.tech}</div> : null}
    </div>
  );
}
