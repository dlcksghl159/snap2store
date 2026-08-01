import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { env } from "../env.js";
import {
  FRAME_AUDIO,
  FRAME_LIVE,
  FRAME_PHOTO,
  FRAME_VIDEO,
  VIDEO_FLAG_KEY,
  decodeFrame,
  generateLinkCode,
  isValidLinkCode,
} from "./protocol.js";
import { publicPhoneBase } from "./public-url.js";
import { NoteScribe } from "./scribe.js";
import { lanAddresses } from "./tls.js";
import { activeTunnelHostname } from "./tunnel.js";
import { VoiceRelay } from "./voice.js";

/**
 * 폰 ↔ 데스크톱 링크 허브.
 *
 * 역할은 중계뿐이다 — 라이브 프레임과 셔터 원본은 손대지 않고 데스크톱으로 흘리고,
 * 오디오는 OpenAI 전사 릴레이로 넘긴 뒤 텍스트만 양쪽에 돌려준다.
 * WebRTC 대신 서버 경유를 쓰는 이유: 시연장 와이파이의 P2P 차단(클라이언트 격리)에도
 * "폰이 페이지를 열 수 있으면 스트림도 된다"는 단일 조건으로 좁혀진다.
 */

type LinkRole = "desktop" | "phone";

interface LinkSession {
  code: string;
  createdAt: number;
  lastActivity: number;
  desktop: WebSocket | null;
  phone: WebSocket | null;
  voice: VoiceRelay | null;
  /**
   * 발화 → 메모 경로. "scribe" 는 gpt-realtime 이 소리를 직접 이해해 메모를 쓰는 1홉,
   * "transcribe" 는 전사 후 NoteScribe(텍스트 모델)가 정리하는 2홉 폴백이다.
   */
  voiceMode: "scribe" | "transcribe";
  scribe: NoteScribe | null;
  /** 메모의 마지막 전문 — 폰 재접속으로 대화가 새로 열려도 여기서 이어 간다. */
  lastNote: string;
  /** 데스크톱이 늦게 붙어도 상태를 재전송할 수 있게 마지막 음성 상태를 기억한다. */
  voiceState: "idle" | "ready" | "unavailable";
  /** 비디오 릴레이가 밀려서 다음 키프레임까지 델타를 버리는 중인가. */
  dropVideoUntilKey: boolean;
  lastKeyRequestAt: number;
  ended: boolean;
}

/** 데스크톱 소켓이 이만큼 밀려 있으면 라이브 프레임을 버린다 — 지연은 죄, 프레임 드랍은 무죄. */
const LIVE_BACKPRESSURE_BYTES = 1_500_000;
/** 셔터 원본(12MB 상한) + 헤더 여유. */
const MAX_WS_PAYLOAD = 24 * 1024 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const PING_INTERVAL_MS = 12_000;
/**
 * 죽음 판정 유예. ⚠ protocol pong 만 믿으면 안 된다 — Cloudflare 터널 같은 중계는
 * ping/pong 을 끝단까지 통과시키지 않는다. "어떤 형태로든 수신이 있었는가"가 진짜 생존
 * 신호이고, 폰은 프레임을·양쪽 클라이언트는 10초 하트비트를 계속 보낸다.
 */
const DEAD_AFTER_MS = 40_000;

const lastSeenAt = new WeakMap<WebSocket, number>();

class LinkHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  private readonly sessions = new Map<string, LinkSession>();
  private sweeper: NodeJS.Timeout | null = null;

  createSession(): { code: string } {
    // 코드 충돌은 사실상 없지만(31^6), 만에 하나를 3회 재추첨으로 막는다.
    let code = generateLinkCode();
    for (let i = 0; i < 3 && this.sessions.has(code); i += 1) code = generateLinkCode();
    this.sessions.set(code, {
      code,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      desktop: null,
      phone: null,
      voice: null,
      voiceMode: "scribe",
      scribe: null,
      lastNote: "",
      voiceState: "idle",
      dropVideoUntilKey: false,
      lastKeyRequestAt: 0,
      ended: false,
    });
    this.ensureSweeper();
    return { code };
  }

  sessionExists(code: string): boolean {
    return this.sessions.has(code);
  }

  /** http(8788)·https(8443) 서버 양쪽의 upgrade 를 이 허브 하나로 받는다. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/link") return false;

    // 크로스사이트 WS 하이재킹 차단 — 브라우저는 Origin 을 반드시 보낸다.
    // 우리 화면(localhost dev UI·LAN 폰 페이지) 밖의 오리진은 세션 코드를 알아도 거절한다.
    if (!originAllowed(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return true;
    }

    const role = url.searchParams.get("role");
    const code = (url.searchParams.get("code") ?? "").toUpperCase();
    if ((role !== "desktop" && role !== "phone") || !isValidLinkCode(code)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return true;
    }
    const session = this.sessions.get(code);
    if (!session || session.ended) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return true;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.attach(session, role, ws);
    });
    return true;
  }

  private attach(session: LinkSession, role: LinkRole, ws: WebSocket): void {
    // 같은 역할의 재접속은 교체다 — 폰 새로고침·네트워크 순단에서 세션을 살린다.
    const previous = session[role];
    if (previous && previous.readyState === WebSocket.OPEN) {
      previous.close(4000, "replaced");
    }
    session[role] = ws;
    session.lastActivity = Date.now();
    lastSeenAt.set(ws, Date.now());

    /*
      연결 수명을 남긴다. 이게 없으면 "폰이 자꾸 끊긴다"를 눈으로 확인할 방법이 없다 —
      끊긴 게 폰인지 망인지 서버인지, 몇 초 만에 끊겼는지가 전부 추측이 된다.
      실측 없이 고치려다 시연 직전에 시간을 태웠다.
    */
    const joinedAt = Date.now();
    let bytesIn = 0;
    console.log(`[link] ${session.code} ${role} 합류`);

    ws.on("pong", () => lastSeenAt.set(ws, Date.now()));

    ws.on("message", (data, isBinary) => {
      session.lastActivity = Date.now();
      lastSeenAt.set(ws, Date.now());
      if (isBinary) {
        bytesIn += toBuffer(data).byteLength;
        if (role === "phone") this.routePhoneBinary(session, data);
        return;
      }
      this.routeText(session, role, data);
    });

    ws.on("close", (code, reason) => {
      const heldMs = Date.now() - joinedAt;
      const kbps = heldMs > 0 ? Math.round((bytesIn * 8) / heldMs) : 0;
      console.log(
        `[link] ${session.code} ${role} 종료 — ${Math.round(heldMs / 1000)}초 유지 · ` +
          `수신 ${(bytesIn / 1024 / 1024).toFixed(1)}MB (평균 ${kbps}kbps) · ` +
          `code=${code}${reason?.length ? ` reason=${String(reason).slice(0, 60)}` : ""}`,
      );
      if (session[role] !== ws) return; // 교체된 옛 소켓
      session[role] = null;
      this.sendTo(session, role === "phone" ? "desktop" : "phone", {
        t: "peer",
        role,
        state: "left",
      });
      if (role === "phone") {
        // 폰이 나가면 들을 소리도 없다. 재접속하면 새로 연다.
        session.voice?.close();
        session.voice = null;
        if (session.voiceState === "ready") session.voiceState = "idle";
      }
    });

    ws.on("error", () => {
      /* close 가 뒤따른다 — 여기서 세션을 건드리지 않는다 */
    });

    // 상대에게 합류를 알리고, 새로 온 쪽에는 현재 상태를 준다.
    this.sendTo(session, role === "phone" ? "desktop" : "phone", {
      t: "peer",
      role,
      state: "joined",
    });
    this.send(ws, {
      t: "welcome",
      role,
      code: session.code,
      peer: role === "phone" ? session.desktop != null : session.phone != null,
      voice: this.voiceAvailable() ? session.voiceState : "unavailable",
    });

    if (role === "phone") this.openVoice(session);
    // 데스크톱이 (재)합류하면 디코더가 맨몸이다 — 키프레임부터 다시 시작하게 한다.
    if (role === "desktop" && session.phone) {
      session.dropVideoUntilKey = true;
      session.lastKeyRequestAt = 0;
      this.requestKeyframe(session);
    }
  }

  /* ── 라우팅 ─────────────────────────────────────────────────── */

  private routePhoneBinary(session: LinkSession, data: RawData): void {
    const buffer = toBuffer(data);
    const frame = decodeFrame(buffer);
    if (!frame) return;

    switch (frame.kind) {
      case FRAME_LIVE: {
        const desktop = session.desktop;
        if (!desktop || desktop.readyState !== WebSocket.OPEN) return;
        if (desktop.bufferedAmount > LIVE_BACKPRESSURE_BYTES) return;
        desktop.send(buffer, { binary: true });
        return;
      }
      case FRAME_VIDEO: {
        const desktop = session.desktop;
        if (!desktop || desktop.readyState !== WebSocket.OPEN) return;
        const isKey = (frame.payload[0] & VIDEO_FLAG_KEY) !== 0;
        // 델타는 임의로 버릴 수 없다(다음 키프레임까지 화면이 깨진다).
        // 밀리면 키프레임까지 통째로 스킵하고, 폰에게 키프레임을 재촉한다.
        if (desktop.bufferedAmount > LIVE_BACKPRESSURE_BYTES && !session.dropVideoUntilKey) {
          session.dropVideoUntilKey = true;
        }
        if (session.dropVideoUntilKey) {
          if (!isKey) {
            this.requestKeyframe(session);
            return;
          }
          if (desktop.bufferedAmount > LIVE_BACKPRESSURE_BYTES) {
            // 키프레임인데도 아직 밀려 있다 — 이 키를 버리고 다음 키를 다시 기다린다.
            this.requestKeyframe(session);
            return;
          }
          session.dropVideoUntilKey = false;
        }
        desktop.send(buffer, { binary: true });
        return;
      }
      case FRAME_PHOTO: {
        const desktop = session.desktop;
        if (!desktop || desktop.readyState !== WebSocket.OPEN) return;
        // 셔터 원본은 백프레셔와 무관하게 반드시 전달한다.
        desktop.send(buffer, { binary: true });
        return;
      }
      case FRAME_AUDIO: {
        session.voice?.appendAudio(frame.payload);
        return;
      }
      default:
        return;
    }
  }

  private routeText(session: LinkSession, from: LinkRole, data: RawData): void {
    let message: { t?: string; [key: string]: unknown };
    try {
      message = JSON.parse(String(data)) as { t?: string };
    } catch {
      return;
    }

    switch (message.t) {
      case "end": {
        const notice = { t: "end", by: from };
        this.sendTo(session, "desktop", notice);
        this.sendTo(session, "phone", notice);
        session.voice?.close();
        session.voice = null;
        if (session.voiceState === "ready") session.voiceState = "idle";
        // 세션·소켓·메모 맥락(scribe)은 살려 둔다 — 폰의 "다시 연결"이 같은 코드로
        // QR 재스캔 없이 복귀한다. 최종 정리는 유휴 GC(30분)가 맡는다.
        return;
      }
      case "relink": {
        // 폰이 촬영을 재개한다 — 음성을 다시 열고, 디코더가 맨몸이니 키프레임부터.
        session.dropVideoUntilKey = true;
        session.lastKeyRequestAt = 0;
        this.openVoice(session);
        this.sendTo(session, "desktop", message);
        return;
      }
      case "camera-fail": {
        // 폰 화면에만 뜨는 고장은 고칠 수가 없다 — 서버 로그와 데스크톱 양쪽에 남긴다.
        console.warn(
          `[link] ${session.code} 폰 카메라 실패 — ${String(message.reason ?? "?")}: ${String(
            message.message ?? "",
          ).slice(0, 120)}`,
        );
        this.sendTo(session, "desktop", message);
        return;
      }
      case "shutter":
      case "photo-fail":
        this.sendTo(session, "desktop", message);
        return;
      case "tray":
        this.sendTo(session, "phone", message);
        return;
      case "note-seed": {
        // 데스크톱 메모 칸의 현재 내용 — 서기의 출발점이다.
        const text = typeof message.text === "string" ? message.text : "";
        session.lastNote = text.trim().slice(0, 2000);
        if (session.voiceMode === "scribe") session.voice?.seedNote(session.lastNote);
        else session.scribe?.seed(session.lastNote);
        return;
      }
      case "ping":
        this.send(session[from], { t: "pong" });
        return;
      default:
        // 모르는 제어 메시지는 상대편에 그대로 흘린다 — 앞으로의 확장 여지.
        this.sendTo(session, from === "phone" ? "desktop" : "phone", message);
    }
  }

  /** 폰에게 키프레임을 재촉한다 — 초당 1회로 제한해 스팸을 막는다. */
  private requestKeyframe(session: LinkSession): void {
    const now = Date.now();
    if (now - session.lastKeyRequestAt < 1_000) return;
    session.lastKeyRequestAt = now;
    this.sendTo(session, "phone", { t: "need-key" });
  }

  /* ── 음성 ───────────────────────────────────────────────────── */

  private voiceAvailable(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  private openVoice(session: LinkSession): void {
    if (session.voice || session.ended) return;
    if (!this.voiceAvailable()) {
      session.voiceState = "unavailable";
      this.broadcast(session, { t: "voice", kind: "unavailable", reason: "OPENAI_API_KEY 없음" });
      return;
    }
    this.startRelay(session, session.voiceMode);
  }

  private startRelay(session: LinkSession, mode: "scribe" | "transcribe"): void {
    session.voiceMode = mode;

    if (mode === "transcribe" && !session.scribe) {
      // 2홉 폴백 — 전사 확정문을 텍스트 모델이 메모로 정리한다.
      session.scribe = new NoteScribe({
        onLog: (line) => console.warn(line),
        onNote: (note) => {
          session.lastNote = note;
          this.sendTo(session, "desktop", { t: "note", text: note });
        },
      });
      session.scribe.seed(session.lastNote);
    }

    const relay = new VoiceRelay({
      mode,
      apiKey: env.OPENAI_API_KEY!,
      model: mode === "scribe" ? env.VOICE_REALTIME_MODEL : env.VOICE_TRANSCRIBE_MODEL,
      transcribeModel: env.VOICE_TRANSCRIBE_MODEL,
      language: env.VOICE_LANGUAGE,
      onLog: (line) => console.warn(line),
      onEvent: (event) => {
        if (session.voice !== relay) return; // 폴백으로 교체된 옛 릴레이
        switch (event.kind) {
          case "ready":
            session.voiceState = "ready";
            this.broadcast(session, { t: "voice", kind: "ready" });
            return;
          case "note":
            session.lastNote = event.text;
            this.sendTo(session, "desktop", { t: "note", text: event.text });
            return;
          case "final":
            if (session.voiceMode === "transcribe") session.scribe?.push(event.text);
            this.broadcast(session, { t: "voice", ...event });
            return;
          case "unavailable": {
            // gpt-realtime 이 조직에 안 열려 있는 등 구성 거부 → 전사+서기 2홉으로 조용히 내려간다.
            if (mode === "scribe" && !session.ended) {
              console.warn(`[voice] scribe 모드 불가(${event.reason}) — 전사+서기 폴백으로 전환`);
              session.voice = null;
              this.startRelay(session, "transcribe");
              return;
            }
            session.voiceState = "unavailable";
            this.broadcast(session, { t: "voice", ...event });
            return;
          }
          default:
            this.broadcast(session, { t: "voice", ...event });
        }
      },
    });
    session.voice = relay;
    if (mode === "scribe" && session.lastNote) relay.seedNote(session.lastNote);
    relay.start();
  }

  /* ── 전송 유틸 ──────────────────────────────────────────────── */

  private sendTo(session: LinkSession, role: LinkRole, payload: Record<string, unknown>): void {
    this.send(session[role], payload);
  }

  private broadcast(session: LinkSession, payload: Record<string, unknown>): void {
    this.send(session.desktop, payload);
    this.send(session.phone, payload);
  }

  private send(ws: WebSocket | null, payload: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* close 경합 — 프레임 하나 잃는 것으로 끝낸다 */
    }
  }

  private destroySession(code: string): void {
    const session = this.sessions.get(code);
    if (!session) return;
    session.voice?.close();
    session.scribe?.close();
    for (const role of ["desktop", "phone"] as const) {
      const ws = session[role];
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "session closed");
    }
    this.sessions.delete(code);
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.sessions.values()]) {
        // 죽은 소켓 감지 — 수신(메시지·pong)이 DEAD_AFTER_MS 동안 전혀 없을 때만 끊는다.
        for (const role of ["desktop", "phone"] as const) {
          const ws = session[role];
          if (!ws) continue;
          const seenAt = lastSeenAt.get(ws) ?? 0;
          if (now - seenAt > DEAD_AFTER_MS) {
            console.warn(`[link] ${session.code} ${role} 무응답 ${Math.round((now - seenAt) / 1000)}s — 종료`);
            ws.terminate();
            continue;
          }
          try {
            ws.ping();
          } catch {
            /* noop */
          }
        }
        if (now - session.lastActivity > SESSION_IDLE_MS) this.destroySession(session.code);
      }
      if (this.sessions.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, PING_INTERVAL_MS);
    this.sweeper.unref?.();
  }
}

function toBuffer(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

/**
 * 이 기계의 화면에서 열린 페이지만 허용한다: localhost 계열(dev UI 포트 불문)과
 * 이 기계의 LAN IP(폰 페이지 오리진). Origin 이 없는 요청은 브라우저가 아니므로
 * 크로스사이트 하이재킹의 대상이 아니다 — 통과시킨다 (테스트 클라이언트 포함).
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  /*
    ⚠ 터널 호스트는 **두 경로 모두** 봐야 한다.
    - activeTunnelHostname(): 이 프로세스가 직접 띄운 터널
    - publicPhoneBase(): 지킴이(외부 프로세스)나 LINK_PUBLIC_URL 이 잡아 둔 주소

    실측 사고: 터널을 지킴이로 분리하면서 QR 주소만 새 경로로 바꾸고 이 가드는 옛 경로만
    보게 뒀다. 그 결과 터널로 들어온 **브라우저만** 403 으로 막혔다 — Node 테스트
    클라이언트는 Origin 을 안 보내 통과했기 때문에, 검증은 계속 초록불이었다.
  */
  if (hostname === activeTunnelHostname()) return true;
  const publicBase = publicPhoneBase();
  if (publicBase) {
    try {
      if (hostname === new URL(publicBase).hostname) return true;
    } catch {
      /* 형식이 깨진 주소는 없는 셈 친다 */
    }
  }
  return lanAddresses().includes(hostname);
}

/** 앱 라우트(app.ts)와 부트스트랩(index.ts)이 같은 인스턴스를 봐야 한다. */
export const linkHub = new LinkHub();
