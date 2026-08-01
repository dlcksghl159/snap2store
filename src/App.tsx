import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  ImageSquareIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { createListing, fetchListing, fetchListings, formatDate, formatPrice } from "./api";
import { PhoneLinkModal, PhoneStudio } from "./PhoneLink";
import { usePhoneLink } from "./link-client";
import { EyeBadge } from "./PhoneEye";
import { eyeSupported, usePhoneEye, type PhoneEyeApi } from "./phone-eye";
import { MissionControl, ResultShowcase } from "./Theater";
import { FACT_KIND_LABEL, ROLE_LABEL } from "./stage-model";
import type { ListingEvent, ListingMaterials, ListingRecord } from "./domain/types";

const TERMINAL = new Set(["registered", "needs_review", "failed"]);
const POLL_MS = 650;
const LINGER_MS = 3200;
const MAX_PHOTOS = 10;

const PHASE_RAIL = [
  "상품 파악",
  "신원 검증",
  "연출 이미지",
  "카테고리 확정",
  "등록 재료",
  "규정 검증",
  "스토어 등록",
];

type View = "upload" | "listings";

/** 발사 전환 — 업로드 사진이 스테이지로 인수인계되는 비행 정보. */
interface Flight {
  photo: string;
  from: { left: number; top: number; width: number; height: number };
}

export default function App() {
  const [view, setView] = useState<View>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeListing, setActiveListing] = useState<ListingRecord | null>(null);
  const [listings, setListings] = useState<ListingRecord[]>([]);
  const [detailListing, setDetailListing] = useState<ListingRecord | null>(null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [flightAborted, setFlightAborted] = useState(false);
  const [lingerDone, setLingerDone] = useState(false);
  /** 무대에 아직 재생할 조립 연출이 남았는가 — 결과 화면 전환이 이걸 기다린다. */
  const [revealPlaying, setRevealPlaying] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const openedRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const firstThumbRef = useRef<HTMLImageElement | null>(null);
  const previewsRef = useRef<string[]>([]);
  previewsRef.current = previews;

  /* blob URL 누수 방지 — 연속 등록에서 쌓인다. */
  useEffect(
    () => () => {
      for (const url of previewsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const replaceFiles = useCallback((next: File[]) => {
    setPreviews((current) => {
      for (const url of current) URL.revokeObjectURL(url);
      return next.map((file) => URL.createObjectURL(file));
    });
    setFiles(next);
    setError(null);
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const picked = Array.from(incoming).filter((file) => file.type.startsWith("image/"));
      if (picked.length === 0) return;
      replaceFiles([...files, ...picked].slice(0, MAX_PHOTOS));
    },
    [files, replaceFiles],
  );

  const removeFile = useCallback(
    (index: number) => {
      replaceFiles(files.filter((_, position) => position !== index));
    },
    [files, replaceFiles],
  );

  /* ── 폰 링크 — 셔터가 트레이로, 말은 서기가 정리해 메모로 ── */
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const noteRef = useRef(note);
  noteRef.current = note;

  const link = usePhoneLink({
    onPhotoFile: (file) => addFilesRef.current([file]),
    // 서기가 메모 전문을 다시 써서 보낸다 — 이어붙이지 않고 교체한다.
    onNote: (text) => setNote(text.slice(0, 2000)),
  });

  /* 폰 셔터 비활성·카운트의 진실은 데스크톱 트레이다 — 변할 때마다 폰에 알린다. */
  useEffect(() => {
    if (link.phase === "live") link.sendTray(files.length, MAX_PHOTOS);
  }, [files.length, link.phase, link.sendTray]);

  /* 세션이 켜지는 순간, 이미 적어 둔 메모를 서기의 출발점으로 넘긴다. */
  useEffect(() => {
    if (link.phase === "live") link.sendNoteSeed(noteRef.current);
  }, [link.phase, link.sendNoteSeed]);

  /* 목록 로딩 */
  const refreshListings = useCallback(() => {
    void fetchListings()
      .then(setListings)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshListings();
  }, [refreshListings]);

  /* 폴링 — 종착하면 끈다. */
  const activeId = activeListing?.id ?? null;
  const activeStatus = activeListing?.status ?? null;

  useEffect(() => {
    if (!activeId || (activeStatus && TERMINAL.has(activeStatus))) return;
    const timer = window.setInterval(() => {
      void fetchListing(activeId)
        .then(setActiveListing)
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeId, activeStatus]);

  useEffect(() => {
    if (!activeStatus || !TERMINAL.has(activeStatus)) return;
    refreshListings();
  }, [activeStatus, refreshListings]);

  /*
    종착 처리 — 유지 3.2초 뒤 결과 화면.
    ⚠ 남은 조립 연출이 있으면 시계를 시작하지 않는다. 서버는 재료 완료 1~3초 뒤에
    등록을 끝내는데 그때 무대에는 아직 재생할 카드가 남아 있다 — 여기서 곧바로
    넘어가면 관객은 조립을 못 본 채 결과 화면을 맞는다.
  */
  useEffect(() => {
    if (activeStatus !== "registered" || revealPlaying) return;
    const timer = window.setTimeout(() => setLingerDone(true), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [activeStatus, revealPlaying]);

  /* 실등록 완료 시 상품 페이지 자동 오픈 */
  useEffect(() => {
    if (!activeListing) return;
    const url = activeListing.publication?.productUrl;
    if (activeListing.status === "registered" && url && openedRef.current !== activeListing.id) {
      openedRef.current = activeListing.id;
      window.open(url, "_blank", "noopener");
    }
  }, [activeListing]);

  const controlVisible =
    activeListing != null &&
    !dismissed &&
    (!TERMINAL.has(activeListing.status) ||
      activeListing.status === "needs_review" ||
      activeListing.status === "failed" ||
      (activeListing.status === "registered" && !lingerDone));

  const showResult =
    activeListing != null && activeListing.status === "registered" && lingerDone && !controlVisible;

  /**
   * 폰 아이 — 랜딩이 맨 앞에 있고 아직 폰이 안 붙었을 때만 맥북 카메라가 지켜본다.
   * 그 밖의 모든 순간(등록 진행·결과·드로어·목록·이미 연결됨)에는 눈을 감는다.
   * 켤 이유가 없는데 켜져 있는 카메라는 그 자체로 버그다.
   */
  const eye = usePhoneEye({
    enabled:
      eyeSupported() &&
      view === "upload" &&
      link.phase === "idle" &&
      !controlVisible &&
      !showResult &&
      detailListing == null,
    onSpot: link.start,
  });

  /* 스테이지·폰 링크가 떠 있는 동안 스크롤 잠금 — parked 는 랜딩이 그대로 보이는 상태다 */
  const linkOverlayVisible = link.phase !== "idle" && link.phase !== "parked";
  useEffect(() => {
    if (!controlVisible && !detailListing && !linkOverlayVisible) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [controlVisible, detailListing, linkOverlayVisible]);

  /* 드로어 Escape */
  useEffect(() => {
    if (!detailListing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailListing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailListing]);

  const resetRun = useCallback(() => {
    setActiveListing(null);
    setLingerDone(false);
    setRevealPlaying(false);
    setDismissed(false);
    openedRef.current = null;
    replaceFiles([]);
    setNote("");
  }, [replaceFiles]);

  const start = useCallback(async () => {
    if (submitting) return;
    if (files.length === 0) {
      inputRef.current?.click();
      return;
    }
    setSubmitting(true);
    setError(null);
    setLingerDone(false);
    setRevealPlaying(false);
    setDismissed(false);
    setFlightAborted(false);

    const thumb = firstThumbRef.current;
    if (thumb && previews[0]) {
      const rect = thumb.getBoundingClientRect();
      setFlight({
        photo: previews[0],
        from: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    }

    try {
      const { id } = await createListing(files, note);
      const record = await fetchListing(id).catch(() => null);
      setActiveListing(
        record ?? {
          id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "queued",
          stage: "queued",
          stageLabel: "대기 중",
          progress: 2,
          photoUrls: [],
          photoPaths: [],
          sellerNote: note || null,
          draft: null,
          materials: null,
          publication: null,
          blockReasons: [],
          warnings: [],
          error: null,
          events: [],
        },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "등록을 시작하지 못했습니다.");
      // 사진을 그냥 지우지 않는다 — 들어올렸던 클론이 제자리로 돌아가야 취소로 읽힌다.
      setFlightAborted(true);
    } finally {
      setSubmitting(false);
    }
  }, [files, note, previews, submitting]);

  return (
    <>
      <header className="hdr">
        <span className="wordmark">Snap2Store</span>
        <nav className="nav">
          <button
            type="button"
            className="nav-pill"
            aria-current={view === "upload" ? "page" : undefined}
            onClick={() => setView("upload")}
          >
            물건 올리기
          </button>
          <button
            type="button"
            className="nav-pill"
            aria-current={view === "listings" ? "page" : undefined}
            onClick={() => {
              setView("listings");
              refreshListings();
            }}
          >
            올린 물건
          </button>
        </nav>
      </header>

      {view === "upload" ? (
        showResult && activeListing ? (
          <ResultShowcase
            listing={activeListing}
            onNew={resetRun}
            onList={() => {
              resetRun();
              setView("listings");
              refreshListings();
            }}
          />
        ) : (
          <LandingView
            files={files}
            previews={previews}
            note={note}
            error={error ?? link.error}
            submitting={submitting}
            inputRef={inputRef}
            firstThumbRef={firstThumbRef}
            onPick={addFiles}
            onRemove={removeFile}
            onNote={setNote}
            onStart={() => void start()}
            onPhoneLink={link.start}
            eye={eye}
            linkBusy={link.phase !== "idle" && link.phase !== "parked"}
            linkParked={link.phase === "parked"}
            voiceLive={link.phase === "live" && link.voice.status === "ready"}
          />
        )
      ) : (
        <ListingsView
          listings={listings}
          onOpen={setDetailListing}
          onNew={() => {
            resetRun();
            setView("upload");
          }}
        />
      )}

      {controlVisible && activeListing ? (
        <MissionControl
          listing={activeListing}
          onReview={() => {
            setDismissed(true);
            setView("listings");
            setDetailListing(activeListing);
            refreshListings();
          }}
          onDismiss={() => {
            setDismissed(true);
            refreshListings();
          }}
          onPlayingChange={setRevealPlaying}
        />
      ) : null}

      {flight ? (
        <LaunchOverlay
          flight={flight}
          stageMounted={controlVisible}
          aborted={flightAborted}
          onDone={() => {
            setFlight(null);
            setFlightAborted(false);
          }}
        />
      ) : null}

      {detailListing ? (
        <ListingDetail listing={detailListing} onClose={() => setDetailListing(null)} />
      ) : null}

      {link.phase === "creating" || link.phase === "waiting" ? (
        <PhoneLinkModal link={link} onCancel={link.cancel} />
      ) : null}

      {link.phase === "live" || link.phase === "ending" ? (
        <PhoneStudio
          link={link}
          trayCount={files.length}
          trayMax={MAX_PHOTOS}
          onClosed={link.park}
        />
      ) : null}
    </>
  );
}

/* ═════════ 랜딩 (노스크롤 원뷰포트) ═════════ */

interface LandingViewProps {
  files: File[];
  previews: string[];
  note: string;
  error: string | null;
  submitting: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  firstThumbRef: React.RefObject<HTMLImageElement | null>;
  onPick: (files: FileList | File[]) => void;
  onRemove: (index: number) => void;
  onNote: (value: string) => void;
  onStart: () => void;
  onPhoneLink: () => void;
  eye: PhoneEyeApi;
  linkBusy: boolean;
  linkParked: boolean;
  voiceLive: boolean;
}

function LandingView({
  files,
  previews,
  note,
  error,
  submitting,
  inputRef,
  firstThumbRef,
  onPick,
  onRemove,
  onNote,
  onStart,
  onPhoneLink,
  eye,
  linkBusy,
  linkParked,
  voiceLive,
}: LandingViewProps) {
  const [over, setOver] = useState(false);

  /* 스크린샷·복사한 이미지를 그대로 받는다 — 트레이가 이 화면의 주인공이다. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.files;
      if (pasted && pasted.length > 0) onPick(pasted);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPick]);

  const openPicker = () => inputRef.current?.click();

  return (
    <main className="land">
      <div className="aurora" aria-hidden>
        <i />
        <i />
        <i />
      </div>

      <section className="hero">
        <span className="dest-line rise">
          <span className="dest-mark" aria-hidden>
            N
          </span>
          스마트스토어
        </span>
        <h1 className="rise" style={{ "--i": 1 } as React.CSSProperties}>
          찍으면, <em>등록까지.</em>
        </h1>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) onPick(event.target.files);
          event.target.value = "";
        }}
      />

      <section className="deck rise" style={{ "--i": 3 } as React.CSSProperties}>
        <div
          className={`tray ${over ? "over" : ""} ${files.length > 0 ? "filled" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="팔 물건 사진 올리기"
          onClick={openPicker}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openPicker();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            if (event.dataTransfer.files) onPick(event.dataTransfer.files);
          }}
        >
          {files.length === 0 ? (
            <div className="tray-empty">
              <span className="tray-glyph" aria-hidden>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1-1.6A1 1 0 0 1 9.5 4h5a1 1 0 0 1 .85.4L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <circle cx="12" cy="12.4" r="3.2" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </span>
            </div>
          ) : (
            <div className="photo-grid">
              {previews.map((url, index) => (
                <div className="photo-cell" key={url} style={{ "--i": index } as React.CSSProperties}>
                  <img
                    ref={index === 0 ? firstThumbRef : undefined}
                    src={url}
                    alt={`올린 사진 ${index + 1}`}
                  />
                  <button
                    type="button"
                    className="photo-remove"
                    aria-label={`사진 ${index + 1} 제거`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(index);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {files.length < MAX_PHOTOS ? (
                <button
                  type="button"
                  className="photo-add"
                  aria-label="사진 더 추가"
                  onClick={(event) => {
                    event.stopPropagation();
                    inputRef.current?.click();
                  }}
                >
                  +
                </button>
              ) : null}
            </div>
          )}
          <div className="tray-veil" aria-hidden>
            <b>놓으면 담겨요</b>
          </div>
        </div>

        <aside className="deck-side">
          <button
            type="button"
            className="link-cta"
            onClick={onPhoneLink}
            disabled={linkBusy}
          >
            <span className="link-cta-icon" aria-hidden>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                <rect x="7" y="2.8" width="10" height="18.4" rx="2.6" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="12" cy="17.6" r="1.15" fill="currentColor" />
                <path d="M10.4 5.4h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
            <span className="link-cta-copy">
              <b>{linkParked ? "핸드폰 연결됨" : "핸드폰으로 찍기"}</b>
              {linkParked ? <small>다시 촬영은 폰에서</small> : null}
            </span>
            <span className="link-cta-arrow" aria-hidden>
              →
            </span>
          </button>

          {linkParked ? null : <EyeBadge eye={eye} />}

          <label className="note-block">
            {voiceLive ? (
              <span className="voice-chip voice-float">
                <span className="voice-bars" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                받아 적는 중
              </span>
            ) : null}
            <textarea
              value={note}
              maxLength={2000}
              onChange={(event) => onNote(event.target.value)}
              placeholder="브랜드 · 상태 · 가격"
            />
          </label>

          {error ? <div className="inline-error">{error}</div> : null}

          <button
            type="button"
            className="btn btn-xl btn-primary deck-start"
            onClick={onStart}
            disabled={submitting}
          >
            {submitting ? <span className="spinner" aria-hidden /> : null}
            등록 시작
            {files.length > 0 ? <span className="cta-count tnum">{files.length}</span> : null}
            <span className="arrow">→</span>
          </button>
        </aside>
      </section>

      <footer className="land-strip">
        <ol className="rail">
          {PHASE_RAIL.map((label, index) => (
            <li key={label}>
              <b>{index + 1}</b>
              {label}
            </li>
          ))}
        </ol>
        <div className="land-foot">
          <span>YAI × OpenAI AGENT:24</span>
          <a className="stream-link" href="/stream" target="_blank" rel="noreferrer">
            <i aria-hidden />
            Raw API Stream ↗
          </a>
        </div>
      </footer>
    </main>
  );
}

/* ═════════ 발사 전환 ═════════ */

/**
 * `등록 시작` → 스테이지 진입 사이의 인수인계 연출.
 * 업로드 사진이 들려 올라가 화면 중앙에 머물렀다가(전달 중), 스테이지가
 * 마운트되면 좌하단 원본 슬롯으로 날아가 장착된다. 실패 시 제자리로 복귀.
 *
 * ⚠ 비행은 flight 1회당 **정확히 한 번**만 돌아야 한다. 부모(App)는 실행 중
 * 650ms 폴링으로 계속 리렌더되므로 매 렌더 새로 만들어지는 콜백이 deps 에 들어가면
 * 비행이 처음부터 다시 시작된다 — "사진이 무한히 날아가는" 사고의 원인.
 */
function LaunchOverlay({
  flight,
  stageMounted,
  aborted,
  onDone,
}: {
  flight: Flight;
  stageMounted: boolean;
  aborted: boolean;
  onDone: () => void;
}) {
  const cloneRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const liftDoneAtRef = useRef(0);
  const settledRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 클론은 최대(중앙) 크기로 레이아웃하고 transform 으로 축소해서 시작한다 —
  // 작은 크기로 래스터된 레이어를 확대하면 비행 내내 화질이 깨진다 (실측).
  const [center] = useState(() => {
    const size = Math.min(window.innerHeight * 0.34, window.innerWidth * 0.3, 340);
    return { size, x: window.innerWidth / 2, y: window.innerHeight * 0.44 };
  });

  const fromTransform = useCallback(() => {
    const { from } = flight;
    const dx = from.left + from.width / 2 - center.x;
    const dy = from.top + from.height / 2 - center.y;
    return `translate(${dx}px, ${dy}px) scale(${from.width / center.size})`;
  }, [center, flight]);

  /* 1) 들어올리기 — 원래 자리(축소 상태)에서 화면 중앙 원크기로. */
  useEffect(() => {
    const clone = cloneRef.current;
    if (!clone) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      liftDoneAtRef.current = performance.now();
      return;
    }
    clone.animate(
      [{ transform: fromTransform() }, { transform: "translate(0px, 0px) scale(1)" }],
      { duration: 560, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" },
    );
    liftDoneAtRef.current = performance.now() + 620;
  }, [flight, fromTransform]);

  /* 2) 장착 또는 복귀. */
  useEffect(() => {
    if (!stageMounted && !aborted) return;
    const clone = cloneRef.current;
    const veil = veilRef.current;
    if (!clone || !veil) return;
    let raf = 0;
    let tries = 0;
    let cancelled = false;

    const settle = (transform: string, flyMs: number) => {
      if (cancelled || settledRef.current) return;
      settledRef.current = true;
      captionRef.current?.animate([{ opacity: 0 }], {
        duration: 180,
        easing: "ease-in",
        fill: "forwards",
      });
      const animation = clone.animate([{ transform, opacity: 0 }], {
        duration: flyMs,
        easing: "cubic-bezier(0.645, 0.045, 0.355, 1)",
        fill: "forwards",
      });
      const finish = () => {
        if (cancelled) return;
        const fade = veil.animate([{ opacity: 0 }], {
          duration: aborted ? 220 : 300,
          easing: "ease-in",
          fill: "forwards",
        });
        fade.onfinish = () => onDoneRef.current();
        fade.oncancel = () => onDoneRef.current();
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
    };

    if (aborted) {
      settle(fromTransform(), 340);
      return;
    }

    const seek = () => {
      if (cancelled || settledRef.current) return;
      const target = document.querySelector<HTMLElement>(
        '.stage [data-launch-target="evidence"] img, .stage [data-launch-target="evidence"]',
      );
      const ready = target && target.getBoundingClientRect().width > 0;
      if (!ready || performance.now() < liftDoneAtRef.current) {
        if (++tries < 600) raf = requestAnimationFrame(seek);
        else settle("translate(0px, 0px) scale(1)", 300);
        return;
      }
      const to = target.getBoundingClientRect();
      const dx = to.left + to.width / 2 - center.x;
      const dy = to.top + to.height / 2 - center.y;
      settle(`translate(${dx}px, ${dy}px) scale(${to.width / center.size})`, 540);
    };
    raf = requestAnimationFrame(seek);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [stageMounted, aborted, flight, center, fromTransform]);

  return (
    <div className="launch" role="status" aria-label="에이전트에게 전달 중">
      <div ref={veilRef} className="launch-veil" />
      <div
        ref={cloneRef}
        className="launch-clone"
        style={{
          left: center.x - center.size / 2,
          top: center.y - center.size / 2,
          width: center.size,
          height: center.size,
          transform: fromTransform(),
        }}
      >
        <img src={flight.photo} alt="" />
      </div>
      <p ref={captionRef} className="launch-caption">
        에이전트에게 전달하고 있어요
      </p>
    </div>
  );
}

/* ═════════ 올린 물건 ═════════ */

function statusLabel(listing: ListingRecord): string {
  if (listing.status === "registered") {
    if (listing.publication?.mode === "live" && listing.publication?.liveStatus === "registered") {
      return "등록 완료";
    }
    // 스토어 POST 까지 가지 못한 런 — 실행 모드가 아니라 결과를 말한다.
    return "등록안 완성";
  }
  if (listing.status === "needs_review") return "검토 필요";
  if (listing.status === "failed") return "실패";
  return "등록 중";
}

function ListingStatus({ listing }: { listing: ListingRecord }) {
  const pending = listing.status === "queued" || listing.status === "running";
  const Icon =
    listing.status === "registered"
      ? CheckCircleIcon
      : listing.status === "needs_review" || listing.status === "failed"
        ? WarningCircleIcon
        : SpinnerGapIcon;
  return (
    <span className={`status-pill status-${listing.status}`}>
      <Icon className={pending ? "spin" : ""} size={14} weight="fill" aria-hidden="true" />
      {statusLabel(listing)}
    </span>
  );
}

function ListingsView({
  listings,
  onOpen,
  onNew,
}: {
  listings: ListingRecord[];
  onOpen: (listing: ListingRecord) => void;
  onNew: () => void;
}) {
  return (
    <main className="library">
      <div className="library-head">
        <h1>올린 물건</h1>
        <p>등록 결과만 간단히 확인하세요</p>
      </div>

      {listings.length === 0 ? (
        <section className="library-empty">
          <ImageSquareIcon size={40} weight="light" aria-hidden="true" />
          <h2>아직 올린 물건이 없어요</h2>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            첫 물건 올리기
          </button>
        </section>
      ) : (
        <section className="library-grid" aria-label="올린 물건 목록">
          {listings.map((listing) => {
            const image = listing.materials?.media.mainUrl ?? listing.photoUrls[0] ?? null;
            return (
              <button className="item" type="button" key={listing.id} onClick={() => onOpen(listing)}>
                <div className="item-img">
                  {image ? (
                    <img src={image} alt="" />
                  ) : (
                    <ImageSquareIcon size={34} weight="light" aria-hidden="true" />
                  )}
                </div>
                <div className="item-body">
                  <div className="item-meta">
                    <ListingStatus listing={listing} />
                    <time dateTime={listing.createdAt}>{formatDate(listing.createdAt)}</time>
                  </div>
                  <h2>
                    {listing.materials?.registrationTitle ?? listing.draft?.title ?? "등록안 준비 중"}
                  </h2>
                  <p>{formatPrice(listing.materials?.price.salePrice ?? listing.draft?.salePrice)}</p>
                </div>
              </button>
            );
          })}
        </section>
      )}
    </main>
  );
}

/* ═════════ 상세 드로어 ═════════ */

function EventRow({ event }: { event: ListingEvent }) {
  return (
    <li>
      <div className="event-line">
        <time>{new Date(event.at).toLocaleTimeString("ko-KR", { hour12: false })}</time>
        <span>{event.source}</span>
        <strong>{event.label}</strong>
      </div>
      {event.payload ? <pre>{JSON.stringify(event.payload, null, 2)}</pre> : null}
    </li>
  );
}

function MaterialsSection({ materials }: { materials: ListingMaterials }) {
  const rows: Array<{ label: string; value: string; ok: boolean | null }> = [
    {
      label: "카테고리",
      value: materials.category.categoryName ?? "미확정",
      ok: materials.category.categoryId ? materials.category.verified : false,
    },
    {
      label: "판매가 근거",
      value: materials.price.priceBasis,
      ok: materials.price.resolved,
    },
    {
      label: "원산지",
      value: materials.origin.originAreaInfo?.content ?? (materials.origin.reviewReason ?? "미확정"),
      ok: materials.origin.resolved,
    },
    { label: "KC 인증", value: materials.kc.statusLabel, ok: !materials.kc.blocking },
    {
      label: "정보제공고시",
      value: materials.notice.typeUnconfirmed
        ? "유형 미확인 — 기타 재화로 등록"
        : (materials.notice.noticeTypeName ?? materials.notice.noticeType),
      ok: !materials.notice.usedFallbackType,
    },
    {
      label: "태그",
      value:
        materials.tags.tags.length > 0
          ? materials.tags.tags.map((tag) => `${tag.text}${tag.official ? "" : "*"}`).join(", ")
          : "없음",
      ok: materials.tags.tags.length > 0,
    },
  ];

  return (
    <section className="drawer-section">
      <h3>등록 재료</h3>
      <ul className="materials-list">
        {rows.map((row) => (
          <li key={row.label}>
            <span className={row.ok === false ? "material-flag material-flag-warn" : "material-flag"}>
              {row.ok === false ? "!" : "✓"}
            </span>
            <div>
              <strong>{row.label}</strong>
              <p>{row.value}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ListingDetail({ listing, onClose }: { listing: ListingRecord; onClose: () => void }) {
  const materials = listing.materials;
  const publication = listing.publication;
  const plan = materials?.detailPlan ?? null;
  const image = materials?.media.mainUrl ?? listing.photoUrls[0] ?? null;
  const holdReasons = publication?.holdReasons ?? [];

  return (
    <div className="detail-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="drawer-close" type="button" onClick={onClose} aria-label="닫기" autoFocus>
          <XIcon size={20} weight="bold" aria-hidden="true" />
        </button>
        <div className="detail-hero">{image ? <img src={image} alt="" /> : null}</div>
        <div className="detail-content">
          <ListingStatus listing={listing} />
          <h2 id="detail-title">
            {materials?.registrationTitle ?? listing.draft?.title ?? "등록안 준비 중"}
          </h2>
          {listing.draft?.summary ? <p className="detail-summary">{listing.draft.summary}</p> : null}
          <dl className="detail-facts">
            <div>
              <dt>판매가</dt>
              <dd>{formatPrice(materials?.price.salePrice ?? listing.draft?.salePrice)}</dd>
            </div>
            <div>
              <dt>카테고리</dt>
              <dd>{materials?.category.leafName ?? materials?.category.categoryName ?? "확인 중"}</dd>
            </div>
            <div>
              <dt>등록 번호</dt>
              <dd className="mono">{publication?.channelProductNo ?? publication?.originProductNo ?? "—"}</dd>
            </div>
            <div>
              <dt>진행 상태</dt>
              <dd>{listing.stageLabel}</dd>
            </div>
            {publication?.productUrl ? (
              <div>
                <dt>상품 링크</dt>
                <dd className="wrap-any">
                  <a href={publication.productUrl} target="_blank" rel="noreferrer">
                    스마트스토어에서 보기
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>

          {listing.blockReasons.length > 0 ? (
            <section className="drawer-section resolution-panel">
              <h3>에이전트 판정</h3>
              <ul className="block-reasons">
                {listing.blockReasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {holdReasons.length > 0 ? (
            <section className="drawer-section resolution-panel">
              <h3>실등록 보류 사유 (등록안은 완성됨)</h3>
              <ul className="block-reasons">
                {holdReasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {plan ? (
            <section className="drawer-section">
              <h3>상세페이지 기획</h3>
              <p className="drawer-concept">“{plan.concept}”</p>
              <p className="drawer-angle">{plan.angle}</p>
              <ol className="drawer-sections">
                {plan.sections.map((section, index) => (
                  <li key={`${section.role}-${index}`}>
                    <span>{ROLE_LABEL[section.role] ?? section.role}</span>
                    {section.heading}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {materials ? <MaterialsSection materials={materials} /> : null}

          {listing.draft?.facts?.length ? (
            <section className="drawer-section">
              <h3>판단 근거</h3>
              <ul className="evidence-list">
                {listing.draft.facts.map((fact, index) => (
                  <li key={`${fact.claim}-${index}`}>
                    <span className={`fact-kind fact-${fact.kind}`}>
                      {FACT_KIND_LABEL[fact.kind] ?? fact.kind}
                    </span>
                    <p>{fact.claim}</p>
                    <small>{fact.source}</small>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {listing.warnings.length > 0 ? (
            <section className="drawer-section">
              <h3>경고</h3>
              <ul className="block-reasons">
                {[...new Set(listing.warnings)].map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="agent-stream">
            <summary>Agent stream · {listing.events.length}</summary>
            <ul>
              {listing.events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          </details>
        </div>
      </aside>
    </div>
  );
}
