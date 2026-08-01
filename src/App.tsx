import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  ImageSquareIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  createListing,
  fetchListing,
  fetchListings,
  finalizeNote,
  formatDate,
  formatPrice,
} from "./api";
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
/** 마감 전 셔터 정착 대기 상한 — 원본 폴백(8초)보다 아주 조금 길게. */
const PHOTO_SETTLE_MS = 9000;
/** 정리된 메모가 꽂힌 뒤 등록이 시작되기까지 — 한 문장을 읽을 시간. */
const NOTE_LAND_HOLD_MS = 1900;

/** 마감 처리의 화면 상태. null = 사람이 직접 쓰는 평시. */
type HandoffPhase = null | "reading" | "landed";

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
  /** 폰이 촬영을 마친 뒤의 마감 단계 — 메모칸이 이걸 보고 상태를 그린다. */
  const [handoffPhase, setHandoffPhase] = useState<HandoffPhase>(null);

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
  /* 마감 처리는 훅보다 늦게 정의된다 — 콜백은 ref 를 거쳐 최신 함수를 부른다. */
  const handoffRef = useRef<() => void>(() => undefined);

  const link = usePhoneLink({
    onPhotoFile: (file) => addFilesRef.current([file]),
    // 서기가 메모 전문을 다시 써서 보낸다 — 이어붙이지 않고 교체한다.
    onNote: (text) => setNote(text.slice(0, 2000)),
    onFinish: () => handoffRef.current(),
  });

  const filesRef = useRef(files);
  filesRef.current = files;
  const pendingShotsRef = useRef(0);
  pendingShotsRef.current = link.pendingShots;

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

  /*
    상품 페이지 자동 오픈은 무대(AssemblyStage)가 맡는다 — 등록 완료 "즉시" 열면
    브라우저 포커스가 새 탭으로 넘어가면서, 방금 무엇이 일어났는지 아무도 못 본다.
    주소창이 실제 주소로 바뀌는 마지막 연출이 끝난 뒤에 열린다.

    무대를 거치지 않고 끝난 런(닫아 버렸거나 보류)은 결과 화면의 "스마트스토어에서 보기"가
    남아 있다 — 어느 경로에서도 링크를 잃지 않는다.
  */

  /*
    등록이 끝나면 상품 주소를 폰으로도 보낸다.
    ⚠ 데스크톱의 자동 새 탭은 사용자 제스처 없이 열리므로 브라우저가 막을 수 있다 —
    이건 우리 버그가 아니라 팝업 차단의 정상 동작이고, 설정으로 허용하기 전엔 못 이긴다.
    그래서 문을 하나 더 낸다: 그 순간 폰은 이미 사람 손에 들려 있다.
  */
  const productUrl = activeListing?.publication?.productUrl ?? null;
  const registered = activeListing?.status === "registered";
  useEffect(() => {
    if (!registered || !productUrl) return;
    link.sendHandoff("done", productUrl);
  }, [registered, productUrl, link.sendHandoff]);

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
   * 폰 아이 — 랜딩이 맨 앞에 있을 때만 맥북 카메라가 지켜본다. 등록 진행·결과·드로어·목록
   * 에서는 눈을 감는다. 켤 이유가 없는데 켜져 있는 카메라는 그 자체로 버그다.
   *
   * ⚠ 파킹(폰이 이미 붙어 있음)에서도 눈은 뜬다. 예전엔 idle 일 때만 켜서, 첫 상품을
   * 올린 뒤 "새 상품 올리기"로 돌아오면 카메라가 죽은 것처럼 보였다 — 두 번째 상품부터는
   * 마법이 사라지는 셈이었다. 파킹 중에 폰을 들어 보이면 새 QR 이 아니라 **재개**를 보낸다:
   * 이미 페어링된 폰이 카메라만 다시 열면 되므로 재스캔이 필요 없다.
   */
  const startOrResume = useCallback(() => {
    if (link.phase === "parked") link.resume();
    else link.start();
  }, [link.phase, link.resume, link.start]);

  const eye = usePhoneEye({
    enabled:
      eyeSupported() &&
      view === "upload" &&
      (link.phase === "idle" || link.phase === "parked") &&
      !controlVisible &&
      !showResult &&
      detailListing == null,
    onSpot: startOrResume,
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
    replaceFiles([]);
    setNote("");
  }, [replaceFiles]);

  /**
   * 등록 시작. noteOverride 는 마감 정리가 새로 써 온 메모다 — setNote 는 다음 렌더에나
   * 반영되므로, 그 한 박자를 기다리지 않고 값을 직접 들고 간다.
   * 성공 여부를 돌려준다 (폰에 되돌려 줄 진행 상태가 이걸 본다).
   */
  const start = useCallback(async (noteOverride?: string): Promise<boolean> => {
    if (submitting) return false;
    if (files.length === 0) {
      inputRef.current?.click();
      return false;
    }
    const memo = noteOverride ?? note;
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
      const { id } = await createListing(files, memo);
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
          sellerNote: memo || null,
          draft: null,
          materials: null,
          publication: null,
          blockReasons: [],
          warnings: [],
          error: null,
          events: [],
        },
      );
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "등록을 시작하지 못했습니다.");
      // 사진을 그냥 지우지 않는다 — 들어올렸던 클론이 제자리로 돌아가야 취소로 읽힌다.
      setFlightAborted(true);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [files, note, previews, submitting]);

  /**
   * 마감 — 폰이 촬영을 마쳤다. 여기서 사람이 버튼을 한 번 더 누를 이유가 없다.
   * 말과 사진을 함께 읽어 메모를 완성하고, 그대로 등록까지 간다.
   *
   * 메모 정리가 실패하거나 빈 메모가 와도 등록은 간다 — 말은 틀릴 수 있어도 사진은
   * 이미 다 도착했고, 이 파이프라인의 본체는 사진이다.
   */
  const startRef = useRef(start);
  startRef.current = start;
  const sendHandoff = link.sendHandoff;

  const runHandoff = useCallback(async () => {
    // 마지막 셔터의 원본이 아직 날아오는 중일 수 있다 — 트레이가 잠잠해질 때까지 기다린다.
    const deadline = Date.now() + PHOTO_SETTLE_MS;
    while (pendingShotsRef.current > 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    if (filesRef.current.length === 0) return;

    setHandoffPhase("reading");
    sendHandoff("reading");
    let memo = noteRef.current;
    try {
      memo = await finalizeNote(filesRef.current, noteRef.current);
      setNote(memo);
    } catch {
      /* 말한 그대로 간다 */
    }

    /*
      정리된 메모를 **보여주고** 실행한다. 말한 내용이 어떻게 정리됐는지 확인할 틈도 없이
      등록이 시작되면, 판매자는 자기가 무엇으로 등록됐는지 끝까지 모른 채로 남는다.
      산출물이 칸에 꽂히는 무대의 문법을 여기에도 그대로 쓴다 — 꽂히고, 읽히고, 그 다음 실행.
    */
    setHandoffPhase("landed");
    await new Promise((resolve) => window.setTimeout(resolve, NOTE_LAND_HOLD_MS));

    const ok = await startRef.current(memo);
    setHandoffPhase(null);
    sendHandoff(ok ? "registering" : "failed");
  }, [sendHandoff]);

  useEffect(() => {
    handoffRef.current = () => void runHandoff();
  }, [runHandoff]);

  return (
    <>
      <header className="hdr">
        {/* 만든 자리(해커톤)와 만든 것(제품)이 나란히 선다 — 크기로 위계를 준다. */}
        <span className="hdr-credit">YAI × OpenAI AGENT:24</span>
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
          {/* 세컨드 화면 — 심사석에서 실제 API 스트림을 열어 보는 문이다. */}
          <a className="stream-link" href="/stream" target="_blank" rel="noreferrer">
            <i aria-hidden />
            Raw API Stream ↗
          </a>
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
            handoffPhase={handoffPhase}
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
  /** 폰 마감 단계 — 메모칸이 "읽는 중 → 정리됨"을 보여주고, 그 다음 등록이 뜬다. */
  handoffPhase: HandoffPhase;
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
  handoffPhase,
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

      {/*
        히어로는 한 줄이다. 설명하는 건 화살표 하나뿐 — 읽는 문장이 아니라 보는 그림이
        되어야 사진 한 장이 스토어가 된다는 주장이 0.5초에 전달된다.
      */}
      <section className="hero">
        <h1 className="hero-line" aria-label="Snap 한 장이 스마트스토어 등록까지">
          <span className="rise">Snap</span>
          <span className="hero-arrow" aria-hidden>
            <svg viewBox="0 0 64 20" fill="none">
              <path
                className="hero-arrow-line"
                d="M2 10h52"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <path
                className="hero-arrow-head"
                d="m47.6 4.3 6.6 5.7-6.6 5.7"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="hero-dest rise" style={{ "--i": 10 } as React.CSSProperties}>
            <span className="dest-mark" aria-hidden>
              N
            </span>
            Smartstore
          </span>
        </h1>
        <p className="hero-sub rise" style={{ "--i": 14 } as React.CSSProperties}>
          사진만 올리면 상품명·가격·상세페이지까지 만들어 스마트스토어에 등록합니다
        </p>
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
          {/*
            폰을 부르는 두 가지 길. 기본은 눈(카메라가 알아서 본다)이고, QR 은 만일을
            위한 문이라 아이콘 하나로 족하다 — 글자를 붙이는 순간 주된 길처럼 읽힌다.
          */}
          <div className="deck-tools">
            <EyeBadge eye={eye} parked={linkParked} />
            <button
              type="button"
              className={`qr-btn${linkParked ? " is-linked" : ""}`}
              onClick={onPhoneLink}
              disabled={linkBusy}
              aria-label={linkParked ? "핸드폰 연결됨 — QR 다시 열기" : "QR 코드로 핸드폰 연결"}
              title={linkParked ? "핸드폰 연결됨 — QR 다시 열기" : "QR 코드로 핸드폰 연결"}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="3" y="3" width="7.2" height="7.2" rx="1.7" stroke="currentColor" strokeWidth="1.7" />
                <rect x="13.8" y="3" width="7.2" height="7.2" rx="1.7" stroke="currentColor" strokeWidth="1.7" />
                <rect x="3" y="13.8" width="7.2" height="7.2" rx="1.7" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M13.8 13.8h3v3h-3zM18 18h3v3h-3zM13.8 20.4h1.6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <label className={`note-block${handoffPhase === "landed" ? " is-landed" : ""}`}>
            {handoffPhase === "reading" ? (
              <span className="voice-chip voice-float">
                <span className="spinner" aria-hidden />
                말과 사진을 함께 읽는 중
              </span>
            ) : handoffPhase === "landed" ? (
              <span className="voice-chip voice-float is-done">
                <CheckCircleIcon size={13} weight="fill" aria-hidden="true" />말 + 사진으로 정리했어요
              </span>
            ) : voiceLive ? (
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

          {/* 마감 중에는 이 버튼이 카운트다운이 된다 — 곧 저절로 눌린다는 걸 보여주고,
              먼저 누르면 기다리지 않고 바로 간다. */}
          <button
            type="button"
            className={`btn btn-xl btn-primary deck-start${handoffPhase === "landed" ? " is-arming" : ""}`}
            onClick={onStart}
            disabled={submitting}
          >
            {submitting ? <span className="spinner" aria-hidden /> : null}
            {handoffPhase === "landed" ? "이 내용으로 등록" : "등록 시작"}
            {files.length > 0 ? <span className="cta-count tnum">{files.length}</span> : null}
            <span className="arrow">→</span>
          </button>
        </aside>
      </section>

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
