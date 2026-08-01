import { randomUUID } from "node:crypto";
import { publishLiveEvent } from "./live-events.js";
import { updateListing } from "./store.js";
import type {
  EventKind,
  EventSource,
  ListingEvent,
  ListingRecord,
  ListingStage,
} from "../src/domain/types";

/** 레코드당 이벤트 상한. 긴 런은 여기서 앞쪽이 잘린다 —
 *  결과 화면이 필요로 하는 값은 반드시 `materials` 에 저장한다. */
const MAX_EVENTS = 160;

export interface AppendEventInput {
  source: EventSource;
  kind: EventKind;
  label: string;
  payload?: Record<string, unknown> | null;
}

function createEvent(event: AppendEventInput): ListingEvent {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    source: event.source,
    kind: event.kind,
    label: event.label,
    payload: event.payload ?? null,
  };
}

/**
 * 채널 분리 규칙 — 서버가 만든 진행 보고를 `tool_result` 로 흘리지 않는다.
 * 그것은 SDK 원본이 아니므로 "가공 없이"라는 약속을 깬다.
 */
function channelOf(event: AppendEventInput): string {
  if (event.kind === "tool_call") return "tool_call";
  if (event.kind === "tool_result") return "tool_result";
  if (event.kind === "model_event") return "openai_raw";
  if (event.kind === "milestone") return "milestone";
  if (event.kind === "image") return "image";
  if (event.kind === "error") return "error";
  return "status";
}

export async function appendEvent(
  listingId: string,
  event: AppendEventInput,
): Promise<ListingRecord> {
  publishLiveEvent({
    listingId,
    channel: channelOf(event),
    label: event.label,
    payload: event.payload ?? null,
  });
  return updateListing(listingId, (listing) => ({
    ...listing,
    events: [...listing.events, createEvent(event)].slice(-MAX_EVENTS),
  }));
}

/** 고빈도 raw 델타 전용 — 버스에만 흘리고 파일에 쓰지 않는다. */
export function emitLiveOnly(
  listingId: string,
  channel: string,
  label: string,
  payload?: unknown,
): void {
  publishLiveEvent({ listingId, channel, label, payload: payload ?? null });
}

export async function setStage(
  listingId: string,
  stage: ListingStage,
  progress: number,
  stageLabel: string,
): Promise<ListingRecord> {
  publishLiveEvent({
    listingId,
    channel: "status",
    label: stageLabel,
    payload: { stage, progress },
  });
  return updateListing(listingId, (listing) => ({
    ...listing,
    status:
      stage === "failed" ? "failed" : stage === "blocked" ? "needs_review" : "running",
    stage,
    progress,
    stageLabel,
    events: [
      ...listing.events,
      createEvent({ source: "runtime", kind: "status", label: stageLabel, payload: { stage, progress } }),
    ].slice(-MAX_EVENTS),
  }));
}

const SECRET_KEY_RE = /secret|token|authorization|api.?key/i;
const SECRET_VALUE_RE = /sk-[a-z0-9_-]{12,}/i;

/**
 * 무가공 원칙의 예외는 셋뿐이다:
 * ① base64 이미지(사실상 바이너리) ② 16k 폭주 방어 상한 ③ 비밀키 패턴 마스킹.
 * 컨테이너 캡(깊이 5·배열 24·키 40)은 전부 크기 방어이며 내용 재작성은 하지 않는다.
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") {
    if (value.startsWith("data:image/") || value.length > 16_000) {
      return `[redacted:${value.length} chars]`;
    }
    if (SECRET_VALUE_RE.test(value)) return "[redacted-secret]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => sanitizePayload(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY_RE.test(key))
        .slice(0, 40)
        .map(([key, item]) => [key, sanitizePayload(item, depth + 1)]),
    );
  }
  return value;
}
