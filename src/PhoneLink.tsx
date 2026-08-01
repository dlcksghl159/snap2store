import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveFrame, PhoneLinkApi } from "./link-client";
import { sfxPowerOff, sfxPowerOn, sfxShutter } from "./sfx";

/**
 * 폰 링크 연출 계층.
 *  - PhoneLinkModal : QR 대기 카드 (라이트 글래스)
 *  - PhoneStudio    : 풀스크린 스튜디오 모니터 — 전원 온 → 라이브 뷰파인더 → 셔터 FLIP → 전원 오프
 *
 * 로직은 전부 usePhoneLink 훅에 있다. 여기는 훅의 상태 변화를 화면 언어(빛·움직임·소리)로
 * 번역하는 일만 한다.
 */

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/* ═════════ QR 대기 모달 ═════════ */

export function PhoneLinkModal({ link, onCancel }: { link: PhoneLinkApi; onCancel: () => void }) {
  const creating = link.phase === "creating";
  const [stuck, setStuck] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const tunnelOn = Boolean(link.session?.tunnel);

  /* 18초 넘게 못 붙으면 스스로 구조 신호를 켠다 — 죽은 대기 화면이 가장 나쁜 UX 다. */
  useEffect(() => {
    if (link.phase !== "waiting") return;
    const timer = window.setTimeout(() => setStuck(true), 18_000);
    return () => window.clearTimeout(timer);
  }, [link.phase]);

  const refresh = () => {
    setRefreshing(true);
    void link.refreshUrls().finally(() => setRefreshing(false));
  };

  const openTunnel = () => {
    setTunnelBusy(true);
    setTunnelError(null);
    void link
      .startTunnel()
      .then((problem) => setTunnelError(problem))
      .finally(() => setTunnelBusy(false));
  };

  return (
    <div className="qr-veil" role="dialog" aria-modal="true" aria-label="핸드폰 연결">
      <div className="qr-card qr-min">
        <button type="button" className="qr-x" onClick={onCancel} aria-label="닫기">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        <h2>핸드폰 연결</h2>

        <div className={`qr-tile qr-hero ${link.qrDataUrl ? "" : "loading"}`}>
          {link.qrDataUrl ? (
            <img src={link.qrDataUrl} alt="연결 QR" />
          ) : (
            <span className="spinner spinner-ink" aria-hidden />
          )}
          {link.qrDataUrl && link.phase === "waiting" ? <i className="qr-scan" aria-hidden /> : null}
        </div>

        <div className="qr-under">
          <span className="qr-wait">
            <i aria-hidden />
            {creating ? "여는 중" : "폰 대기 중"}
          </span>
          <b className="mono qr-code-mini">{link.session?.code ?? ""}</b>
          {tunnelOn ? (
            <span className="qr-net">
              <i aria-hidden />
              어디서나 접속
            </span>
          ) : null}
        </div>

        {stuck && link.phase === "waiting" ? (
          <div className="qr-sos">
            <b>아직 연결이 안 되나요?</b>
            {!tunnelOn ? (
              <button
                type="button"
                className="btn btn-ghost qr-tunnel-btn"
                onClick={openTunnel}
                disabled={tunnelBusy}
              >
                {tunnelBusy ? <span className="spinner" aria-hidden /> : null}
                {tunnelBusy ? "터널 여는 중…" : "인터넷 터널 켜기 — 어떤 네트워크든 연결"}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={refresh} disabled={refreshing}>
              {refreshing ? <span className="spinner" aria-hidden /> : null}
              주소 새로고침
            </button>
            {link.session?.manualHost ? (
              <span className="qr-sos-line">
                수동 입장 — 폰 브라우저에 <b className="mono">{link.session.manualHost}</b> · 코드{" "}
                <b className="mono">{link.session.code}</b>
              </span>
            ) : null}
            <span className="qr-sos-line">“비공개 연결” 경고는 세부사항 → 계속.</span>
          </div>
        ) : null}

        {tunnelError ? <div className="inline-error">{tunnelError}</div> : null}
      </div>
    </div>
  );
}

/* ═════════ 스튜디오 모니터 ═════════ */

export interface PhoneStudioProps {
  link: PhoneLinkApi;
  trayCount: number;
  trayMax: number;
  /** 전원 오프 연출이 끝난 뒤 호출 — App 이 link.reset() 으로 상태를 걷는다. */
  onClosed: () => void;
}

export function PhoneStudio({ link, trayCount, trayMax, onClosed }: PhoneStudioProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const flashRef = useRef<HTMLDivElement | null>(null);
  const slotElsRef = useRef(new Map<number, HTMLElement>());

  const [hasSignal, setHasSignal] = useState(false);
  /** 수신 프레임의 원본 치수 — 스크린 박스를 이 비율로 감싼다 (레터박스 없는 WYSIWYG). */
  const [frameDims, setFrameDims] = useState<{ w: number; h: number } | null>(null);
  const [screenBox, setScreenBox] = useState<{ w: number; h: number } | null>(null);
  const [landed, setLanded] = useState<ReadonlySet<number>>(
    () => new Set(link.captures.map((shot) => shot.id)),
  );
  const [finalCaption, setFinalCaption] = useState("");
  const flashedIdsRef = useRef<Set<number>>(new Set(link.captures.map((shot) => shot.id)));
  const animatedIdsRef = useRef<Set<number>>(new Set(link.captures.map((shot) => shot.id)));

  const ending = link.phase === "ending";
  const full = trayCount >= trayMax;

  /* 전원 온·오프 사운드 */
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = window.setTimeout(sfxPowerOn, 240);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ending) return;
    if (!reducedMotion()) sfxPowerOff();
    const timer = window.setTimeout(onClosed, reducedMotion() ? 240 : 780);
    return () => window.clearTimeout(timer);
  }, [ending, onClosed]);

  /* Escape = 마치고 등록 — 폰의 종료 버튼과 같은 동작이다 (두 갈래로 갈리면 더 놀란다). */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") link.end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [link.end]);

  /* 라이브 프레임 → 캔버스 (JPEG ImageBitmap · 코덱 VideoFrame 공용) */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    link.setFrameSink((frame: LiveFrame) => {
      const isVideoFrame = "displayWidth" in frame;
      const width = isVideoFrame ? frame.displayWidth : frame.width;
      const height = isVideoFrame ? frame.displayHeight : frame.height;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        setFrameDims({ w: width, h: height });
      }
      context?.drawImage(frame, 0, 0, width, height);
      frame.close();
      setHasSignal(true);
    });
    return () => link.setFrameSink(null);
  }, [link.setFrameSink]);

  /* 셔터 프리즈 소스 — 코덱 경로에는 JPEG 정지컷이 없어서 캔버스에서 뜬다 */
  useEffect(() => {
    link.setFreezeSource(
      () =>
        new Promise<Blob | null>((resolve) => {
          const canvas = canvasRef.current;
          if (!canvas || canvas.width === 0) {
            resolve(null);
            return;
          }
          canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
        }),
    );
    return () => link.setFreezeSource(null);
  }, [link.setFreezeSource]);

  /* 스크린 박스를 프레임 비율에 딱 맞게 감싼다 — 폰에서 보는 그대로의 창이 된다 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const compute = () => {
      if (!frameDims) {
        setScreenBox(null);
        return;
      }
      const rect = stage.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const scale = Math.min(rect.width / frameDims.w, rect.height / frameDims.h);
      setScreenBox({
        w: Math.max(2, Math.floor(frameDims.w * scale)),
        h: Math.max(2, Math.floor(frameDims.h * scale)),
      });
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [frameDims]);

  /* 셔터 연출 — 플래시는 셔터 신호 즉시, FLIP 은 프리즈 컷(url)이 생기는 순간 */
  useEffect(() => {
    for (const shot of link.captures) {
      if (!flashedIdsRef.current.has(shot.id)) {
        flashedIdsRef.current.add(shot.id);
        sfxShutter();
        const flash = flashRef.current;
        if (flash) {
          flash.classList.remove("go");
          void flash.offsetWidth;
          flash.classList.add("go");
        }
      }
      if (animatedIdsRef.current.has(shot.id)) continue;
      // 프리즈 컷이 아직 없으면 기다린다 — 원본이 먼저 와서 ready 가 되면 바로 착지시킨다.
      if (!shot.url && !shot.ready) continue;
      animatedIdsRef.current.add(shot.id);

      const screen = screenRef.current;
      const slot = slotElsRef.current.get(shot.id);
      const root = rootRef.current;
      if (reducedMotion() || !screen || !slot || !root || !shot.url) {
        setLanded((current) => new Set(current).add(shot.id));
        continue;
      }

      // FLIP — 스크린 프리즈 프레임이 필름 슬롯으로 날아가 앉는다.
      const from = screen.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      const ghost = document.createElement("img");
      ghost.src = shot.url;
      ghost.className = "studio-ghost";
      ghost.style.left = `${from.left}px`;
      ghost.style.top = `${from.top}px`;
      ghost.style.width = `${from.width}px`;
      ghost.style.height = `${from.height}px`;
      root.appendChild(ghost);

      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      // 균일 스케일 — 비율이 다른 슬롯에 맞춰 찌그러뜨리지 않는다. 마지막 정착은
      // 슬롯 자신의 settle 애니메이션이 맡고, 고스트는 겹친 채 사라진다.
      const scale = Math.max(to.width / from.width, to.height / from.height);

      const animation = ghost.animate(
        [
          { transform: "none", opacity: 1, borderRadius: "18px", offset: 0 },
          { transform: "scale(0.965)", opacity: 1, borderRadius: "20px", offset: 0.24 },
          {
            transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
            opacity: 0.2,
            borderRadius: "70px",
            offset: 1,
          },
        ],
        { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
      );
      animation.finished
        .catch(() => undefined)
        .finally(() => {
          ghost.remove();
          setLanded((current) => new Set(current).add(shot.id));
        });
    }
  }, [link.captures]);

  const registerSlot = useCallback((id: number, node: HTMLElement | null) => {
    if (node) slotElsRef.current.set(id, node);
    else slotElsRef.current.delete(id);
  }, []);

  /* 확정 자막은 잠시 보여주고 걷는다 */
  useEffect(() => {
    if (!link.voice.lastFinal) return;
    setFinalCaption(link.voice.lastFinal);
    const timer = window.setTimeout(() => setFinalCaption(""), 3200);
    return () => window.clearTimeout(timer);
  }, [link.voice.lastFinal]);

  const caption = link.voice.interim || finalCaption;
  const captionInterim = Boolean(link.voice.interim);
  const showNextGhost = !full && link.phase === "live";

  return (
    <div ref={rootRef} className={`studio ${ending ? "off" : ""}`} role="region" aria-label="핸드폰 촬영 스튜디오">
      <div className="studio-veil" />

      <div className="monitor">
        <div className="mon-chrome">
          <span className="mon-live">
            <i aria-hidden />
            LIVE
          </span>
          <span className="mon-chip mono">{link.session?.code ?? ""}</span>
          <div className="mon-chips">
            <span className={`mon-chip mon-mic ${micTone(link)}`}>
              <span className="mic-bars" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              {micLabel(link)}
            </span>
            <span className="mon-chip mono">{link.fps > 0 ? `${link.fps}fps` : "—"}</span>
            <span className="mon-chip mono tnum">
              {trayCount}/{trayMax}
            </span>
            {/* 마치는 순간 등록까지 간다 — 버튼이 그 사실을 말해야 한다. */}
            <button type="button" className="mon-end" onClick={link.end}>
              마치고 등록
            </button>
          </div>
        </div>

        <div className="mon-body">
          <div ref={stageRef} className="mon-stage">
            <div
              ref={screenRef}
              className="mon-screen"
              style={screenBox ? { width: screenBox.w, height: screenBox.h } : undefined}
            >
            <canvas ref={canvasRef} className="mon-canvas" />
            <div className="mon-ignition" aria-hidden />
            <span className="mon-corners" aria-hidden />

            {!hasSignal || !link.phoneConnected ? (
              <div className="mon-wait">
                <span className="spinner" aria-hidden />
                {link.phoneConnected ? "신호 수신 중" : "폰 대기 중"}
              </div>
            ) : null}

            {caption ? (
              <div className={`mon-caption ${captionInterim ? "interim" : ""}`}>
                <span>{caption}</span>
              </div>
            ) : null}

            {hasSignal && link.captures.length === 0 && link.phoneConnected ? (
              <div className="mon-hint">폰에서 셔터를 누르세요</div>
            ) : null}

            <div ref={flashRef} className="mon-flash" aria-hidden />
            </div>
          </div>

          <aside className="mon-film" aria-label="찍은 사진">
            <span className="film-label">SHOTS</span>
            <div className="film-rail">
              {link.captures.map((shot, index) => (
                <div
                  key={shot.id}
                  ref={(node) => registerSlot(shot.id, node)}
                  className={`film-slot ${landed.has(shot.id) ? "filled" : "waiting"}`}
                >
                  {landed.has(shot.id) && shot.url ? (
                    <img src={shot.url} alt={`촬영 ${index + 1}`} />
                  ) : (
                    <b className="mono">{index + 1}</b>
                  )}
                  {landed.has(shot.id) && !shot.ready ? <i className="film-pending" aria-hidden /> : null}
                </div>
              ))}
              {showNextGhost ? (
                <div className="film-slot next" aria-hidden>
                  <b className="mono">{link.captures.length + 1}</b>
                </div>
              ) : null}
              {full ? <span className="film-full">가득 참</span> : null}
            </div>
          </aside>
        </div>

        <div className="mon-foot">
          <span className={`mon-note ${link.voice.note ? "has" : ""}`} key={link.voice.note || "빈메모"}>
            <b>메모</b>
            <span>{link.voice.note ? link.voice.note : link.phoneConnected ? "말하면 적힙니다" : "연결 끊김"}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function micTone(link: PhoneLinkApi): string {
  if (link.voice.status === "unavailable") return "off";
  if (link.voice.speaking) return "on";
  return link.voice.status === "ready" ? "idle" : "off";
}

function micLabel(link: PhoneLinkApi): string {
  if (link.voice.status === "unavailable") return "음성 꺼짐";
  if (link.voice.speaking) return "받아 적는 중";
  return link.voice.status === "ready" ? "듣는 중" : "음성 준비 중";
}
