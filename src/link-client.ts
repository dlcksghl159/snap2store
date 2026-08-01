import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

/**
 * 폰 링크 데스크톱 클라이언트 — 세션 생성 → QR 대기 → 라이브 → 종료의 상태 기계.
 *
 * 화면(스튜디오)과 로직을 분리한다: 이 훅은 WS·프레임·사진·음성만 다루고,
 * 연출(전원 온·플래시·FLIP)은 PhoneLink.tsx 가 이 훅의 상태 변화를 보고 만든다.
 *
 * 사진 신뢰성 계약: 셔터 JSON(즉시) → 원본 JPEG(수 초 안). 원본이 8초 안에 안 오면
 * 마지막 라이브 프레임으로 대체해 트레이에 넣는다 — 시연 중 "찍었는데 없다"는 최악이다.
 */

/** parked = 촬영은 끝났지만 페어링(WS·세션·메모 맥락)은 살아 있는 상태 — 폰의 "다시 촬영"이 여기로 복귀한다. */
export type LinkPhase = "idle" | "creating" | "waiting" | "live" | "ending" | "parked";

export interface LinkSessionInfo {
  code: string;
  phoneUrl: string | null;
  phoneUrls: string[];
  /** 인터넷 터널 공개 주소 — 켜져 있으면 QR 이 이쪽을 가리킨다. */
  tunnel?: string | null;
  /** QR 이 막혔을 때 폰에 직접 쳐 넣는 짧은 주소 (스킴 없음). */
  manualHost?: string | null;
}

export interface CaptureShot {
  id: number;
  /** 표시용 URL — 처음엔 프리즈 프레임, 원본 도착 시 교체. null 이면 아직 프레임조차 없다. */
  url: string | null;
  ready: boolean;
}

export interface VoiceState {
  status: "idle" | "ready" | "unavailable";
  speaking: boolean;
  interim: string;
  lastFinal: string;
  /** 서기가 정리한 메모 전문 — 그대로 메모 칸의 내용이 된다. */
  note: string;
}

export interface PhoneLinkOptions {
  onPhotoFile: (file: File) => void;
  /** 서기가 갱신한 메모 전문. 이어붙이기가 아니라 교체다. */
  onNote: (text: string) => void;
  /**
   * 촬영이 **의도적으로** 끝났다 (폰의 종료 버튼 · 데스크톱의 촬영 마치기).
   * 연결 사고로 라이브가 끊긴 경우에는 울리지 않는다 — 사고를 지시로 읽으면 안 된다.
   * 세션당 한 번만 울린다.
   */
  onFinish?: () => void;
}

/** 넘겨받은 뒤 데스크톱이 폰 화면으로 되돌려 주는 진행 상태. */
export type HandoffState = "reading" | "registering" | "failed" | "done";

/** 스튜디오 캔버스에 그릴 수 있는 프레임 — JPEG 경로는 ImageBitmap, 비디오 경로는 VideoFrame. */
export type LiveFrame = ImageBitmap | VideoFrame;

export interface PhoneLinkApi {
  phase: LinkPhase;
  session: LinkSessionInfo | null;
  qrDataUrl: string | null;
  phoneConnected: boolean;
  voice: VoiceState;
  captures: CaptureShot[];
  /** 아직 트레이에 안 들어온 셔터 수 — 마감 처리가 이게 0 이 되기를 기다린다. */
  pendingShots: number;
  fps: number;
  error: string | null;
  start: () => void;
  end: () => void;
  cancel: () => void;
  reset: () => void;
  /** 소등 뒤 페어링을 유지한 채 대기한다 — 폰의 "다시 촬영"이 여기서 복귀한다. */
  park: () => void;
  /**
   * 파킹된 폰에게 촬영 재개를 요청한다 — QR 재스캔 없이 같은 세션으로 돌아온다.
   * 두 번째 상품을 올릴 때 다시 폰을 들어 보이면 이게 불린다.
   */
  resume: () => void;
  sendTray: (count: number, max: number) => void;
  /**
   * 마감·등록 진행을 폰 화면으로 되돌려 준다 — 폰에서 보면 아무 일도 없어 보이므로.
   * 등록이 끝나면 상품 주소까지 함께 보낸다: 데스크톱의 자동 새 탭은 팝업 차단에
   * 막힐 수 있지만, 그 순간 폰은 이미 사람 손에 들려 있다.
   */
  sendHandoff: (state: HandoffState, url?: string) => void;
  /** 세션 시작 시 메모 칸의 현재 내용을 서기에게 넘긴다 — 거기서 이어 쓴다. */
  sendNoteSeed: (text: string) => void;
  /** 핫스팟 전환 등으로 맥 IP 가 바뀌었을 때 같은 코드로 QR·주소를 다시 뽑는다. */
  refreshUrls: () => Promise<void>;
  /** 인터넷 터널을 켠다 — 성공하면 null, 실패하면 사용자에게 보여줄 사유를 돌려준다. */
  startTunnel: () => Promise<string | null>;
  setFrameSink: (sink: ((frame: LiveFrame, seq: number) => void) | null) => void;
  /**
   * 비디오 코덱 경로에는 JPEG 프리즈 프레임이 없다 — 스튜디오가 자기 캔버스에서
   * 정지 컷을 뜨는 함수를 등록해, 셔터 연출·원본 유실 폴백이 계속 동작하게 한다.
   */
  setFreezeSource: (source: (() => Promise<Blob | null>) | null) => void;
}

const FRAME_LIVE = 0x01;
const FRAME_PHOTO = 0x02;
const FRAME_VIDEO = 0x04;
const FRAME_HEADER_BYTES = 5;
const PHOTO_FALLBACK_MS = 8_000;
const IDLE_VOICE: VoiceState = {
  status: "idle",
  speaking: false,
  interim: "",
  lastFinal: "",
  note: "",
};

export function usePhoneLink(options: PhoneLinkOptions): PhoneLinkApi {
  const [phase, setPhase] = useState<LinkPhase>("idle");
  const [session, setSession] = useState<LinkSessionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [voice, setVoice] = useState<VoiceState>(IDLE_VOICE);
  const [captures, setCaptures] = useState<CaptureShot[]>([]);
  /* 셔터는 눌렸는데 아직 트레이에 안 들어온 사진 수. captures 와 따로 센다 —
     captures 는 소등(park)에서 걷히지만, 배달 중인 사진은 그때도 계속 오는 중이다. */
  const [pendingShots, setPendingShots] = useState(0);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const wsRef = useRef<WebSocket | null>(null);
  const phaseRef = useRef<LinkPhase>("idle");
  phaseRef.current = phase;
  const sessionRef = useRef<LinkSessionInfo | null>(null);
  sessionRef.current = session;
  const wsFailsRef = useRef(0);
  const recreateRef = useRef<() => void>(() => undefined);

  const frameSinkRef = useRef<((frame: LiveFrame, seq: number) => void) | null>(null);
  const freezeSourceRef = useRef<(() => Promise<Blob | null>) | null>(null);
  const lastLiveRef = useRef<Uint8Array | null>(null);
  const lastPaintedSeqRef = useRef(0);
  const decodeBusyRef = useRef(false);
  const fpsCountRef = useRef(0);
  const videoDecoderRef = useRef<VideoDecoder | null>(null);
  const needKeyRef = useRef(true);
  const frozenBlobsRef = useRef(new Map<number, Blob>());
  const fallbackTimersRef = useRef(new Map<number, number>());
  const capturesRef = useRef<CaptureShot[]>([]);
  capturesRef.current = captures;

  /** 마감은 세션당 한 번이다 — 종료 메시지는 서버가 양쪽에 되쏘므로 에코로도 들어온다. */
  const finishedRef = useRef(false);
  const fireFinish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    optionsRef.current.onFinish?.();
  }, []);

  /* ── 정리 ── */
  const clearTimers = useCallback(() => {
    for (const timer of fallbackTimersRef.current.values()) window.clearTimeout(timer);
    fallbackTimersRef.current.clear();
    frozenBlobsRef.current.clear();
  }, []);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, "desktop leave");
      } catch {
        /* noop */
      }
    }
  }, []);

  const closeDecoder = useCallback(() => {
    const decoder = videoDecoderRef.current;
    videoDecoderRef.current = null;
    needKeyRef.current = true;
    if (decoder && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        /* noop */
      }
    }
  }, []);

  useEffect(
    () => () => {
      closeSocket();
      closeDecoder();
      for (const shot of capturesRef.current) if (shot.url) URL.revokeObjectURL(shot.url);
      for (const timer of fallbackTimersRef.current.values()) window.clearTimeout(timer);
    },
    [closeDecoder, closeSocket],
  );

  /* ── fps 집계 ── */
  useEffect(() => {
    if (phase !== "live") {
      setFps(0);
      return;
    }
    const timer = window.setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  /* ── 사진 수명주기 ── */
  /**
   * 트레이에 들어간 셔터 id. 한 셔터는 한 장이다 — 폴백(프리즈 컷)이 먼저 들어간 뒤
   * 원본이 늦게 도착해도, 소등이 대기 중인 컷을 밀어 넣은 뒤에도 두 장이 되지 않는다.
   */
  const deliveredRef = useRef(new Set<number>());
  const deliverFile = useCallback((id: number, blob: Blob) => {
    if (deliveredRef.current.has(id)) return;
    deliveredRef.current.add(id);
    setPendingShots((count) => Math.max(0, count - 1));
    const file = new File([blob], `phone-shot-${id}.jpg`, { type: "image/jpeg" });
    optionsRef.current.onPhotoFile(file);
  }, []);

  const beginCapture = useCallback(
    (id: number) => {
      // 셔터가 눌린 순간부터 이 셔터는 "아직 트레이에 없는 사진"이다 (deliverFile 이 갚는다).
      setPendingShots((count) => count + 1);
      const frozen = lastLiveRef.current;
      let url: string | null = null;
      if (frozen) {
        const blob = new Blob([frozen.slice()], { type: "image/jpeg" });
        frozenBlobsRef.current.set(id, blob);
        url = URL.createObjectURL(blob);
      }
      setCaptures((current) =>
        current.some((shot) => shot.id === id) ? current : [...current, { id, url, ready: false }],
      );
      // 비디오 코덱 경로 — JPEG 프리즈가 없으니 스튜디오 캔버스에서 정지 컷을 뜬다.
      if (!frozen && freezeSourceRef.current) {
        void freezeSourceRef.current().then((blob) => {
          if (!blob) return;
          if (!frozenBlobsRef.current.has(id) && fallbackTimersRef.current.has(id)) {
            frozenBlobsRef.current.set(id, blob);
          }
          const freezeUrl = URL.createObjectURL(blob);
          setCaptures((current) => {
            const target = current.find((shot) => shot.id === id);
            if (!target || target.url || target.ready) {
              URL.revokeObjectURL(freezeUrl);
              return current;
            }
            return current.map((shot) => (shot.id === id ? { ...shot, url: freezeUrl } : shot));
          });
        });
      }
      const timer = window.setTimeout(() => {
        fallbackTimersRef.current.delete(id);
        const blob = frozenBlobsRef.current.get(id);
        frozenBlobsRef.current.delete(id);
        if (!blob) return;
        // 원본이 늦는다 — 프리즈 프레임으로라도 트레이 약속을 지킨다.
        deliverFile(id, blob);
        setCaptures((current) =>
          current.map((shot) => (shot.id === id ? { ...shot, ready: true } : shot)),
        );
      }, PHOTO_FALLBACK_MS);
      fallbackTimersRef.current.set(id, timer);
    },
    [deliverFile],
  );

  const settlePhoto = useCallback(
    (id: number, payload: Uint8Array) => {
      const timer = fallbackTimersRef.current.get(id);
      if (timer) window.clearTimeout(timer);
      fallbackTimersRef.current.delete(id);
      frozenBlobsRef.current.delete(id);
      const blob = new Blob([payload.slice()], { type: "image/jpeg" });
      // 중복은 deliverFile 이 id 로 막는다 — 폴백이 이미 들어갔든, 셔터 JSON 이 유실돼
      // 엔트리 자체가 없든, 여기서는 그냥 넣으면 된다.
      deliverFile(id, blob);
      const url = URL.createObjectURL(blob);
      setCaptures((current) => {
        const existing = current.find((shot) => shot.id === id);
        if (!existing) {
          // 소등 뒤에 도착한 원본 — 파일은 트레이로 갔지만, 이미 걷힌 필름에 다시 붙이진 않는다.
          if (phaseRef.current === "parked" || phaseRef.current === "idle") {
            URL.revokeObjectURL(url);
            return current;
          }
          return [...current, { id, url, ready: true }];
        }
        if (existing.url) URL.revokeObjectURL(existing.url);
        return current.map((shot) => (shot.id === id ? { ...shot, url, ready: true } : shot));
      });
    },
    [deliverFile],
  );

  const failPhoto = useCallback(
    (id: number) => {
      const timer = fallbackTimersRef.current.get(id);
      if (timer) window.clearTimeout(timer);
      fallbackTimersRef.current.delete(id);
      const blob = frozenBlobsRef.current.get(id);
      frozenBlobsRef.current.delete(id);
      if (blob) deliverFile(id, blob);
      // 프리즈 프레임조차 없으면 트레이에 못 넣지만, 슬롯을 pending 으로 영원히 돌리진 않는다.
      else setPendingShots((count) => Math.max(0, count - 1));
      setCaptures((current) =>
        current.map((shot) => (shot.id === id ? { ...shot, ready: true } : shot)),
      );
    },
    [deliverFile],
  );

  /* ── 수신 라우팅 ── */
  const handleBinary = useCallback(
    (data: ArrayBuffer) => {
      if (data.byteLength < FRAME_HEADER_BYTES) return;
      const bytes = new Uint8Array(data);
      const kind = bytes[0];
      const seq = new DataView(data).getUint32(1, true);
      const payload = bytes.subarray(FRAME_HEADER_BYTES);

      if (kind === FRAME_LIVE) {
        lastLiveRef.current = payload;
        fpsCountRef.current += 1;
        const sink = frameSinkRef.current;
        if (!sink || decodeBusyRef.current) return;
        decodeBusyRef.current = true;
        createImageBitmap(new Blob([payload], { type: "image/jpeg" }))
          .then((bitmap) => {
            decodeBusyRef.current = false;
            if (seq <= lastPaintedSeqRef.current || !frameSinkRef.current) {
              bitmap.close();
              return;
            }
            lastPaintedSeqRef.current = seq;
            frameSinkRef.current(bitmap, seq);
          })
          .catch(() => {
            decodeBusyRef.current = false;
          });
        return;
      }
      if (kind === FRAME_VIDEO) {
        const decoder = videoDecoderRef.current;
        if (!decoder || decoder.state !== "configured") return;
        const isKey = (payload[0] & 0x01) === 0x01;
        // 디코더는 키프레임부터만 시작할 수 있다 — 그 전의 델타는 버린다.
        if (needKeyRef.current && !isKey) return;
        needKeyRef.current = false;
        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: isKey ? "key" : "delta",
              timestamp: seq * 16_667,
              data: payload.subarray(1),
            }),
          );
        } catch {
          needKeyRef.current = true;
        }
        return;
      }
      if (kind === FRAME_PHOTO) settlePhoto(seq, payload);
    },
    [settlePhoto],
  );

  /** 폰이 코덱을 알려오면 디코더를 (다시) 만든다. WebCodecs 가 없으면 JPEG 로 내려달라 한다. */
  const handleVideoConfig = useCallback(
    (message: Record<string, unknown>) => {
      if (typeof message.codec !== "string" || !message.codec) return;
      if (typeof window.VideoDecoder !== "function") {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ t: "force-jpeg" }));
          } catch {
            /* noop */
          }
        }
        return;
      }
      closeDecoder();
      const decoder = new VideoDecoder({
        output: (frame) => {
          fpsCountRef.current += 1;
          const sink = frameSinkRef.current;
          if (sink) sink(frame, 0);
          else frame.close();
        },
        error: () => {
          needKeyRef.current = true;
        },
      });
      try {
        decoder.configure({ codec: message.codec, optimizeForLatency: true });
        videoDecoderRef.current = decoder;
        needKeyRef.current = true;
      } catch {
        try {
          decoder.close();
        } catch {
          /* noop */
        }
      }
    },
    [closeDecoder],
  );

  const handleText = useCallback(
    (raw: string) => {
      let message: { t?: string; [key: string]: unknown };
      try {
        message = JSON.parse(raw) as { t?: string };
      } catch {
        return;
      }
      switch (message.t) {
        case "welcome": {
          if (message.voice === "unavailable") {
            setVoice((current) => ({ ...current, status: "unavailable" }));
          }
          // 재접속 시에도 폰 재실 여부는 welcome 이 진실이다.
          if (typeof message.peer === "boolean") setPhoneConnected(message.peer);
          if (message.peer === true && phaseRef.current === "waiting") setPhase("live");
          break;
        }
        case "peer": {
          if (message.role !== "phone") break;
          const joined = message.state === "joined";
          setPhoneConnected(joined);
          if (joined && phaseRef.current === "waiting") setPhase("live");
          break;
        }
        case "shutter": {
          if (typeof message.id === "number") beginCapture(message.id);
          break;
        }
        case "photo-fail": {
          if (typeof message.id === "number") failPhoto(message.id);
          break;
        }
        case "voice": {
          switch (message.kind) {
            case "ready":
              setVoice((current) => ({ ...current, status: "ready" }));
              break;
            case "unavailable":
              setVoice((current) => ({ ...current, status: "unavailable", speaking: false }));
              break;
            case "speech":
              setVoice((current) => ({
                ...current,
                speaking: message.active === true,
                interim: message.active === true ? "" : current.interim,
              }));
              break;
            case "delta":
              if (typeof message.text === "string") {
                const delta = message.text;
                setVoice((current) => ({ ...current, interim: current.interim + delta }));
              }
              break;
            case "final":
              if (typeof message.text === "string" && message.text) {
                const text = message.text;
                setVoice((current) => ({ ...current, interim: "", lastFinal: text }));
              }
              break;
            default:
              break;
          }
          break;
        }
        case "note": {
          // 서기의 산출물 — 발화 원문이 아니라 정리된 메모 전문이다.
          if (typeof message.text === "string") {
            const text = message.text;
            setVoice((current) => ({ ...current, note: text }));
            optionsRef.current.onNote(text);
          }
          break;
        }
        case "video-config": {
          handleVideoConfig(message);
          break;
        }
        case "end": {
          if (phaseRef.current === "live" || phaseRef.current === "waiting") setPhase("ending");
          // 라이브에서 끝났을 때만 마감이다 — 폰이 붙기도 전(waiting)의 종료는 취소일 뿐이다.
          if (phaseRef.current === "live") fireFinish();
          break;
        }
        case "relink": {
          // 파킹돼 있던 폰이 촬영을 재개했다 — 모니터를 다시 점화한다.
          if (phaseRef.current === "parked") {
            needKeyRef.current = true;
            finishedRef.current = false;
            setPhoneConnected(true);
            setPhase("live");
          }
          break;
        }
        default:
          break;
      }
    },
    [beginCapture, failPhoto, fireFinish, handleVideoConfig],
  );

  const connect = useCallback(
    (code: string) => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${location.host}/link?role=desktop&code=${code}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      // 하트비트 — 서버 생존 판정은 "수신 트래픽" 기준이라, 조용한 데스크톱도 신호를 보낸다.
      let heartbeat = 0;
      ws.onopen = () => {
        wsFailsRef.current = 0;
        heartbeat = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ t: "ping" }));
            } catch {
              /* noop */
            }
          }
        }, 10_000);
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") handleText(event.data);
        else handleBinary(event.data as ArrayBuffer);
      };
      ws.onclose = () => {
        window.clearInterval(heartbeat);
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        const phase = phaseRef.current;
        if (phase === "waiting" || phase === "creating") {
          wsFailsRef.current += 1;
          // 서버가 재시작되면 세션이 증발한다(404 루프) — 새 세션·새 QR 로 스스로 갈아탄다.
          if (wsFailsRef.current >= 3) {
            wsFailsRef.current = 0;
            recreateRef.current();
            return;
          }
          window.setTimeout(() => {
            if (!wsRef.current && phaseRef.current === "waiting") connect(code);
          }, 600);
          return;
        }
        if (phase === "live") {
          wsFailsRef.current += 1;
          // 라이브 중 세션이 사라졌다 — 계속 매달리지 않고 소등으로 정리한다.
          if (wsFailsRef.current >= 8) {
            wsFailsRef.current = 0;
            setPhase("ending");
            return;
          }
          window.setTimeout(() => {
            if (!wsRef.current && phaseRef.current === "live") connect(code);
          }, 600);
          return;
        }
        if (phase === "parked") {
          // 파킹 중엔 relink 를 받아야 하니 소켓을 살려 둔다. 1분쯤 매달리다 조용히 놓는다.
          wsFailsRef.current += 1;
          if (wsFailsRef.current >= 40) {
            wsFailsRef.current = 0;
            setPhase("idle");
            setSession(null);
            setQrDataUrl(null);
            setPhoneConnected(false);
            return;
          }
          window.setTimeout(() => {
            if (!wsRef.current && phaseRef.current === "parked") connect(code);
          }, 1_500);
        }
      };
    },
    [handleBinary, handleText],
  );

  /* ── 공개 API ── */
  const applySessionInfo = useCallback(async (info: LinkSessionInfo) => {
    setSession(info);
    if (info.phoneUrl) {
      const dataUrl = await QRCode.toDataURL(info.phoneUrl, {
        width: 560,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#101319", light: "#ffffff" },
      }).catch(() => null);
      setQrDataUrl(dataUrl);
    } else {
      setQrDataUrl(null);
    }
  }, []);

  const start = useCallback(() => {
    if (phaseRef.current !== "idle" && phaseRef.current !== "parked") return;
    // 파킹된 페어링이 남아 있다면 정중히 접고 새 세션으로 간다 (폰을 잃어버린 경우의 탈출구).
    if (phaseRef.current === "parked") {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ t: "end" }));
        } catch {
          /* noop */
        }
      }
      closeSocket();
      closeDecoder();
      clearTimers();
      setPhoneConnected(false);
      setVoice(IDLE_VOICE);
    }
    // 새 세션은 폰의 셔터 번호도 1 부터 다시 센다 — 이전 세션의 기록을 들고 가면 안 넣는다.
    deliveredRef.current.clear();
    finishedRef.current = false;
    setPendingShots(0);
    setError(null);
    setPhase("creating");
    void fetch("/api/link/sessions", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`세션 생성 실패 (${response.status})`);
        return (await response.json()) as LinkSessionInfo;
      })
      .then(async (info) => {
        await applySessionInfo(info);
        connect(info.code);
        setPhase("waiting");
      })
      .catch((cause: unknown) => {
        setPhase("idle");
        setError(
          cause instanceof Error
            ? cause.message
            : "폰 링크 세션을 만들지 못했습니다 — 에이전트 서버(8788)가 켜져 있는지 확인하세요.",
        );
      });
  }, [applySessionInfo, clearTimers, closeDecoder, closeSocket, connect]);

  /** 세션이 증발했을 때(서버 재시작) 같은 모달 안에서 새 세션·새 QR 로 갈아탄다. */
  const recreateSession = useCallback(() => {
    void fetch("/api/link/sessions", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`세션 재생성 실패 (${response.status})`);
        return (await response.json()) as LinkSessionInfo;
      })
      .then(async (info) => {
        await applySessionInfo(info);
        connect(info.code);
      })
      .catch(() => {
        // 서버 자체가 내려가 있다 — 살아날 때까지 대기 모달인 동안 계속 재시도한다.
        window.setTimeout(() => {
          if (phaseRef.current === "waiting") recreateRef.current();
        }, 1_500);
      });
  }, [applySessionInfo, connect]);

  useEffect(() => {
    recreateRef.current = recreateSession;
  }, [recreateSession]);

  const refreshUrls = useCallback(async () => {
    const code = sessionRef.current?.code;
    if (!code) return;
    const response = await fetch(`/api/link/sessions/${code}/urls`);
    if (!response.ok) return;
    const info = (await response.json()) as LinkSessionInfo;
    // 같은 주소면 QR 을 다시 굽지 않는다 — 주기 갱신이 화면을 계속 깜빡이게 두지 않는다.
    if (info.phoneUrl === sessionRef.current?.phoneUrl) return;
    await applySessionInfo(info);
  }, [applySessionInfo]);

  /*
    대기 중에는 주소를 계속 확인한다. 와이파이를 바꾸거나 핫스팟으로 갈아타면 맥 IP 가
    바뀌고 서버는 새 인증서로 다시 열리는데, 화면에 걸린 QR 은 옛 주소를 가리킨 채로
    남는다 — 그 QR 을 찍으면 폰은 영영 안 붙는다. 여기서 스스로 갈아 끼운다.
  */
  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = window.setInterval(() => {
      void refreshUrls().catch(() => undefined);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [phase, refreshUrls]);

  const startTunnel = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch("/api/link/tunnel", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return body.error ?? "인터넷 터널을 열지 못했습니다.";
      await refreshUrls();
      return null;
    } catch {
      return "인터넷 터널을 열지 못했습니다 — 에이전트 서버가 켜져 있는지 확인하세요.";
    }
  }, [refreshUrls]);

  const sendJson = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* noop */
      }
    }
  }, []);

  const end = useCallback(() => {
    if (phaseRef.current !== "live" && phaseRef.current !== "waiting") return;
    sendJson({ t: "end" });
    // 에코를 기다리지 않는다 — 소켓이 죽어 있으면 에코가 영영 안 오고, 그때도 마감은 마감이다.
    if (phaseRef.current === "live") fireFinish();
    setPhase("ending");
  }, [fireFinish, sendJson]);

  const cancel = useCallback(() => {
    sendJson({ t: "end" });
    closeSocket();
    clearTimers();
    setPhase("idle");
    setSession(null);
    setQrDataUrl(null);
    setPhoneConnected(false);
  }, [clearTimers, closeSocket, sendJson]);

  /**
   * 소등 후 파킹 — 촬영 산출물 상태만 걷고 페어링은 유지한다.
   * 폰의 "다시 촬영"({t:"relink"})이 이 상태에서 라이브로 복귀시킨다.
   */
  const park = useCallback(() => {
    /*
      ⚠ 소등은 사진을 기다리는 일을 끝내지 않는다. 폴백 타이머와 프리즈 컷을 그대로 살려
      둔다 — 종료 직후에도 원본은 계속 날아오는 중이고, 여기서 타이머를 걷으면 마지막
      한 장이 조용히 사라진다. 지금 프리즈 컷으로 확정해 버리는 것도 답이 아니다:
      1초 뒤 도착할 원본 대신 저화질 라이브 프레임이 등록 사진이 된다.
    */
    closeDecoder();
    for (const shot of capturesRef.current) if (shot.url) URL.revokeObjectURL(shot.url);
    setCaptures([]);
    setVoice((current) => ({ ...IDLE_VOICE, status: current.status }));
    lastLiveRef.current = null;
    lastPaintedSeqRef.current = 0;
    fpsCountRef.current = 0;
    setPhase("parked");
  }, [closeDecoder]);

  const reset = useCallback(() => {
    closeSocket();
    closeDecoder();
    clearTimers();
    for (const shot of capturesRef.current) if (shot.url) URL.revokeObjectURL(shot.url);
    deliveredRef.current.clear();
    finishedRef.current = false;
    setCaptures([]);
    setPendingShots(0);
    setPhase("idle");
    setSession(null);
    setQrDataUrl(null);
    setPhoneConnected(false);
    setVoice(IDLE_VOICE);
    lastLiveRef.current = null;
    lastPaintedSeqRef.current = 0;
    fpsCountRef.current = 0;
  }, [clearTimers, closeDecoder, closeSocket]);

  const sendTray = useCallback(
    (count: number, max: number) => {
      sendJson({ t: "tray", count, max, full: count >= max });
    },
    [sendJson],
  );

  const sendNoteSeed = useCallback(
    (text: string) => {
      sendJson({ t: "note-seed", text });
    },
    [sendJson],
  );

  const sendHandoff = useCallback(
    (state: HandoffState, url?: string) => {
      sendJson(url ? { t: "handoff", state, url } : { t: "handoff", state });
    },
    [sendJson],
  );

  /*
    파킹 중 재개 요청. 폰은 이미 카메라 권한을 받아 둔 오리진이라 대부분 제스처 없이
    다시 열린다. 못 열면 폰이 토스트를 띄우고 "다시 촬영" 버튼이 남는다 — 어느 쪽이든
    데스크톱에서 QR 을 새로 뽑을 이유는 없다.
  */
  const resume = useCallback(() => {
    if (phaseRef.current !== "parked") return;
    sendJson({ t: "resume" });
  }, [sendJson]);

  const setFrameSink = useCallback(
    (sink: ((frame: LiveFrame, seq: number) => void) | null) => {
      frameSinkRef.current = sink;
      if (!sink) lastPaintedSeqRef.current = 0;
    },
    [],
  );

  const setFreezeSource = useCallback((source: (() => Promise<Blob | null>) | null) => {
    freezeSourceRef.current = source;
  }, []);

  return {
    phase,
    session,
    qrDataUrl,
    phoneConnected,
    voice,
    captures,
    pendingShots,
    fps,
    error,
    start,
    end,
    cancel,
    reset,
    park,
    resume,
    sendTray,
    sendNoteSeed,
    sendHandoff,
    refreshUrls,
    startTunnel,
    setFrameSink,
    setFreezeSource,
  };
}
