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
}

/** 스튜디오 캔버스에 그릴 수 있는 프레임 — JPEG 경로는 ImageBitmap, 비디오 경로는 VideoFrame. */
export type LiveFrame = ImageBitmap | VideoFrame;

export interface PhoneLinkApi {
  phase: LinkPhase;
  session: LinkSessionInfo | null;
  qrDataUrl: string | null;
  phoneConnected: boolean;
  voice: VoiceState;
  captures: CaptureShot[];
  fps: number;
  error: string | null;
  start: () => void;
  end: () => void;
  cancel: () => void;
  reset: () => void;
  /** 소등 뒤 페어링을 유지한 채 대기한다 — 폰의 "다시 촬영"이 여기서 복귀한다. */
  park: () => void;
  sendTray: (count: number, max: number) => void;
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
  const deliverFile = useCallback((id: number, blob: Blob) => {
    const file = new File([blob], `phone-shot-${id}.jpg`, { type: "image/jpeg" });
    optionsRef.current.onPhotoFile(file);
  }, []);

  const beginCapture = useCallback(
    (id: number) => {
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
      // ready 로 이미 표시된 샷은 폴백(프리즈 프레임)이 트레이에 들어갔다는 뜻 —
      // 원본을 또 넣으면 같은 사진이 두 장 생긴다. 셔터 JSON 이 유실돼 엔트리 자체가
      // 없는 경우는 반드시 넣는다.
      const alreadyDelivered = capturesRef.current.find((shot) => shot.id === id)?.ready === true;
      if (!alreadyDelivered) deliverFile(id, blob);
      const url = URL.createObjectURL(blob);
      setCaptures((current) => {
        const existing = current.find((shot) => shot.id === id);
        if (!existing) return [...current, { id, url, ready: true }];
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
          break;
        }
        case "relink": {
          // 파킹돼 있던 폰이 촬영을 재개했다 — 모니터를 다시 점화한다.
          if (phaseRef.current === "parked") {
            needKeyRef.current = true;
            setPhoneConnected(true);
            setPhase("live");
          }
          break;
        }
        default:
          break;
      }
    },
    [beginCapture, failPhoto, handleVideoConfig],
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
    await applySessionInfo(info);
  }, [applySessionInfo]);

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
    setPhase("ending");
  }, [sendJson]);

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
    clearTimers();
    closeDecoder();
    for (const shot of capturesRef.current) if (shot.url) URL.revokeObjectURL(shot.url);
    setCaptures([]);
    setVoice((current) => ({ ...IDLE_VOICE, status: current.status }));
    lastLiveRef.current = null;
    lastPaintedSeqRef.current = 0;
    fpsCountRef.current = 0;
    setPhase("parked");
  }, [clearTimers, closeDecoder]);

  const reset = useCallback(() => {
    closeSocket();
    closeDecoder();
    clearTimers();
    for (const shot of capturesRef.current) if (shot.url) URL.revokeObjectURL(shot.url);
    setCaptures([]);
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
    fps,
    error,
    start,
    end,
    cancel,
    reset,
    park,
    sendTray,
    sendNoteSeed,
    refreshUrls,
    startTunnel,
    setFrameSink,
    setFreezeSource,
  };
}
