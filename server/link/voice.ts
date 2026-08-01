import WebSocket from "ws";

/**
 * OpenAI Realtime 릴레이 — 폰 마이크의 PCM16(24kHz·mono·LE)을 흘려 넣고 텍스트만 돌려받는다.
 *
 * 두 모드:
 *  - "scribe"     : gpt-realtime-2.1 대화 세션을 **텍스트 출력 전용**으로 연다. 발화가 끝날 때마다
 *                   (server VAD) 모델이 소리를 직접 이해해 "정리된 메모 전문"을 응답으로 내놓는다.
 *                   입력 전사 사이드카를 같이 켜서 원문 자막(delta/final)도 그대로 흐른다.
 *  - "transcribe" : 전사 전용 세션. 원문 자막만 나온다 (메모 정리는 hub 가 NoteScribe 로 후처리).
 *
 * 허브는 scribe 모드를 먼저 시도하고, 구성 거부(모델 미개방 등)면 transcribe 모드로 폴백한다.
 * OpenAI 연결이 죽어도 세션(카메라)은 계속 살아야 하므로, 여기의 모든 실패는 이벤트로
 * 보고만 하고 절대 던지지 않는다.
 */

export type VoiceRelayEvent =
  | { kind: "ready" }
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "final"; itemId: string; text: string }
  | { kind: "speech"; active: boolean }
  | { kind: "note"; text: string }
  | { kind: "unavailable"; reason: string };

export interface VoiceRelayOptions {
  mode: "scribe" | "transcribe";
  apiKey: string;
  /** scribe 모드: realtime 모델명 / transcribe 모드: 전사 모델명 */
  model: string;
  /** 자막(입력 전사)용 모델 — scribe 모드에서 사이드카로 쓴다. */
  transcribeModel: string;
  language: string;
  onEvent: (event: VoiceRelayEvent) => void;
  onLog?: (line: string) => void;
}

/** 연결 전에 도착한 오디오는 여기까지만 쥐고 있는다 — 약 8초(24kHz·16bit·mono ≈ 48KB/s). */
const PENDING_AUDIO_LIMIT_BYTES = 400_000;
const MAX_RECONNECTS = 3;
const NOTE_LIMIT = 2000;

const SCRIBE_INSTRUCTIONS = `너는 중고 물건 판매자의 말을 듣고 스마트스토어 등록 메모를 관리하는 서기다.
매 턴, 지금까지 들은 모든 내용을 반영한 "메모 전문"만 출력한다. 다른 말은 한 마디도 하지 않는다.

규칙:
- 판매자가 말한 사실만 담는다: 물건 정체·브랜드·모델명, 상태·사용감·하자, 구성품, 크기/용량, 구매 시기, 희망 가격, 거래 방식.
- 잡담·추임새·혼잣말·상품과 무관한 소리는 무시한다. 그런 턴에는 직전 메모를 그대로 다시 출력한다.
- 새 발화가 이전 내용을 정정하면 옛 내용을 고쳐 쓴다 (가격 번복, 구성품 정정 등).
- "[현재 메모]" 로 시작하는 사용자 메시지는 발화가 아니라 메모의 초기 상태다 — 그 내용에서 출발한다.
- 문체: 간결한 한국어 구를 " · " 로 잇는다. 300자 이내를 지향한다. 마크다운·따옴표·머리말 금지.
- 아직 아무 정보도 없으면 하이픈 하나("-")만 출력한다.`;

export class VoiceRelay {
  private socket: WebSocket | null = null;
  private opened = false;
  private closedByUs = false;
  private reconnects = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private seedText: string | null = null;
  private lastNote: string | null = null;
  /** 응답별 텍스트 조립 버퍼 — 델타 이벤트만 오는 경우를 대비한다. */
  private responseText = new Map<string, string>();

  constructor(private readonly options: VoiceRelayOptions) {}

  start(): void {
    if (this.socket || this.closedByUs) return;
    this.connect();
  }

  appendAudio(chunk: Uint8Array): void {
    if (this.closedByUs) return;
    if (this.opened && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") });
      return;
    }
    // 아직 여는 중 — 발화 초두가 잘리지 않게 잠시 버퍼링한다.
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    while (this.pendingBytes > PENDING_AUDIO_LIMIT_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift()!;
      this.pendingBytes -= dropped.byteLength;
    }
  }

  /** 데스크톱 메모 칸의 현재 내용 — 서기의 출발점. scribe 모드에서만 의미 있다. */
  seedNote(text: string): void {
    const trimmed = text.trim().slice(0, NOTE_LIMIT);
    if (!trimmed) return;
    this.seedText = trimmed;
    this.lastNote = trimmed;
    if (this.opened) this.sendSeed();
  }

  close(): void {
    this.closedByUs = true;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.socket?.close(1000, "session end");
    } catch {
      /* 이미 죽어 있어도 상관없다 */
    }
    this.socket = null;
  }

  private url(): string {
    return this.options.mode === "scribe"
      ? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.options.model)}`
      : "wss://api.openai.com/v1/realtime?intent=transcription";
  }

  private connect(): void {
    const socket = new WebSocket(this.url(), {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    this.socket = socket;
    this.opened = false;

    socket.on("open", () => {
      this.send({ type: "session.update", session: this.sessionConfig() });
    });

    socket.on("message", (raw) => {
      let event: { type?: string; [key: string]: unknown };
      try {
        event = JSON.parse(String(raw)) as { type?: string };
      } catch {
        return;
      }
      this.handleServerEvent(event);
    });

    socket.on("error", (error) => {
      this.options.onLog?.(`[voice:${this.options.mode}] socket error: ${error.message}`);
    });

    socket.on("close", (code, reason) => {
      const wasOpened = this.opened;
      this.opened = false;
      this.socket = null;
      if (this.closedByUs) return;
      this.options.onLog?.(`[voice:${this.options.mode}] closed code=${code} reason=${String(reason)}`);
      if (this.reconnects >= MAX_RECONNECTS) {
        this.options.onEvent({ kind: "unavailable", reason: "음성 연결이 반복해서 끊어졌습니다" });
        return;
      }
      this.reconnects += 1;
      // 열리기도 전에 거절됐다면(401·모델 미개방) 재시도 간격을 더 벌린다.
      setTimeout(() => {
        if (!this.closedByUs) this.connect();
      }, wasOpened ? 700 : 1800);
    });
  }

  private sessionConfig(): Record<string, unknown> {
    const input = {
      format: { type: "audio/pcm", rate: 24000 },
      noise_reduction: { type: "far_field" },
      transcription: {
        model: this.options.transcribeModel,
        language: this.options.language,
        prompt: "판매할 물건을 설명하는 한국어 구어체 — 브랜드·모델명·상태·구성품·크기 표현이 섞인다.",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
        ...(this.options.mode === "scribe"
          ? { create_response: true, interrupt_response: false }
          : {}),
      },
    };

    if (this.options.mode === "transcribe") {
      return { type: "transcription", audio: { input } };
    }
    return {
      type: "realtime",
      output_modalities: ["text"],
      instructions: SCRIBE_INSTRUCTIONS,
      max_output_tokens: 700,
      audio: { input },
    };
  }

  private sendSeed(): void {
    if (!this.seedText || this.options.mode !== "scribe") return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[현재 메모] ${this.seedText}` }],
      },
    });
    this.seedText = null;
  }

  private handleServerEvent(event: { type?: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "session.created":
        break;
      case "session.updated": {
        // 세션 구성이 받아들여진 시점부터가 진짜 준비 완료다.
        if (!this.opened) {
          this.opened = true;
          this.reconnects = 0;
          this.options.onEvent({ kind: "ready" });
          this.sendSeed();
          for (const chunk of this.pending.splice(0)) {
            this.send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") });
          }
          this.pendingBytes = 0;
        }
        break;
      }
      case "input_audio_buffer.speech_started":
        this.options.onEvent({ kind: "speech", active: true });
        break;
      case "input_audio_buffer.speech_stopped":
        this.options.onEvent({ kind: "speech", active: false });
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const text = typeof event.delta === "string" ? event.delta : "";
        if (text) {
          this.options.onEvent({
            kind: "delta",
            itemId: typeof event.item_id === "string" ? event.item_id : "",
            text,
          });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
        if (text) {
          this.options.onEvent({
            kind: "final",
            itemId: typeof event.item_id === "string" ? event.item_id : "",
            text,
          });
        }
        break;
      }
      // ── scribe 모드: 응답 텍스트 = 갱신된 메모 전문 ──
      case "response.output_text.delta":
      case "response.text.delta": {
        const id = typeof event.response_id === "string" ? event.response_id : "?";
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) this.responseText.set(id, (this.responseText.get(id) ?? "") + delta);
        break;
      }
      case "response.output_text.done":
      case "response.text.done": {
        const id = typeof event.response_id === "string" ? event.response_id : "?";
        if (typeof event.text === "string") this.responseText.set(id, event.text);
        break;
      }
      case "response.done": {
        const response = event.response as { id?: unknown; output?: unknown } | undefined;
        const id = typeof response?.id === "string" ? response.id : "?";
        let text = (this.responseText.get(id) ?? "").trim();
        this.responseText.delete(id);
        // 델타 이벤트명이 어긋나도 메모를 잃지 않는다 — done 페이로드에서 직접 뽑는다.
        if (!text && Array.isArray(response?.output)) {
          const chunks: string[] = [];
          for (const item of response.output) {
            const content = (item as { content?: unknown })?.content;
            if (!Array.isArray(content)) continue;
            for (const part of content) {
              const value = (part as { text?: unknown })?.text;
              if (typeof value === "string") chunks.push(value);
            }
          }
          text = chunks.join("").trim();
        }
        this.emitNote(text);
        break;
      }
      case "error": {
        const detail =
          typeof event.error === "object" && event.error !== null
            ? String((event.error as { message?: unknown }).message ?? JSON.stringify(event.error))
            : String(event.error);
        this.options.onLog?.(`[voice:${this.options.mode}] api error: ${detail}`);
        // 구성 자체가 거부된 경우(모델 미개방·스키마) 재시도해도 소용없다 — 즉시 보고한다.
        if (!this.opened) {
          this.closedByUs = true;
          this.options.onEvent({ kind: "unavailable", reason: detail });
          try {
            this.socket?.close(1000, "config rejected");
          } catch {
            /* noop */
          }
          this.socket = null;
        }
        break;
      }
      default:
        break;
    }
  }

  private emitNote(raw: string): void {
    if (this.options.mode !== "scribe") return;
    let note = raw.trim();
    if (note === "-") note = "";
    note = note.slice(0, NOTE_LIMIT);
    // 잡담 턴이면 모델이 직전 메모를 그대로 되풀이한다 — 화면 갱신을 쏘지 않는다.
    if (note === this.lastNote || (!note && !this.lastNote)) return;
    this.lastNote = note;
    this.options.onEvent({ kind: "note", text: note });
  }

  private send(payload: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.options.onLog?.(
        `[voice:${this.options.mode}] send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
