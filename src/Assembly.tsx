import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon, ImageSquareIcon, ImagesIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import type { ListingRecord } from "./domain/types";
import { KC_LABEL, ROLE_LABEL } from "./stage-model";
import type { ControlDerived, SceneKey, TerminalStatus } from "./stage-model";

/**
 * 등록안 조립 무대 — 스마트스토어 상품 페이지 모양의 "틀"이 상주하고,
 * 산출물이 완성될 때마다 화면 중앙에 크게 등장했다가 축소되며 제자리에
 * 장착된다(FLIP + WAAPI). 관객이 상품등록을 몰라도 "무엇이 만들어져
 * 어디에 들어가는지"가 그대로 보이게 하는 연출 장치다.
 *
 * 정직성 원칙은 유지한다: 틀에 꽂히는 모든 값은 SSE 실이벤트 파생값이며,
 * 연출은 순서와 타이밍만 관장한다.
 */

export type SlotKey =
  | "thumb"
  | "gallery-0"
  | "gallery-1"
  | "gallery-2"
  | "crumb"
  | "title"
  | "price"
  | "tags"
  | "meta"
  | "plan"
  | `panel-${number}`;

type RevealContent =
  | { type: "image"; url: string; caption: string; portrait?: boolean }
  | { type: "crumb"; parts: string[] }
  | { type: "price"; value: number }
  | { type: "title"; text: string }
  | { type: "tags"; texts: string[]; count: number }
  | { type: "meta"; rows: Array<{ label: string; value: string }> }
  | { type: "panels"; panels: Array<{ index: number; url: string; headline: string }> }
  /** 중앙 카드를 띄우지 않는 박자 — 틀 안의 칸이 스스로 연출하는 동안 순서만 잡아 준다. */
  | { type: "inline" };

export interface Revealable {
  /** 서사 위치로 만든 안정 키 — 재시도·재방송이 같은 키를 내면 다시 열리지 않는다. */
  key: string;
  slot: SlotKey;
  size: "hero" | "medium" | "quick";
  /** 이 카드가 끝나면 함께 장착 처리할 슬롯 키들 (덱처럼 한 카드가 여러 칸을 채울 때). */
  docks?: string[];
  /** 두 박자짜리 카드(정가→할인가)는 기본 홀드로는 못 읽는다. */
  hold?: number;
  /** 무엇이 만들어졌는가 — 산출물의 이름. */
  kicker: string;
  /**
   * 왜 이게 상품 등록에 필요한가 — 등록을 한 번도 안 해본 관객이 읽는 한 줄.
   * 전문 용어를 쓰지 않는다. 이 줄이 무대의 전달력 전부를 책임진다.
   */
  why?: string;
  /** 어떻게 만들었는가 — 모델·표본·검증 같은 근거. 작게 붙는다. */
  tech?: string;
  content: RevealContent;
}

/** 카드가 **어느 칸으로** 들어가는지 — 도착 전에 말해 준다. 슬롯 사전 점등과 짝이다. */
function slotLabel(slot: SlotKey): string {
  if (slot === "thumb") return "대표 이미지";
  if (slot.startsWith("gallery-")) return "추가 컷";
  if (slot === "crumb") return "카테고리";
  if (slot === "title") return "상품명";
  if (slot === "price") return "판매가";
  if (slot === "tags") return "검색 태그";
  if (slot === "meta") return "필수 표시 항목";
  if (slot === "plan") return "상세페이지";
  if (slot.startsWith("panel-")) return `상세 ${Number(slot.slice(6)) + 1}컷`;
  return "등록안";
}

function metaRows(derived: ControlDerived, listing: ListingRecord) {
  return [
    {
      label: "원산지",
      value:
        listing.materials?.origin?.originAreaInfo?.content ??
        (derived.originResolved == null ? null : derived.originResolved ? "확정" : "설정 기본값"),
    },
    {
      label: "KC",
      value: derived.kcStatus
        ? (KC_LABEL[derived.kcStatus] ?? derived.kcStatus)
        : (listing.materials?.kc?.statusLabel ?? null),
    },
    {
      label: "고시",
      value: listing.materials?.notice?.noticeTypeName ?? derived.noticeType,
    },
    {
      label: "속성",
      value: derived.attributeCount != null ? `${derived.attributeCount}종 입력` : null,
    },
  ];
}

/**
 * 산출물 목록 — 파생 상태에서 통째로 계산한다(도착 이벤트에서 만들지 않는다).
 * `why`는 등록을 해본 적 없는 사람이 읽는 한 줄이고, `tech`는 그걸 무엇으로
 * 만들었는지의 근거다. 둘을 섞지 않는다 — 섞으면 둘 다 안 읽힌다.
 */
export function collectRevealables(
  derived: ControlDerived,
  listing: ListingRecord,
  /** 종착·즉시 장착 구간 — 더 기다릴 이유가 없으니 묶음 대기를 풀어 준다. */
  settled = false,
): Revealable[] {
  const out: Revealable[] = [];

  /*
    ⚠ 상품군은 리빌하지 않는다. 무대 중앙에 크게 세울 만한 정보가 아니고(그 자체로는
    "텀블러" 한 마디다), 상품명 칸을 먼저 차지하면 나중에 진짜 상품명이 그 자리를
    빼앗는 교체 연출이 필요해진다. 상품명이 확정돼 꽂힌 **뒤에** 그 아래 뱃지로 뿅 뜬다.
  */

  // 사진은 **완성된 순서대로** 앞칸부터 채운다 — derived.shots 가 이미 도착 순이다.
  derived.shots.forEach((shot, position) => {
    if (position > 3) return;
    out.push({
      key: `shot-${shot.index}`,
      slot: position === 0 ? "thumb" : (`gallery-${position - 1}` as SlotKey),
      size: position === 0 ? "hero" : "medium",
      // 카드 제목은 **들어갈 칸**을 말한다. 컷 종류를 제목에 붙이면 늦게 온 대표
      // 스튜디오 컷이 "추가 컷 완성 — 대표 스튜디오"가 되어 문장이 스스로 충돌한다.
      kicker: position === 0 ? "대표 이미지 완성" : "추가 컷 완성",
      why:
        position === 0
          ? "검색 결과에 뜨는 첫 얼굴 — 누를지 말지가 여기서 갈립니다"
          : "상세를 열기 전에 훑어보는 컷",
      tech: `gpt-image-2 · ${shot.caption} · 올린 사진을 재료로 생성`,
      content: { type: "image", url: shot.url, caption: shot.caption },
    });
  });

  if (derived.categoryPath) {
    out.push({
      key: "category",
      slot: "crumb",
      size: "hero",
      kicker: derived.categoryVerified === false ? "카테고리 후보 채택" : "카테고리 확정",
      why: "이 매대에 놓여야 사려는 사람 눈에 띕니다",
      tech:
        derived.categoryVerified === false
          ? "검증 미통과 — 카탈로그 득표 1위 채택"
          : derived.categoryComps
            ? `같은 상품군 카탈로그 모델 ${derived.categoryComps}건이 투표`
            : "카탈로그 검증 루프 통과",
      content: {
        type: "crumb",
        parts: derived.categoryPath
          .split(">")
          .map((part) => part.trim())
          .filter(Boolean),
      },
    });
  }

  /*
    가격은 **정가와 할인이 함께 정해진 뒤에** 한 번만 말한다.
    고객가(15,000)를 먼저 띄웠다가 나중에 정가(17,700)로 되돌려 빗금을 치면, 같은 값을
    두 번 다르게 말하는 셈이라 관객이 "아까 그 가격은 뭐였지"가 된다.
    할인 여부는 재료 완료에서 갈리므로 그때까지 기다린다 — 그전의 시세 조회 결과는
    등록될 값이 아니라 산정 재료다.
  */
  const discountKnown = derived.listPrice != null && Boolean(derived.discountRate);
  // priceFinal = 서버가 "등록될 값"으로 확정해 보낸 가격. 그 전의 시세 조회 결과는
  // 산정 재료일 뿐이라 무대에 세우지 않는다.
  const priceSettled =
    settled || derived.priceFinal || derived.seoTitle != null || derived.tagCount != null;
  if (derived.price != null && priceSettled) {
    out.push({
      key: "price",
      slot: "price",
      size: "hero",
      kicker: discountKnown ? "가격 결정" : "판매가 결정",
      why: "비싸면 안 팔리고 싸면 손해 — 팔리는 선을 잡습니다",
      tech: derived.priceSample
        ? `실판매 표본 ${derived.priceSample}건 · IQR 정제 후 보수적 백분위`
        : "시세 표본 없음 — 사진·상품 정보 근거 추정",
      // 할인을 걸 런에서는 **등록될 정가**를 먼저 말한다. 할인가는 바로 다음 박자에서.
      content: { type: "price", value: discountKnown ? derived.listPrice! : derived.price },
    });
  }

  /*
    상세 패널은 **다 만들어진 뒤에 한 덱으로** 들어간다.
    ① 완성 순서가 아니라 서사 순서(1→6)로 한 장씩 덱에 쌓아 보여 주고
    ② 다 쌓이면 여섯 칸으로 한 번에 촤르륵 흩뿌린다.
    완성되는 대로 한 장씩 꽂으면 병렬 생성 순서(6→3→5→1→2→4)가 그대로 노출돼
    본문 흐름이 끊기고, 같은 "탁" 동작을 여섯 번 보게 돼 피로해진다.
    총 수를 모르는 런에서는 기다릴 근거가 없으니 도착분을 그대로 쓴다.
  */
  const panelTotal = derived.panelTotal;
  // 한 장이 실패해 총 수를 못 채우면 스트립이 영영 비어 버린다 — 종착에는 있는 만큼 건다.
  const panelsReady = settled || panelTotal == null || derived.panels.length >= panelTotal;
  if (panelsReady && derived.panels.length > 0) {
    const ordered = [...derived.panels].sort((a, b) => a.index - b.index).slice(0, 6);
    out.push({
      key: "panels-deck",
      slot: `panel-${ordered[0].index}` as SlotKey,
      docks: ordered.map((panel) => `panel-${panel.index}`),
      size: "hero",
      kicker: `상세페이지 ${ordered.length}컷 완성`,
      why: "스크롤하며 읽는 본문 — 구매는 여기서 결정됩니다",
      tech: "gpt-image-2 · 세로 2:3 패널 · 기획 순서대로 배치",
      content: {
        type: "panels",
        panels: ordered.map((panel) => ({
          index: panel.index,
          url: panel.url,
          headline: panel.headline,
        })),
      },
    });
  }

  if (derived.seoTitle) {
    out.push({
      key: "title-final",
      slot: "title",
      size: "hero",
      kicker: "상품명 확정",
      why: "사람들이 실제로 검색하는 말이 들어가야 노출됩니다",
      tech:
        derived.titleStrategy === "composed"
          ? "근거 토큰 조합 · 발명 단어 차단 · 상품명 규정 통과"
          : "검색 수요 커버리지 · 스마트스토어 상품명 규정 통과",
      content: { type: "title", text: derived.seoTitle },
    });
  }

  if (derived.tagCount != null) {
    // 실황이 1순위 — 레코드는 런이 끝나야 채워진다.
    const texts =
      derived.tags.length > 0
        ? derived.tags
        : (listing.materials?.tags?.tags ?? []).map((tag) => tag.text);
    out.push({
      key: "tags",
      slot: "tags",
      size: "medium",
      kicker: "검색 태그 확정",
      why: "상품명에 못 담은 검색어를 태그가 받습니다",
      tech: "공식 태그 사전 대조",
      content: { type: "tags", texts, count: derived.tagCount },
    });
  }

  /*
    필수 표시 항목은 태그와 다른 갈래에서 온다(고시·KC·원산지·속성). 예전에는 재료가
    한꺼번에 도착해서 태그 안에 얹어도 표가 안 났지만, 이제는 각자 도착하므로
    자기 근거가 모였을 때 스스로 선다.

    ⚠ 게이트는 **실황(derived)** 으로만 연다. 행의 표시값은 레코드에서 보강하지만,
    레코드는 완주한 런이면 마운트 시점에 이미 차 있다 — 그걸로 열면 이 카드가
    유예 구간에 소리 없이 장착돼 무대에서 영영 사라진다(리허설·새로고침 실측).
  */
  const complianceLive =
    derived.kcStatus != null ||
    derived.noticeType != null ||
    derived.originResolved != null ||
    derived.attributeCount != null;
  const rows = metaRows(derived, listing)
    .filter((row) => row.value != null)
    .map((row) => ({ label: row.label, value: row.value as string }));
  if (complianceLive && rows.length > 0) {
    out.push({
      key: "meta",
      slot: "meta",
      size: "medium",
      kicker: "필수 표시 항목 채움",
      why: "원산지 · KC · 고시는 법으로 요구되는 칸 — 하나만 비어도 등록이 막힙니다",
      content: { type: "meta", rows },
    });
  }

  /*
    할인은 리스트의 **맨 끝**이다. 상세페이지 6컷까지 다 꽂힌 뒤, 스토어로 넘어가기
    직전에 "정가에 할인을 걸어 올린다"가 와야 이야기가 닫힌다.
    중앙 카드를 띄우지 않는다 — 연출은 판매가 칸 안에서 벌어지고, 이 항목은 그동안
    다른 카드가 끼어들지 않게 순서만 잡아 준다.
  */
  const readyToPublish =
    settled ||
    derived.liveStage === "validation" ||
    derived.liveStage === "publishing" ||
    derived.liveStage === "complete";
  if (readyToPublish && derived.price != null && derived.listPrice != null && derived.discountRate) {
    out.push({
      key: "discount",
      slot: "price",
      size: "hero",
      hold: 1750,
      kicker: "할인가로 등록",
      content: { type: "inline" },
    });
  }

  return out;
}

// --- 공용 모션 유틸 -----------------------------------------------------------

/**
 * 칩이 몇 개까지 들어가는지 — **실제 줄 위치를 재서** 정한다.
 *
 * 글자 수로 어림하면 화면 폭·한글 조합 폭에 따라 한 줄이 남거나 잘린다. 그래서
 * 일단 전부 그린 뒤(fit === null) 자식들의 offsetTop 으로 줄을 세고, 허용 줄 수를
 * 넘기는 지점에서 끊는다. 끊을 때는 "+N" 칩이 앉을 한 칸을 비워 둔다.
 *
 * ⚠ ResizeObserver 는 **가로폭이 실제로 변할 때만** 재측정한다. 높이까지 보면
 *   칩을 접어 높이가 줄고 → 다시 재고 → 다시 접히는 무한 루프가 된다.
 */
function useChipFit(items: string[], maxLines: number) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  const widthRef = useRef(0);
  const signature = items.join(" ");

  useLayoutEffect(() => {
    setFit(null);
  }, [signature, maxLines]);

  useLayoutEffect(() => {
    if (fit != null) return;
    const node = ref.current;
    if (!node || items.length === 0) return;
    const chips = Array.from(node.children) as HTMLElement[];
    const rows: number[] = [];
    let allowed = items.length;
    for (let index = 0; index < chips.length; index += 1) {
      const top = chips[index].offsetTop;
      if (!rows.some((value) => Math.abs(value - top) < 4)) rows.push(top);
      if (rows.length > maxLines) {
        allowed = index;
        break;
      }
    }
    if (allowed < items.length && allowed > 0) allowed -= 1;
    setFit(Math.max(0, allowed));
  }, [fit, signature, maxLines, items.length]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    widthRef.current = node.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - widthRef.current) < 1) return;
      widthRef.current = width;
      setFit(null);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, shown: fit == null ? items : items.slice(0, fit) };
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function TypedLine({ text }: { text: string }) {
  // 타이핑 연출 — 문자 수 기반 고정 시간(1.1s 내), reduced-motion 에서는 즉시.
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    setVisible(0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(text.length);
      return;
    }
    const step = Math.max(18, Math.floor(1100 / Math.max(1, text.length)));
    const timer = window.setInterval(() => {
      setVisible((current) => {
        if (current >= text.length) {
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, step);
    return () => window.clearInterval(timer);
  }, [text]);
  return <span>{text.slice(0, visible)}</span>;
}

function CountUpWon({ value, duration = 720 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{display.toLocaleString("ko-KR")}원</>;
}

// --- 리빌 디렉터 --------------------------------------------------------------

interface DirectorResult {
  docked: ReadonlySet<string>;
  active: Revealable | null;
  backlogRef: React.RefObject<number>;
  onDone: (item: Revealable) => void;
  dockKeys: (keys: string[]) => void;
  /** 아직 보여 줄 것이 남았는가 — 결과 화면으로 넘어가기 전에 이게 꺼져야 한다. */
  playing: boolean;
}

/**
 * 종착 후 남은 카드를 다 재생하는 데 허용하는 상한. 넘으면 남은 것을 즉시 장착한다 —
 * 연출 버그로 관객이 무대에 갇히는 경로를 남기지 않기 위한 안전장치다.
 *
 * ⚠ 최악의 잔여를 넉넉히 덮어야 한다. 재료를 한 밀스톤에 몰아 보내던 옛 런을 재생하면
 * 종착 시점 잔여가 실측 8.4초였다(덱 2.2 + 카드 4장 4.4 + 할인 1.8). 상한이 그보다
 * 짧으면 이 장치가 바로 그 "갑자기 끝나는" 증상을 다시 만든다.
 */
const DRAIN_CAP_MS = 12_000;

function useRevealDirector(
  derived: ControlDerived,
  listing: ListingRecord,
  /** 런이 종착했는가 — 묶음 대기를 풀고 남은 카드를 서둘러 재생한다. */
  settled: boolean,
  /** reduced-motion — 연출 자체를 하지 않는다. */
  instant: boolean,
): DirectorResult {
  const [docked, setDocked] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState<Revealable | null>(null);
  const [queueLength, setQueueLength] = useState(0);
  const [drainExpired, setDrainExpired] = useState(false);
  const queueRef = useRef<Revealable[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const armedRef = useRef(false);
  const backlogRef = useRef(0);
  backlogRef.current = queueLength;

  /*
    ⚠ 종착했다고 큐를 버리지 않는다.
    예전에는 terminal 이 뜨는 즉시 대기 중인 리빌 전부를 무음으로 장착했다.
    서버는 재료 완료 1~3초 뒤에 등록을 끝내는데 그 시점 큐에는 10초가 넘는 분량이
    쌓여 있어서, 관객 눈에는 "한참 아무 일도 없다가 갑자기 등록 완료"로 보였다.
    이제는 남은 카드를 끝까지 재생하고(홀드만 짧게), 상한을 넘길 때만 정리한다.
  */
  useEffect(() => {
    if (!settled || instant) return;
    const timer = window.setTimeout(() => setDrainExpired(true), DRAIN_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [settled, instant]);

  const dump = instant || drainExpired;

  // 새 산출물 감지 → 큐 적재. 마운트 직후 유예 구간에 도착하는 산출물(백필·
  // 새로고침·리허설 시킹의 과거 이벤트)은 소리 없이 장착한다 — 이미 지나간
  // 리빌을 재상영하면 거짓 실황이 된다.
  useEffect(() => {
    const fresh = collectRevealables(derived, listing, settled).filter(
      (item) => !seenRef.current.has(item.key),
    );
    if (fresh.length === 0) return;
    for (const item of fresh) seenRef.current.add(item.key);
    if (!armedRef.current || dump) {
      setDocked((current) => {
        const next = new Set(current);
        for (const item of fresh) next.add(item.key);
        return next;
      });
      return;
    }
    queueRef.current.push(...fresh);
    setQueueLength(queueRef.current.length);
  }, [derived, listing, settled, dump]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      armedRef.current = true;
    }, 700);
    return () => window.clearTimeout(timer);
  }, []);

  // reduced-motion·드레인 상한 초과 — 대기 중인 리빌 전부 즉시 장착.
  useEffect(() => {
    if (!dump) return;
    const pending = queueRef.current;
    if (pending.length === 0 && !active) return;
    queueRef.current = [];
    setQueueLength(0);
    setDocked((current) => {
      const next = new Set(current);
      for (const item of pending) next.add(item.key);
      if (active) next.add(active.key);
      for (const key of active?.docks ?? []) next.add(key);
      return next;
    });
    setActive(null);
  }, [dump, active]);

  // 펌프 — 한 번에 하나씩만 무대 중앙을 쓴다.
  useEffect(() => {
    if (active || dump || queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    setQueueLength(queueRef.current.length);
    setActive(next);
  }, [active, dump, queueLength]);

  /** 착지한 칸만 먼저 채운다 — 덱은 여섯 장이 한 장씩 도착하므로 도착 즉시 걸어야 한다. */
  const dockKeys = useCallback((keys: string[]) => {
    setDocked((current) => {
      const next = new Set(current);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  const onDone = useCallback((item: Revealable) => {
    setDocked((current) => {
      const next = new Set(current);
      next.add(item.key);
      // 덱 카드 하나가 여섯 칸을 채운다 — 함께 장착 처리한다.
      for (const key of item.docks ?? []) next.add(key);
      return next;
    });
    setActive(null);
  }, []);

  return { docked, active, backlogRef, onDone, dockKeys, playing: active != null || queueLength > 0 };
}

// --- 리빌 오버레이 ------------------------------------------------------------

function RevealCardContent({ item, slotRatio }: { item: Revealable; slotRatio?: number }) {
  const content = item.content;
  if (content.type === "image") {
    /*
      사진은 **목적지 칸의 비율 그대로** 띄운다. 정사각으로 띄우면 칸(426x411)과 비율이
      달라 착지 배율이 가로·세로 중 작은 쪽에 묶이고, 그만큼 칸보다 작게 도착한다.
    */
    return (
      <figure
        className={`reveal-img${content.portrait ? " is-portrait" : ""}`}
        style={slotRatio ? ({ aspectRatio: slotRatio } as React.CSSProperties) : undefined}
      >
        <img src={content.url} alt={content.caption} />
      </figure>
    );
  }
  if (content.type === "title") {
    return (
      <p className="reveal-big reveal-title">
        <TypedLine text={content.text} />
      </p>
    );
  }
  if (content.type === "crumb") {
    return (
      <p className="reveal-crumb">
        {content.parts.map((part, index) => (
          <span key={`${part}-${index}`}>
            {part}
            {index < content.parts.length - 1 ? <i aria-hidden="true">›</i> : null}
          </span>
        ))}
      </p>
    );
  }
  if (content.type === "price") {
    return (
      <p className="reveal-price">
        <CountUpWon value={content.value} />
      </p>
    );
  }
  if (content.type === "tags") {
    return (
      <p className="reveal-tags">
        {content.texts.length > 0
          ? content.texts.slice(0, 5).map((text) => <span key={text}>#{text}</span>)
          : Array.from({ length: Math.min(content.count, 5) }, (_, index) => (
              <span key={index} className="is-counted">
                #태그{index + 1}
              </span>
            ))}
        {content.count > 5 ? <span className="is-counted">+{content.count - 5}</span> : null}
      </p>
    );
  }
  if (content.type !== "meta") return null;
  return (
    <ul className="reveal-meta">
      {content.rows.map((row) => (
        <li key={row.label}>
          <CheckIcon size={13} weight="bold" aria-hidden="true" />
          <strong>{row.label}</strong> {row.value}
        </li>
      ))}
    </ul>
  );
}

function RevealOverlay({
  item,
  backlogRef,
  getSlot,
  onDone,
  reduced,
}: {
  item: Revealable;
  backlogRef: React.RefObject<number>;
  getSlot: (key: SlotKey) => HTMLElement | null;
  onDone: (item: Revealable) => void;
  reduced: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  // 목적지 칸의 가로세로비 — 사진을 이 비율로 띄워야 착지 때 크기가 딱 맞는다.
  const [slotRatio] = useState(() => {
    if (item.content.type !== "image") return undefined;
    const slot = getSlot(item.slot);
    if (!slot || !slot.offsetHeight) return undefined;
    return slot.offsetWidth / slot.offsetHeight;
  });

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let cancelled = false;
    const finish = () => {
      if (cancelled || doneRef.current) return;
      doneRef.current = true;
      onDone(item);
    };
    if (reduced) {
      finish();
      return;
    }
    /*
      홀드 1초 — 한 줄(`why`)을 읽기에 충분하고, 그 이상은 기다림이 된다.
      상세 패널처럼 연속으로 꽂히는 묶음(quick)은 더 짧게 끊어 한 동작으로 읽히게 하고,
      큐가 밀렸을 때만 더 줄인다.
    */
    const backlog = backlogRef.current ?? 0;
    const hold =
      item.hold ?? (backlog > 4 ? 260 : backlog > 2 ? 560 : item.size === "quick" ? 420 : 1000);
    const enter = item.size === "quick" ? 220 : 380;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const slot = getSlot(item.slot);
      const from = card.getBoundingClientRect();
      if (!slot || from.width === 0) {
        finish();
        return;
      }
      const to = slot.getBoundingClientRect();
      /*
        가로만 보고 축척을 잡으면 넓고 낮은 칸(판매가·카테고리 행)에서는 비율이 1을
        넘어 **전혀 줄지 않는다** — 카드가 행 위로 미끄러지다 사라질 뿐이라 "저 칸에
        들어갔다"가 남지 않는다. 두 변 모두에 맞춘다(contain).
        화질 규칙상 확대는 하지 않는다 — 축소 방향만.
      */
      /*
        칸이 카드보다 크면 **키워서** 맞춘다. 축소로만 묶으면 사진이 칸보다 작게 도착한다.
        원본은 1024px 급이라 1.3배 안쪽 확대는 화질에 영향이 없다.
      */
      const fit = Math.min(to.width / from.width, to.height / from.height);
      const scale = Math.max(0.06, Math.min(1.35, fit));
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const fly = item.size === "quick" ? 340 : 460;
      /*
        장착은 **꽂히는** 동작이다. 페이드로 사라지면 "어디에 붙었는지"가 없어지고
        슬며시 증발한 것처럼 읽힌다. 그래서 가속(ease-in)으로 슬롯에 들어가 착지 지점에서
        살짝 눌린 뒤(0.95) 마지막 8% 에서만 사라진다 — 불투명도를 끝까지 유지해야
        슬롯 내용이 그 자리를 이어받는 것으로 보인다.
        반동(anticipation)은 아주 얕게만 준다. 크게 주면 매 카드가 꿈틀거려 산만해진다.
      */
      /*
        착지는 **미끄러져 앉는다**. 가속해서 벽에 부딪히는 "탁"은 한두 번은 시원하지만
        여덟 번 반복되면 피로해진다 — 부드럽게 붙이되 끝을 흐리지 않아 어디 붙었는지는 남긴다.
        사진은 끝까지 불투명하게 간다: 칸에 걸릴 그림이 같은 사진이라 그대로 이어받는 것으로
        보이기 때문이다. 글 카드만 마지막에 옅어진다(칸 내용이 다르므로 겹치면 지저분하다).
      */
      const isPhoto = item.content.type === "image";
      const animation = card.animate(
        [
          { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 0 },
          {
            transform: `translate(${dx * 0.52}px, ${dy * 0.52}px) scale(${(1 + scale) / 2})`,
            opacity: 1,
            offset: 0.62,
          },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            opacity: isPhoto ? 1 : 0.4,
            offset: 0.94,
          },
          /*
            사진은 끝 프레임까지 불투명하다. 카드가 사라지는 것과 칸이 채워지는 것은 같은
            렌더에서 일어나므로(onDone → setState), 여기서 미리 옅어지면 그 사이가
            "잠깐 없어졌다 페이드인"으로 보인다.
          */
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            opacity: isPhoto ? 1 : 0,
            offset: 1,
          },
        ],
        { duration: fly, easing: "cubic-bezier(0.32, 0.72, 0.24, 1)", fill: "forwards" },
      );
      animation.onfinish = finish;
      animation.oncancel = finish;
    }, enter + hold);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // backlogRef·getSlot·onDone 은 안정 참조 — item 교체(key 리마운트)만 재생 단위다.
  }, [item, reduced, backlogRef, getSlot, onDone]);

  /*
    사진은 **사진만** 띄운다. 틀·제목·근거를 두르면 사진이 "액자에 걸린 자료"가 되고,
    칸으로 날아가 꽂힐 때 액자만 사라지는 게 보여 인수인계가 깨진다.
    글로 설명이 필요한 산출물(카테고리·가격·태그·필수표시)만 카드를 두른다.
  */
  const photoOnly = item.content.type === "image";
  return (
    <div className="reveal-layer" aria-live="polite">
      <div
        ref={cardRef}
        className={`reveal-card is-${item.size} kind-${item.content.type}${photoOnly ? " is-photo" : ""}`}
      >
        {photoOnly ? null : (
          <>
            <p className="reveal-kicker">{item.kicker}</p>
            <p className="reveal-dest">
              <span aria-hidden="true">↳</span> {slotLabel(item.slot)} 칸으로
            </p>
          </>
        )}
        <RevealCardContent item={item} slotRatio={slotRatio} />
        {photoOnly || !item.why ? null : <p className="reveal-why">{item.why}</p>}
        {photoOnly || !item.tech ? null : <p className="reveal-tech">{item.tech}</p>}
      </div>
    </div>
  );
}

/**
 * 화면에 아무것도 그리지 않는 박자. 틀 안의 칸(판매가)이 스스로 연출하는 동안
 * 다음 카드가 끼어들지 않게 무대를 붙잡아 둔다.
 */
function InlineBeat({
  item,
  onDone,
  reduced,
}: {
  item: Revealable;
  onDone: (item: Revealable) => void;
  reduced: boolean;
}) {
  const doneRef = useRef(false);
  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone(item);
    };
    if (reduced) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, item.hold ?? 1200);
    return () => window.clearTimeout(timer);
  }, [item, onDone, reduced]);
  return null;
}

// --- 상세 패널 덱 --------------------------------------------------------------

/** 손으로 쌓은 것처럼 보이게 하는 카드별 기울기·어긋남. 규칙적이면 기계가 된다. */
const DECK_TILT = [-6, 4, -3, 5, -4, 2];
const DECK_SHIFT = [-9, 7, -4, 9, -6, 3];

/**
 * 상세 6컷 — **덱으로 쌓았다가 한 번에 흩뿌린다.**
 * 한 장씩 칸에 꽂으면 같은 "탁" 동작을 여섯 번 봐야 해서 피로하고, 그 사이 다른
 * 산출물이 멈춰 선다. 쌓는 동안은 무엇이 그려졌는지 한 장씩 보여 주고,
 * 배치는 한 동작(촤르륵)으로 끝낸다.
 */
function PanelDeckOverlay({
  item,
  panels,
  getSlot,
  onDone,
  onLanded,
  reduced,
  hurry = false,
}: {
  item: Revealable;
  panels: Array<{ index: number; url: string; headline: string }>;
  getSlot: (key: SlotKey) => HTMLElement | null;
  onDone: (item: Revealable) => void;
  /** 한 장이 칸에 닿는 즉시 호출 — 여섯 장을 다 기다렸다 한꺼번에 채우면 배치가 안 보인다. */
  onLanded: (keys: string[]) => void;
  reduced: boolean;
  /** 런이 이미 끝났다 — 쌓는 박자를 줄여 관객을 붙잡아 두지 않는다. */
  hurry?: boolean;
}) {
  const cardsRef = useRef<Array<HTMLDivElement | null>>([]);
  const doneRef = useRef(false);
  const [dealing, setDealing] = useState(false);

  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone(item);
    };
    if (reduced) {
      finish();
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    const STEP = hurry ? 170 : 320;
    const HOLD = hurry ? 300 : 640;
    const DEAL = 540;
    const STAGGER = 70;

    const deckTransform = (i: number) =>
      `translate(-50%, -50%) translate(${DECK_SHIFT[i % DECK_SHIFT.length]}px, ${-i * 3}px) rotate(${DECK_TILT[i % DECK_TILT.length]}deg)`;

    /* ① 한 장씩 덱에 쌓는다. */
    panels.forEach((_, i) => {
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          cardsRef.current[i]?.animate(
            [
              { opacity: 0, transform: "translate(-50%, -50%) translate(0px, 36px) scale(0.94)" },
              { opacity: 1, transform: deckTransform(i) },
            ],
            { duration: 300, easing: "cubic-bezier(0.2, 0.85, 0.3, 1)", fill: "forwards" },
          );
        }, i * STEP),
      );
    });

    /* ② 다 쌓이면 여섯 칸으로 한 번에 흩뿌린다. */
    timers.push(
      window.setTimeout(
        () => {
          if (cancelled) return;
          setDealing(true);
          let last: Animation | null = null;
          panels.forEach((panel, i) => {
            const node = cardsRef.current[i];
            const slot = getSlot(`panel-${panel.index}` as SlotKey);
            if (!node || !slot) return;
            const from = node.getBoundingClientRect();
            const to = slot.getBoundingClientRect();
            if (to.width === 0 || node.offsetWidth === 0) return;
            // 회전 때문에 rect 가 부풀어 있다 — 축척은 회전 없는 실측 크기로 잡는다.
            const scale = Math.max(
              0.06,
              Math.min(1, to.width / node.offsetWidth, to.height / node.offsetHeight),
            );
            const dx = to.left + to.width / 2 - (from.left + from.width / 2);
            const dy = to.top + to.height / 2 - (from.top + from.height / 2);
            const landed = `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(0deg) scale(${scale})`;
            const animation = node.animate(
              [
                { transform: deckTransform(i), opacity: 1, offset: 0 },
                { transform: landed, opacity: 1, offset: 0.88 },
                { transform: landed, opacity: 0, offset: 1 },
              ],
              {
                duration: DEAL,
                delay: i * STAGGER,
                easing: "cubic-bezier(0.32, 0.72, 0.24, 1)",
                fill: "forwards",
              },
            );
            // 이 장이 닿는 순간 그 칸을 채운다 — 카드가 사라지는 프레임과 맞물린다.
            animation.onfinish = () => onLanded([`panel-${panel.index}`]);
            last = animation;
          });
          if (last) {
            (last as Animation).onfinish = finish;
            (last as Animation).oncancel = finish;
          } else finish();
        },
        panels.length * STEP + HOLD,
      ),
    );

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [item, panels, getSlot, onDone, onLanded, reduced, hurry]);

  return (
    <div className="reveal-layer" aria-live="polite">
      {/* 덱도 사진만 — 여섯 장이 쌓이는 것 자체가 설명이다. */}
      <div className={`reveal-deck${dealing ? " is-dealing" : ""}`} aria-label={item.kicker}>
        {panels.map((panel, i) => (
          <div
            key={panel.index}
            ref={(node) => {
              cardsRef.current[i] = node;
            }}
            className="reveal-deck-card"
            style={{ zIndex: i + 1 }}
          >
            <img src={panel.url} alt={panel.headline || `상세 ${i + 1}컷`} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 등록안 틀 ----------------------------------------------------------------

type SlotRegistrar = (key: SlotKey) => (el: HTMLElement | null) => void;

/** 검색 태그 칸 — 들어가는 만큼 다 걸고, 넘치는 분만 "+N"으로 접는다. */
function FrameTags({ texts, count }: { texts: string[]; count: number }) {
  const { ref, shown } = useChipFit(texts, 3);
  if (texts.length === 0) {
    // 아직 본문이 안 왔다 — 이름을 지어내지 않고 개수만 말한다.
    return <p className="frame-tags">{count > 0 ? <span>검색 태그 {count}종 확정</span> : null}</p>;
  }
  const hidden = texts.length - shown.length;
  return (
    <p className="frame-tags" ref={ref}>
      {shown.map((text) => (
        <span key={text}>#{text}</span>
      ))}
      {hidden > 0 ? (
        <span className="is-more" title={texts.slice(shown.length).map((text) => `#${text}`).join(" ")}>
          +{hidden}
        </span>
      ) : null}
    </p>
  );
}

function Slot({
  slotKey,
  registerSlot,
  filled,
  target,
  ghost,
  className,
  children,
}: {
  slotKey: SlotKey;
  registerSlot: SlotRegistrar;
  filled: boolean;
  /** 지금 무대 중앙에 떠 있는 산출물이 향할 자리 — 도착 전에 미리 점등한다. */
  target?: boolean;
  ghost: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={registerSlot(slotKey)}
      data-slot={slotKey}
      className={`slot ${className ?? ""}${filled ? " is-filled" : ""}${target ? " is-target" : ""}`}
    >
      {filled ? <div className="slot-fill">{children}</div> : <div className="slot-ghost">{ghost}</div>}
    </div>
  );
}

function ListingFrame({
  derived,
  listing,
  docked,
  registerSlot,
  targetSlots,
  showDiscount,
  showConcept,
  scene,
  live,
  terminal,
  assembling,
}: {
  derived: ControlDerived;
  listing: ListingRecord;
  docked: ReadonlySet<string>;
  registerSlot: SlotRegistrar;
  /** 지금 무대 위 카드가 향하는 칸들 — 덱은 여섯 곳을 한꺼번에 겨냥한다. */
  targetSlots: ReadonlySet<string> | null;
  /** 판매가 칸의 할인 연출 — 그 박자가 시작된 뒤에만 켠다. */
  showDiscount: boolean;
  /** 상세 컨셉 문구 — 패널 덱 박자와 함께 써진다. */
  showConcept: boolean;
  scene: SceneKey;
  live: boolean;
  terminal: TerminalStatus;
  /** 남은 조립 연출이 있는가 — 도장은 틀이 다 채워진 뒤에 찍혀야 한다. */
  assembling: boolean;
}) {
  const complete = terminal === "registered";
  const shots = derived.shots;
  const thumbShot = shots[0] && docked.has(`shot-${shots[0].index}`) ? shots[0] : null;
  const titleFinal = derived.seoTitle && docked.has("title-final") ? derived.seoTitle : null;
  const crumbParts =
    derived.categoryPath && docked.has("category")
      ? derived.categoryPath
          .split(">")
          .map((part) => part.trim())
          .filter(Boolean)
      : null;
  const priceDocked = derived.price != null && docked.has("price") ? derived.price : null;
  /*
    할인은 판매가가 이미 칸에 꽂힌 **뒤에** 온다(고객가는 시세/추정으로 먼저 정해지고,
    정가는 등록 직전 역산). 그래서 또 하나의 중앙 카드로 끊지 않고, 걸려 있는 그 자리에서
    정가가 올라오고 → 빗금이 그어지고 → 값이 빨갛게 바뀐다. 지연은 CSS 가 관장한다.
  */
  const discountKnown = derived.listPrice != null && Boolean(derived.discountRate);
  // 박자 전에는 정가가 큰 자리를 지키고, 박자가 끝나면 그 자리를 할인가가 넘겨받는다.
  const hasDiscount = showDiscount && discountKnown;
  const tagsDocked = derived.tagCount != null && docked.has("tags");
  // 실황 이벤트가 1순위 — 레코드는 런이 끝나야 채워지므로 그걸 기다리면 숫자만 뜬다.
  const tagTexts =
    derived.tags.length > 0
      ? derived.tags
      : (listing.materials?.tags?.tags ?? []).map((tag) => tag.text);
  const metaDocked = docked.has("meta");
  const rows = metaRows(derived, listing);
  const panelsDocked = derived.panels.filter((panel) => docked.has(`panel-${panel.index}`));
  const panelTotal =
    derived.panelTotal ??
    (derived.plan ? derived.plan.sections.filter((section) => section.hasPanel).length : null);

  const chip = complete
    ? live
      ? "등록 완료"
      : "등록안 완성"
    : scene === "validation"
      ? "규정 검증 중"
      : scene === "publishing"
        ? "스토어에 올리는 중"
        : "등록안 조립 중";

  return (
    <section
      className={`frame${complete ? " is-complete" : ""}${scene === "validation" ? " is-validating" : ""}${
        scene === "publishing" ? " is-publishing" : ""
      }`}
      aria-label="조립 중인 스마트스토어 등록안"
    >
      <header className="frame-chrome">
        <span className="frame-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={`frame-url${complete && live ? " is-live" : ""}`}>
          smartstore.naver.com
          {complete && live ? <CheckIcon size={12} weight="bold" aria-hidden="true" /> : null}
        </span>
        <span className={`frame-chip${complete ? " is-done" : ""}`}>
          {complete ? (
            <CheckIcon size={11} weight="bold" aria-hidden="true" />
          ) : (
            <SpinnerGapIcon size={11} weight="bold" className="spin" aria-hidden="true" />
          )}
          {chip}
        </span>
      </header>

      <div className="frame-body">
        <div className="frame-media">
          <Slot
            slotKey="thumb"
            registerSlot={registerSlot}
            filled={thumbShot != null}
            target={targetSlots?.has("thumb") === true}
            className="slot-thumb"
            ghost={
              <>
                <ImageSquareIcon size={30} weight="light" aria-hidden="true" />
                <span>대표 이미지</span>
                <em>검색 결과에 뜨는 첫 얼굴</em>
              </>
            }
          >
            {thumbShot ? <img src={thumbShot.url} alt={`대표 이미지 — ${thumbShot.caption}`} /> : null}
          </Slot>
          <div className="frame-gallery">
            {[0, 1, 2].map((index) => {
              const shot = shots[index + 1];
              const filled = shot != null && docked.has(`shot-${shot.index}`);
              return (
                <Slot
                  key={index}
                  slotKey={`gallery-${index}` as SlotKey}
                  registerSlot={registerSlot}
                  filled={filled}
                  target={targetSlots?.has(`gallery-${index}`) === true}
                  className="slot-gallery"
                  ghost={
                    <>
                      <ImagesIcon size={16} weight="light" aria-hidden="true" />
                      <span>추가 컷</span>
                    </>
                  }
                >
                  {filled && shot ? <img src={shot.url} alt={shot.caption} /> : null}
                </Slot>
              );
            })}
          </div>
        </div>

        <div className="frame-info">
          <Slot
            slotKey="crumb"
            registerSlot={registerSlot}
            filled={crumbParts != null}
            target={targetSlots?.has("crumb") === true}
            className="slot-crumb"
            ghost={<span className="ghost-label">카테고리</span>}
          >
            {/* 마지막 마디가 실제로 상품이 놓이는 매대다 — 나머지는 거기까지 가는 길이다.
                전부 같은 회색이면 어디에 놓이는지가 글자 덩어리에 묻힌다. */}
            {crumbParts ? (
              <p className="frame-crumb-path">
                {crumbParts.map((part, index) =>
                  index === crumbParts.length - 1 ? (
                    <b key={`${part}-${index}`} className="frame-crumb-leaf">
                      {part}
                    </b>
                  ) : (
                    <span key={`${part}-${index}`}>
                      {part}
                      <i aria-hidden="true">›</i>
                    </span>
                  ),
                )}
                {derived.categoryVerified === false ? <em className="frame-crumb-hold">미검증</em> : null}
              </p>
            ) : null}
          </Slot>

          {/*
            상품명은 두 번 채워진다. 처음 꽂히는 건 상품명이 아니라 "무엇을 파는
            물건인지"(상품군)이고, 그걸 그대로 상품명인 척 두면 대충 만든 이름으로
            읽힌다. 그래서 임시 단계에는 상품군이라고 이름을 붙여 두고, 검색 수요로
            다시 쓴 최종 상품명이 도착하면 교체 자체를 보여준다.
          */}
          {/*
            상품명은 **확정된 것만** 꽂는다. 임시로 상품군을 넣어 두면 관객이 그걸
            완성된 이름으로 읽고 "대충 지었네"로 판단해 버린다 — 첫인상은 안 돌아온다.
            상품군은 이름이 앉은 뒤 아래에 작게 뿅 뜬다 (근거이지 제목이 아니다).
          */}
          <Slot
            slotKey="title"
            registerSlot={registerSlot}
            filled={titleFinal != null}
            target={targetSlots?.has("title") === true}
            className="slot-title"
            ghost={<span className="ghost-label">상품명</span>}
          >
            <>
              <h3 className="frame-title-final">{titleFinal}</h3>
              {derived.productName ? (
                <span className="frame-title-kind">
                  <i aria-hidden="true">상품군</i>
                  {derived.productName}
                </span>
              ) : null}
            </>
          </Slot>

          <Slot
            slotKey="price"
            registerSlot={registerSlot}
            filled={priceDocked != null}
            target={targetSlots?.has("price") === true}
            className="slot-price"
            ghost={<span className="ghost-label">판매가</span>}
          >
            {priceDocked != null ? (
              <div className="frame-price-block">
                {hasDiscount ? (
                  <p className="frame-list-price">
                    {derived.listPrice!.toLocaleString("ko-KR")}원
                  </p>
                ) : null}
                <p className={`frame-price${hasDiscount ? " is-sale" : ""}`}>
                  {hasDiscount ? (
                    <span className="frame-rate">{derived.discountRate}%</span>
                  ) : null}
                  {(hasDiscount || !discountKnown
                    ? priceDocked
                    : derived.listPrice!
                  ).toLocaleString("ko-KR")}
                  <em>원</em>
                </p>
                <span className="frame-price-basis">
                  {derived.priceSample ? `시세 표본 ${derived.priceSample}건` : "에이전트 추정"}
                  {hasDiscount ? " · 즉시할인 적용가" : discountKnown ? " · 정가" : ""}
                </span>
              </div>
            ) : null}
          </Slot>

          <Slot
            slotKey="tags"
            registerSlot={registerSlot}
            filled={tagsDocked}
            target={targetSlots?.has("tags") === true}
            className="slot-tags"
            ghost={<span className="ghost-label">검색 태그</span>}
          >
            {/* 태그는 **있는 대로 다 건다** — 무엇으로 검색에 걸리는지가 이 칸의 전부다.
                칸을 넘길 때만 들어가는 만큼 걸고 나머지는 "+N"으로 접는다(줄 수 실측). */}
            <FrameTags texts={tagTexts} count={derived.tagCount ?? 0} />
          </Slot>

          <ul
            ref={registerSlot("meta")}
            className={`frame-meta${metaDocked ? " is-filled" : ""}${targetSlots?.has("meta") === true ? " is-target" : ""}`}
            aria-label="필수 표시 항목"
          >
            <li className="frame-meta-head">
              필수 표시 항목
              <em>법으로 요구되는 칸</em>
            </li>
            {rows.map((row) => (
              <li key={row.label} className={metaDocked && row.value ? "is-on" : ""}>
                <span className="frame-meta-dot" aria-hidden="true">
                  {metaDocked && row.value ? <CheckIcon size={11} weight="bold" /> : null}
                </span>
                <strong>{row.label}</strong>
                <span className="frame-meta-value">{metaDocked ? (row.value ?? "—") : ""}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* 상세페이지는 틀의 **세 번째 칼럼**이다 — 아래 스트립으로 깔면 틀이 세로로
            길어져 무대 폭을 못 쓰고, 패널이 손톱만 해진다. 좁은 화면에서만 행으로 내려간다. */}
        <section className="frame-detail" aria-label="상세페이지">
          {/*
            컨셉 문구는 리빌로 날아오지 않는다 — 카드로 띄우면 "이것도 어느 칸에 꽂히는
            산출물"로 읽혀 관객이 헷갈린다. 이 자리에 그대로 써진다.

            타이밍은 **덱이 열리기 직전**이다 — 먼저 "이렇게 만들 겁니다"를 읽고 곧바로
            6컷이 꽂혀야 인과로 읽힌다. 기획이 끝나자마자 띄우면 패널 생성 20초 동안
            문구만 덩그러니 떠 있고, 뒤에 붙이면 나중에 단 캡션이 된다.
          */}
          <div ref={registerSlot("plan")} className={`frame-detail-head${derived.plan ? " is-filled" : ""}`}>
            <strong>상세페이지</strong>
            {showConcept && derived.plan ? (
              <span className="frame-concept">
                “<TypedLine text={derived.plan.concept} />”
              </span>
            ) : derived.plan && derived.awaitingHero ? (
              /* 기획은 끝났지만 아직 굽기 전이다 — 기다리는 중을 "생성 중"이라고 하지 않는다. */
              <span className="frame-detail-wait">대표 이미지를 기다리는 중…</span>
            ) : derived.plan ? (
              /* 기획은 끝났고 그림을 굽는 중 — 지금 벌어지는 일을 사실대로 말한다. */
              <span className="frame-detail-wait">
                패널 {derived.panelTotal ?? derived.plan.panelCount}컷 생성 중…
              </span>
            ) : derived.planFailed ? (
              /* 기획이 실패로 끝났다 — 오지 않을 것을 기다리는 그림을 남기지 않는다. */
              <span className="frame-detail-wait is-failed">기획 실패 — 기본 레이아웃으로 진행</span>
            ) : derived.planStarted ? (
              <span className="frame-detail-wait">컨셉 기획 중…</span>
            ) : (
              <span className="frame-detail-wait">본문 — 구매를 결정짓는 자리</span>
            )}
            {panelTotal ? (
              <span className="frame-detail-count">
                {panelsDocked.length}/{panelTotal}
              </span>
            ) : null}
          </div>
          <div className="frame-panels">
            {[0, 1, 2, 3, 4, 5].map((index) => {
              // 위치가 아니라 **서사 번호**로 찾는다 — 도착 순서로 접근하면 6번 컷이 1번 칸에 걸린다.
              const panel = derived.panels.find((item) => item.index === index);
              const filled = panel != null && docked.has(`panel-${panel.index}`);
              const planned = derived.plan?.sections.filter((section) => section.hasPanel)[index];
              return (
                <Slot
                  key={index}
                  slotKey={`panel-${index}` as SlotKey}
                  registerSlot={registerSlot}
                  filled={filled}
                  target={targetSlots?.has(`panel-${index}`) === true}
                  className="slot-panel"
                  ghost={
                    <span className="ghost-panel-num">
                      {planned ? (ROLE_LABEL[planned.role] ?? planned.role) : index + 1}
                    </span>
                  }
                >
                  {filled && panel ? <img src={panel.url} alt={panel.headline || panel.role} /> : null}
                </Slot>
              );
            })}
          </div>
        </section>
      </div>

      {/*
        등록필 도장은 실제로 스토어에 올라갔을 때만 찍힌다 — 보류로 끝난 런에
        도장을 찍으면 그 순간 무대가 거짓말을 한다.
        ⚠ 아직 꽂히는 중이면 기다린다. 서버는 조립 연출보다 먼저 끝나므로(실측 5~9초),
        terminal 만 보고 찍으면 빈 칸이 남은 틀 위에 "등록 완료" 도장이 먼저 앉는다.
      */}
      {complete && live && !assembling ? (
        <div className="frame-stamp" role="img" aria-label="스마트스토어 등록 완료">
          <span>등록</span>
          <em>SMARTSTORE</em>
        </div>
      ) : null}
    </section>
  );
}

// --- 조립 무대 (틀 + 디렉터) ---------------------------------------------------

export function AssemblyStage({
  derived,
  listing,
  scene,
  live,
  terminal,
  onPlayingChange,
}: {
  derived: ControlDerived;
  listing: ListingRecord;
  scene: SceneKey;
  live: boolean;
  terminal: TerminalStatus;
  /** 남은 조립 연출이 있는지 부모에게 알린다 — 결과 화면 전환이 이걸 기다린다. */
  onPlayingChange?: (playing: boolean) => void;
}) {
  const registry = useRef(new Map<SlotKey, HTMLElement>());
  const registrars = useRef(new Map<SlotKey, (el: HTMLElement | null) => void>());
  const registerSlot = useCallback<SlotRegistrar>((key) => {
    let fn = registrars.current.get(key);
    if (!fn) {
      fn = (el) => {
        if (el) registry.current.set(key, el);
        else registry.current.delete(key);
      };
      registrars.current.set(key, fn);
    }
    return fn;
  }, []);
  const getSlot = useCallback((key: SlotKey) => registry.current.get(key) ?? null, []);

  const reduced = usePrefersReducedMotion();
  /*
    종착(settled)과 무연출(instant)은 다른 것이다.
    settled 는 "더 기다릴 이유가 없다"(묶음 대기 해제 + 서두르기)이고,
    instant 는 "연출을 하지 않는다"(reduced-motion)이다. 예전에는 이 둘이 한 플래그로
    묶여 있어서, 런이 끝나는 순간 남은 조립 연출이 통째로 사라졌다.
  */
  const settled = terminal != null || scene === "complete";
  const { docked, active, backlogRef, onDone, dockKeys, playing } = useRevealDirector(
    derived,
    listing,
    settled,
    reduced,
  );

  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);
  // 무대가 사라지면 남은 연출도 없다 — 부모가 이 신호를 기다리다 갇히지 않게 한다.
  useEffect(() => () => onPlayingChange?.(false), [onPlayingChange]);

  // 덱은 여섯 칸을 한꺼번에 겨냥한다 — 착지점 사전 점등도 여섯 곳 전부.
  const targetSlots = active
    ? new Set<string>([active.slot, ...(active.docks ?? [])].filter((key) => !docked.has(key)))
    : null;
  /*
    딤은 **중앙에 무언가 뜰 때만** 켠다. 할인 같은 인라인 박자는 연출이 틀 안에서
    벌어지므로 딤을 켜면 정작 봐야 할 칸이 어두워진다.
  */
  const dimming = active != null && active.content.type !== "inline";

  return (
    <div className={`assembly${dimming ? " is-revealing" : ""}`}>
      <ListingFrame
        derived={derived}
        listing={listing}
        docked={docked}
        registerSlot={registerSlot}
        targetSlots={targetSlots}
        showDiscount={active?.key === "discount" || docked.has("discount")}
        /* 컨셉은 6컷이 **다 꽂힌 뒤**에 써진다 — 배치가 끝나야 "이런 이야기였다"가 된다. */
        showConcept={docked.has("panels-deck")}
        scene={scene}
        live={live}
        terminal={terminal}
        assembling={playing}
      />
      {active && active.content.type === "inline" ? (
        <InlineBeat key={active.key} item={active} onDone={onDone} reduced={reduced} />
      ) : active && active.content.type === "panels" ? (
        <PanelDeckOverlay
          key={active.key}
          item={active}
          panels={active.content.panels}
          getSlot={getSlot}
          onDone={onDone}
          onLanded={dockKeys}
          reduced={reduced}
          hurry={settled}
        />
      ) : active ? (
        <RevealOverlay
          key={active.key}
          item={active}
          backlogRef={backlogRef}
          getSlot={getSlot}
          onDone={onDone}
          reduced={reduced}
        />
      ) : null}
    </div>
  );
}
