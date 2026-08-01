import { useCallback, useEffect, useRef, useState } from "react";
import { createListing, fetchListing, fetchListings, formatDate, formatPrice } from "./api";
import { LandingVignette } from "./LandingVignette";
import { MissionControl, ResultShowcase } from "./Theater";
import { FACT_KIND_LABEL, ROLE_LABEL } from "./stage-model";
import type { ListingRecord } from "./domain/types";

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

interface Flight {
  rect: DOMRect;
  url: string;
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
  const [lingerDone, setLingerDone] = useState(false);
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

  /* 종착 처리 — 유지 3.2초 뒤 결과 화면 */
  useEffect(() => {
    if (!activeStatus || !TERMINAL.has(activeStatus)) return;
    refreshListings();
    if (activeStatus !== "registered") return;
    const timer = window.setTimeout(() => setLingerDone(true), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [activeStatus, refreshListings]);

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

  /* 스테이지가 떠 있는 동안 스크롤 잠금 */
  useEffect(() => {
    if (!controlVisible && !detailListing) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [controlVisible, detailListing]);

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
    setDismissed(false);

    const thumb = firstThumbRef.current;
    if (thumb && previews[0]) setFlight({ rect: thumb.getBoundingClientRect(), url: previews[0] });

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
      setFlight(null);
    } finally {
      setSubmitting(false);
    }
  }, [files, note, previews, submitting]);

  return (
    <>
      <header className="hdr">
        <span className="wordmark">
          Snap2Store<em>찍으면, 등록까지</em>
        </span>
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
            error={error}
            submitting={submitting}
            inputRef={inputRef}
            firstThumbRef={firstThumbRef}
            onPick={addFiles}
            onRemove={removeFile}
            onNote={setNote}
            onStart={() => void start()}
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
          onDismiss={() => {
            setDismissed(true);
            refreshListings();
          }}
          onOpenList={() => {
            setDismissed(true);
            setView("listings");
            refreshListings();
          }}
        />
      ) : null}

      {flight ? (
        <LaunchOverlay
          flight={flight}
          armed={controlVisible}
          onDone={() => setFlight(null)}
          failed={Boolean(error)}
        />
      ) : null}

      {detailListing ? (
        <ListingDrawer listing={detailListing} onClose={() => setDetailListing(null)} />
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
}: LandingViewProps) {
  const [over, setOver] = useState(false);

  return (
    <main className="land">
      <div className="land-hero">
        <div className="land-copy">
          <span className="dest-line rise">
            <span className="dest-mark" aria-hidden>
              N
            </span>
            네이버 스마트스토어 자동 등록 에이전트
          </span>
          <h1 className="rise" style={{ "--i": 1 } as React.CSSProperties}>
            팔 물건을 찍으면,
            <br />
            <em>등록까지 끝납니다.</em>
          </h1>
          <p className="land-sub rise" style={{ "--i": 2 } as React.CSSProperties}>
            상품명 · 카테고리 · 판매가 · 상세페이지 · 검색 태그 · 원산지 · KC · 고시 —{" "}
            <b>열 칸을 에이전트가 혼자 채웁니다.</b> 첫 입력 이후 사람은 아무것도 하지 않습니다.
          </p>

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

          <div
            className={`drop rise ${over ? "over" : ""}`}
            style={{ "--i": 3 } as React.CSSProperties}
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                inputRef.current?.click();
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
              <div className="drop-empty">
                <span className="drop-icon" aria-hidden>
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1-1.6A1 1 0 0 1 9.5 4h5a1 1 0 0 1 .85.4L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <circle cx="12" cy="12.4" r="3.2" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </span>
                <span>
                  <span className="drop-title">사진을 올리거나 여기로 끌어다 놓으세요</span>
                  <span className="drop-hint">JPG · PNG · WEBP · HEIC · 최대 10장 · 모바일 카메라 지원</span>
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
          </div>

          <details className="note-fold rise" style={{ "--i": 4 } as React.CSSProperties}>
            <summary>추가로 알려줄 정보 (선택)</summary>
            <textarea
              value={note}
              maxLength={2000}
              onChange={(event) => onNote(event.target.value)}
              placeholder="브랜드 · 사이즈 · 구성품 · 상태 등. 없어도 등록은 끝까지 진행됩니다."
            />
          </details>

          {error ? <div className="inline-error">{error}</div> : null}

          <div className="land-cta rise" style={{ "--i": 5 } as React.CSSProperties}>
            <button type="button" className="btn btn-xl btn-primary" onClick={onStart} disabled={submitting}>
              {submitting ? <span className="spinner" aria-hidden /> : null}
              등록 시작 <span className="arrow">→</span>
            </button>
            <span className="drop-hint">
              {files.length > 0 ? `사진 ${files.length}장 준비됨` : "사진 없이 눌러도 선택창이 열립니다"}
            </span>
          </div>
        </div>

        <div className="rise" style={{ "--i": 3 } as React.CSSProperties}>
          <LandingVignette />
        </div>
      </div>

      <div className="land-strip">
        <span className="strip-title">에이전트가 혼자 밟는 7단계</span>
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
      </div>
    </main>
  );
}

/* ═════════ 발사 전환 ═════════ */

function LaunchOverlay({
  flight,
  armed,
  failed,
  onDone,
}: {
  flight: Flight;
  armed: boolean;
  failed: boolean;
  onDone: () => void;
}) {
  const cloneRef = useRef<HTMLDivElement | null>(null);
  const [veiled, setVeiled] = useState(false);
  const [out, setOut] = useState(false);
  const armedRef = useRef(armed);
  const failedRef = useRef(failed);
  armedRef.current = armed;
  failedRef.current = failed;

  // 화질 규칙: 클론은 최대(중앙) 크기로 레이아웃하고 transform 으로 축소해서 시작한다.
  const size = Math.min(window.innerHeight * 0.34, window.innerWidth * 0.3, 340);

  useEffect(() => {
    const node = cloneRef.current;
    if (!node) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const centerX = window.innerWidth / 2 - size / 2;
    const centerY = window.innerHeight / 2 - size / 2;
    const startScale = flight.rect.width / size;
    const dx = flight.rect.left - centerX;
    const dy = flight.rect.top - centerY;

    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
    node.style.left = `${centerX}px`;
    node.style.top = `${centerY}px`;
    node.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${startScale})`;

    if (reduced) {
      setVeiled(true);
      window.setTimeout(onDone, 60);
      return;
    }

    setVeiled(true);
    let cancelled = false;
    let frames = 0;

    const rise = node.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${startScale})` },
        { transform: "translate3d(0, 0, 0) scale(1)" },
      ],
      { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
    );

    const land = () => {
      if (cancelled) return;

      if (failedRef.current) {
        // POST 실패 시 제자리 복귀
        node
          .animate(
            [
              { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
              { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${startScale})`, opacity: 0 },
            ],
            { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
          )
          .finished.finally(() => {
            setOut(true);
            window.setTimeout(onDone, 300);
          });
        return;
      }

      const target = document.querySelector<HTMLElement>('.stage [data-launch-target="evidence"]');
      if (!target && frames < 600) {
        frames += 1;
        requestAnimationFrame(land);
        return;
      }
      if (!target) {
        setOut(true);
        window.setTimeout(onDone, 300);
        return;
      }

      const to = target.getBoundingClientRect();
      const scale = Math.min(1, to.width / size);
      const tx = to.left + to.width / 2 - (centerX + size / 2);
      const ty = to.top + to.height / 2 - (centerY + size / 2);

      node
        .animate(
          [
            { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1 },
            { transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`, opacity: 0.9 },
          ],
          { duration: 540, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
        )
        .finished.finally(() => {
          if (cancelled) return;
          setOut(true);
          window.setTimeout(onDone, 300);
        });
    };

    void rise.finished.finally(land);

    return () => {
      cancelled = true;
    };
  }, [flight.rect, onDone, size]);

  return (
    <div className={`launch ${veiled && !out ? "veiled" : ""} ${out ? "out" : ""}`} aria-hidden>
      <div ref={cloneRef} className="launch-clone">
        <img src={flight.url} alt="" />
      </div>
    </div>
  );
}

/* ═════════ 목록 ═════════ */

function statusLabel(status: string): string {
  switch (status) {
    case "registered":
      return "등록";
    case "needs_review":
      return "보고";
    case "failed":
      return "실패";
    case "running":
      return "진행 중";
    default:
      return "대기";
  }
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
    <main className="list">
      <div className="list-head">
        <h1>올린 물건</h1>
        <span className="tnum">{listings.length}건</span>
        <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onNew}>
          새 상품 올리기
        </button>
      </div>

      {listings.length === 0 ? (
        <div className="empty">
          <b>아직 올린 물건이 없습니다</b>
          <span>사진 한 장이면 등록까지 끝납니다.</span>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            물건 올리기 <span className="arrow">→</span>
          </button>
        </div>
      ) : (
        <div className="list-grid">
          {listings.map((listing, index) => {
            const image = listing.materials?.media.mainUrl ?? listing.photoUrls[0] ?? null;
            return (
              <button
                type="button"
                className="list-card"
                key={listing.id}
                style={{ "--i": index } as React.CSSProperties}
                onClick={() => onOpen(listing)}
              >
                <div className="list-thumb">
                  {image ? <img src={image} alt="" /> : <div className="skeleton" style={{ height: "100%" }} />}
                </div>
                <div className="list-meta">
                  <span className={`status-pill ${listing.status}`}>{statusLabel(listing.status)}</span>
                  <span className="list-title">
                    {listing.materials?.registrationTitle ?? listing.draft?.title ?? "등록안 준비 중"}
                  </span>
                  <span className="list-row">
                    {formatPrice(listing.materials?.price.salePrice ?? listing.draft?.salePrice)}
                    <time dateTime={listing.createdAt}>{formatDate(listing.createdAt)}</time>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}

/* ═════════ 드로어 ═════════ */

function ListingDrawer({ listing, onClose }: { listing: ListingRecord; onClose: () => void }) {
  const materials = listing.materials;
  const publication = listing.publication;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} role="presentation" />
      <aside className="drawer" role="dialog" aria-label="등록 상세">
        <div className="drawer-bar">
          <span className={`status-pill ${listing.status}`}>{statusLabel(listing.status)}</span>
          <b>{materials?.registrationTitle ?? listing.draft?.title ?? "등록안"}</b>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {listing.draft?.summary ? (
            <section className="dsec">
              <h3>요약</h3>
              <p className="rs-sub">{listing.draft.summary}</p>
            </section>
          ) : null}

          <section className="dsec">
            <h3>사실</h3>
            <div className="rs-kv">
              <div>
                <b>판매가</b>
                <span>{formatPrice(materials?.price.salePrice ?? listing.draft?.salePrice)}</span>
              </div>
              <div>
                <b>카테고리</b>
                <span>{materials?.category.categoryName ?? "미확정"}</span>
              </div>
              {publication?.originProductNo ? (
                <div>
                  <b>등록번호</b>
                  <span className="mono">
                    {publication.originProductNo} / {publication.channelProductNo ?? "—"}
                  </span>
                </div>
              ) : null}
              <div>
                <b>진행상태</b>
                <span>{listing.stageLabel}</span>
              </div>
              {publication?.productUrl ? (
                <div>
                  <b>링크</b>
                  <span className="wrap-any">
                    <a href={publication.productUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>
                      스마트스토어에서 보기 ↗
                    </a>
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          {listing.blockReasons.length > 0 || (publication?.holdReasons?.length ?? 0) > 0 ? (
            <section className="dsec">
              <h3>판정 · 보류 사유</h3>
              <div className="rs-hold">
                <ul>
                  {[...listing.blockReasons, ...(publication?.holdReasons ?? [])].map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          {materials?.detailPlan ? (
            <section className="dsec">
              <h3>상세 기획</h3>
              <p className="rs-quote" style={{ fontSize: 15 }}>
                “{materials.detailPlan.concept}”
              </p>
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

          {materials ? (
            <section className="dsec">
              <h3>등록 재료</h3>
              <div className="rs-kv">
                <div>
                  <b>원산지</b>
                  <span>{materials.origin.originAreaInfo?.content ?? "—"}</span>
                </div>
                <div>
                  <b>KC</b>
                  <span>{materials.kc.statusLabel}</span>
                </div>
                <div>
                  <b>고시</b>
                  <span>
                    {materials.notice.typeUnconfirmed
                      ? "고시 유형 미확인 — 기타 재화로 등록"
                      : (materials.notice.noticeTypeName ?? materials.notice.noticeType)}
                  </span>
                </div>
                <div>
                  <b>가격 근거</b>
                  <span>{materials.price.priceBasis}</span>
                </div>
              </div>
              <div className="tag-row" style={{ gap: 6, marginTop: 4 }}>
                {materials.tags.tags.map((tag) => (
                  <span key={tag.text} className={`tag-chip ${tag.official ? "" : "unofficial"}`}>
                    {tag.text}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {listing.draft?.facts?.length ? (
            <section className="dsec">
              <h3>판단 근거</h3>
              {listing.draft.facts.map((fact, index) => (
                <div className="dfact" key={index}>
                  <div className="dfact-top">
                    <span className={`fact-kind ${fact.kind}`}>{FACT_KIND_LABEL[fact.kind] ?? fact.kind}</span>
                    <span className="dfact-src tnum">{Math.round(fact.confidence * 100)}%</span>
                  </div>
                  <div className="dfact-claim">{fact.claim}</div>
                  <div className="dfact-src">{fact.source}</div>
                </div>
              ))}
            </section>
          ) : null}

          {listing.warnings.length > 0 ? (
            <section className="dsec">
              <h3>경고</h3>
              {listing.warnings.map((warning, index) => (
                <div className="dfact" key={index}>
                  <div className="dfact-claim">{warning}</div>
                </div>
              ))}
            </section>
          ) : null}

          <section className="dsec">
            <details>
              <summary>Agent stream ({listing.events.length}건)</summary>
              <div className="dlog">
                {listing.events.map((event) => (
                  <div key={event.id}>
                    <b className={event.kind}>{event.kind}</b>
                    <span className="wrap-any">{event.label}</span>
                  </div>
                ))}
              </div>
            </details>
          </section>
        </div>
      </aside>
    </>
  );
}
