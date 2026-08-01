import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Detection, ObjectDetector } from "@mediapipe/tasks-vision";

/**
 * 폰 아이 — 맥북 내장 카메라가 랜딩을 지켜보다가, 사용자가 핸드폰을 들어 보이면
 * 스스로 폰 링크를 연다. 버튼을 누르는 한 동작을 "보여주기"로 바꾼다.
 *
 * 설계 원칙
 * 1. **버튼을 대체하지 않는다.** 눈은 덤이다 — 카메라가 없든, 권한이 거부되든,
 *    모델이 안 뜨든 랜딩의 "핸드폰으로 찍기" 버튼은 그대로 살아 있어야 한다.
 *    시연에서 마법이 실패했을 때 돌아갈 자리가 없는 게 제일 나쁘다.
 * 2. **들어 보인 것만 센다.** 책상에 놓인 폰은 늘 시야 안에 있다. 점수만 보면
 *    페이지를 열자마자 QR 이 튀어나온다. 그래서 면적과 지속을 함께 본다 —
 *    가까이(크게), 일정 시간(0.6초) 버텨야 의도로 인정한다.
 * 3. **한 번 울리면 눈을 감고, 폰을 내려야 다시 뜬다.** QR 이 뜬 뒤에도 카메라가
 *    돌 이유가 없고, 모달을 닫자마자 같은 폰이 다시 QR 을 여는 루프도 없어야 한다.
 * 4. **모든 자산은 로컬이다.** wasm·모델 모두 public/vision 아래 — 시연장 네트워크에
 *    추론을 걸지 않는다 (main.tsx 가 폰트를 로컬로 받는 것과 같은 이유).
 * 5. **뜨거운 값은 리액트 상태로 올리지 않는다.** charge·sightings 는 초당 11번
 *    갱신된다. App 을 그 속도로 다시 그리면 랜딩이 무거워지므로, 구독으로 내보내고
 *    실제로 보고 있는 작은 컴포넌트만 다시 그린다 (useEyeLive).
 */

/** EfficientDet-Lite 는 COCO 90 클래스를 뱉는다. 그중 "폰답다"고 볼 이름들. */
const PHONE_CLASSES: ReadonlySet<string> = new Set([
  "cell phone",
  // 정면에서 가까이 든 폰은 remote 로도 자주 찍힌다 — COCO 에서 둘 다 "손에 쥔 검은
  // 직사각형"이라 경계가 흐리다. 랜딩 앞에서 리모컨을 들어 보일 일은 없으니 받는다.
  "remote",
]);

export const EYE_TUNING = {
  /** 이 점수 아래는 없는 셈 친다. 근접한 폰은 원래 확신이 낮게 나와 넉넉히 잡는다. */
  minScore: 0.34,
  /** 프레임 대비 최소 면적. 책상에 놓인 폰(작다)과 들어 보인 폰(크다)을 가르는 선. */
  minArea: 0.03,
  /**
   * 이만큼 계속 보이면 확신이 찬다 — 폰을 들어 보인 뒤 QR 이 열리기까지의 시간이다.
   *
   * ⚠ 이 값은 감지 민감도이자 **연출 길이**다. 0.6초였을 때는 원이 커지는 것도,
   * 확신 링이 차는 것도 볼 새 없이 QR 이 떠 버렸다. 1초면 "알아봤구나"를 확인하고
   * 넘어가기에 충분하고, 그 이상은 들고 서 있는 사람에게 지루하다.
   */
  holdMs: 1000,
  /** 사라져도 이만큼에 걸쳐 식는다 — 손떨림 한 프레임에 0 으로 떨어지지 않게. */
  releaseMs: 900,
  /** 추론 주기. 60fps 를 다 쓸 이유가 없고, 팬이 도는 순간 시연이 초라해진다. */
  strideMs: 90,
};

export type EyeTuning = typeof EYE_TUNING;

export type EyeStatus =
  /** 꺼져 있음 — enabled=false 이거나 이미 임무를 마쳤다. */
  | "off"
  /** 카메라·모델을 여는 중. */
  | "opening"
  /** 지켜보는 중. */
  | "watching"
  /** 사용자가 카메라를 거부했다 — 이 세션에서 다시 묻지 않는다. */
  | "denied"
  /** 카메라가 없거나 모델이 안 떴다. */
  | "unavailable";

export interface EyeSighting {
  label: string;
  score: number;
  /** 프레임 대비 면적 0..1 */
  area: number;
  /** 0..1 로 정규화된 박스 — 디버그 오버레이가 그대로 % 로 쓴다. */
  box: { x: number; y: number; w: number; h: number };
  /** 폰으로 인정된 후보인지 (클래스·점수·면적을 모두 통과) */
  counts: boolean;
}

/** 매 추론마다 갱신되는 뜨거운 값. */
export interface EyeLive {
  /** 0..1 — 확신이 차오르는 정도. 1 에 닿는 순간 onSpot 이 울린다. */
  charge: number;
  sightings: EyeSighting[];
  /** 발화 뒤 폰을 내리기 전이라 잠겨 있는 상태. */
  rearming: boolean;
}

export interface PhoneEyeApi {
  status: EyeStatus;
  /** 디버그 화면이 그대로 <video> 에 물릴 수 있게 노출한다. */
  stream: MediaStream | null;
  /** 사람이 볼 수 있는 실패 사유. 정상이면 null. */
  error: string | null;
  subscribe: (listener: () => void) => () => void;
  read: () => EyeLive;
}

export interface PhoneEyeOptions {
  enabled: boolean;
  /** 폰을 들어 보였다고 확신했을 때 한 번 호출된다. */
  onSpot: () => void;
  /** 디버그 화면이 실시간으로 기준을 흔들어 볼 수 있게 한다. */
  tuning?: Partial<EyeTuning>;
  /** 무거운 모델로 바꿔 재현율을 확인할 때. */
  model?: "lite0" | "lite2";
}

const MODEL_PATH = {
  lite0: "/vision/models/efficientdet_lite0.tflite",
  lite2: "/vision/models/efficientdet_lite2.tflite",
} as const;

const IDLE_LIVE: EyeLive = { charge: 0, sightings: [], rearming: false };

export function usePhoneEye(options: PhoneEyeOptions): PhoneEyeApi {
  const { enabled, model = "lite0" } = options;

  const [status, setStatus] = useState<EyeStatus>("off");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSpotRef = useRef(options.onSpot);
  onSpotRef.current = options.onSpot;
  const tuningRef = useRef(options.tuning);
  tuningRef.current = options.tuning;

  /* 뜨거운 값 — 스냅샷 객체의 정체성이 바뀔 때만 구독자가 다시 그린다. */
  const liveRef = useRef<EyeLive>(IDLE_LIVE);
  const listenersRef = useRef(new Set<() => void>());
  const publish = useCallback((next: EyeLive) => {
    liveRef.current = next;
    for (const listener of listenersRef.current) listener();
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  const read = useCallback(() => liveRef.current, []);

  /** 거부는 세션 내내 기억한다 — 매번 다시 묻는 페이지만큼 미운 게 없다. */
  const deniedRef = useRef(false);
  /** 한 번이라도 울린 적이 있으면, 다음부터는 폰을 내렸다 들어야 인정한다. */
  const firedOnceRef = useRef(false);

  useEffect(() => {
    if (!enabled || deniedRef.current) {
      setStatus(deniedRef.current ? "denied" : "off");
      return;
    }

    let alive = true;
    let detector: ObjectDetector | null = null;
    let media: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let rafId = 0;

    /** 추론 타임스탬프는 단조 증가여야 하고, 같은 프레임을 두 번 넣으면 안 된다. */
    let lastFrameTime = -1;
    let lastInferAt = 0;
    let lastTickAt = 0;
    let charge = 0;
    let sightings: EyeSighting[] = [];
    let hit = false;
    /**
     * 재무장 — 직전 실행에서 이미 울린 적이 있으면, 빈 시야를 한 번 봐야 잠금이 풀린다.
     * 이게 없으면 QR 을 닫는 순간 손에 든 그 폰이 QR 을 다시 연다.
     */
    let armed = !firedOnceRef.current;
    let fired = false;

    const stop = () => {
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      media?.getTracks().forEach((track) => track.stop());
      if (video) {
        video.srcObject = null;
        video.remove();
        video = null;
      }
      detector?.close();
      detector = null;
    };

    const open = async () => {
      setStatus("opening");
      setError(null);

      // 번들·wasm 은 눈을 켤 때 처음 받는다. 랜딩 첫 페인트가 이걸 기다릴 이유가 없다.
      const vision = await import("@mediapipe/tasks-vision");
      if (!alive) return;

      const fileset = await vision.FilesetResolver.forVisionTasks("/vision/wasm");
      if (!alive) return;

      const build = (delegate: "GPU" | "CPU") =>
        vision.ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH[model], delegate },
          runningMode: "VIDEO",
          // 문턱은 여기서 낮게 열어 두고, 판정은 우리 규칙(클래스·점수·면적·지속)이 한다.
          scoreThreshold: 0.2,
          maxResults: 8,
        });

      detector = await build("GPU").catch(() => build("CPU"));
      if (!alive) return stop();

      media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      if (!alive) return stop();

      // 눈은 자기 <video> 를 소유한다 — 화면에 보이든 안 보이든 디코딩은 계속돼야 한다.
      // display:none 이 아니라 1px 투명으로 숨기는 이유다.
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("aria-hidden", "true");
      video.style.cssText =
        "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      video.srcObject = media;
      document.body.appendChild(video);
      await video.play();
      if (!alive) return stop();

      setStream(media);
      setStatus("watching");
      lastTickAt = performance.now();
      rafId = requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!alive) return;
      rafId = requestAnimationFrame(tick);

      const now = performance.now();
      const tuning: EyeTuning = { ...EYE_TUNING, ...tuningRef.current };
      if (now - lastInferAt < tuning.strideMs) return;
      lastInferAt = now;

      // dt 는 rAF 간격이 아니라 **직전에 실제로 처리한 틱**과의 간격이다. rAF 기준으로 재면
      // 추론을 건너뛴 프레임의 시간이 통째로 증발해 holdMs 가 몇 배로 늘어난다.
      const dt = Math.min(now - lastTickAt, 250);
      lastTickAt = now;

      if (video && detector && video.videoWidth > 0 && video.currentTime !== lastFrameTime) {
        lastFrameTime = video.currentTime;
        sightings = detector
          .detectForVideo(video, now)
          .detections.map((detection) =>
            readSighting(detection, video!.videoWidth, video!.videoHeight, tuning),
          )
          .filter((sighting): sighting is EyeSighting => sighting !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        hit = sightings.some((sighting) => sighting.counts);
        // 빈 시야를 한 번 보면 잠금이 풀린다 — "폰을 내렸다"의 정의다.
        if (!hit) armed = true;
      }

      charge = advanceCharge(charge, hit, dt, tuning);
      publish({ charge: armed ? charge : 0, sightings, rearming: !armed });

      if (armed && charge >= 1 && !fired) {
        fired = true;
        firedOnceRef.current = true;
        stop();
        setStatus("off");
        setStream(null);
        publish(IDLE_LIVE);
        onSpotRef.current();
      }
    };

    open().catch((cause: unknown) => {
      if (!alive) return;
      stop();
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        deniedRef.current = true;
        setStatus("denied");
        setError("카메라 권한이 없어 자동 감지를 끕니다 — 버튼으로 연결하세요.");
        return;
      }
      setStatus("unavailable");
      setError(
        name === "NotFoundError"
          ? "카메라를 찾지 못했습니다 — 버튼으로 연결하세요."
          : `자동 감지를 열지 못했습니다: ${describe(cause)}`,
      );
    });

    return () => {
      stop();
      setStream(null);
      publish(IDLE_LIVE);
    };
  }, [enabled, model, publish]);

  return { status, stream, error, subscribe, read };
}

/** 뜨거운 값을 실제로 보고 있는 컴포넌트만 이걸 부른다 — 거기서만 다시 그려진다. */
export function useEyeLive(eye: PhoneEyeApi): EyeLive {
  return useSyncExternalStore(eye.subscribe, eye.read, () => IDLE_LIVE);
}

/**
 * 확신 적분 — 프레임 수가 아니라 **시간**으로 찬다. 기기가 느려도 "0.6초 들고 있으면 열린다"는
 * 체감이 같아야 하고, 추론 주기를 바꿔도 문턱이 따라 움직이면 안 된다.
 *
 * dt 는 rAF 간격이 아니라 직전에 실제로 처리한 틱과의 간격이어야 한다 — 이 구분을 놓치면
 * 건너뛴 프레임의 시간이 증발해 holdMs 가 조용히 몇 배로 늘어난다.
 */
export function advanceCharge(
  charge: number,
  hit: boolean,
  dt: number,
  tuning: EyeTuning,
): number {
  return hit
    ? Math.min(1, charge + dt / tuning.holdMs)
    : Math.max(0, charge - dt / tuning.releaseMs);
}

/** 판정 게이트 — 클래스·점수·면적을 모두 통과해야 "들어 보인 폰"으로 센다. */
export function countsAsPhone(
  candidate: { label: string; score: number; area: number },
  tuning: EyeTuning,
): boolean {
  return (
    PHONE_CLASSES.has(candidate.label) &&
    candidate.score >= tuning.minScore &&
    candidate.area >= tuning.minArea
  );
}

function readSighting(
  detection: Detection,
  frameWidth: number,
  frameHeight: number,
  tuning: EyeTuning,
): EyeSighting | null {
  const top = detection.categories[0];
  const box = detection.boundingBox;
  if (!top || !box || frameWidth <= 0 || frameHeight <= 0) return null;

  const w = box.width / frameWidth;
  const h = box.height / frameHeight;
  const label = top.categoryName;
  const area = w * h;
  return {
    label,
    score: top.score,
    area,
    box: { x: box.originX / frameWidth, y: box.originY / frameHeight, w, h },
    counts: countsAsPhone({ label, score: top.score, area }, tuning),
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 디버그 화면이 같은 판정 규칙을 쓰도록 내보낸다. */
export function isPhoneClass(label: string): boolean {
  return PHONE_CLASSES.has(label);
}

/** 카메라를 쓸 수 있는 환경인지 — 아니면 눈을 아예 켜지 않는다. */
export function eyeSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator?.mediaDevices?.getUserMedia === "function"
  );
}
