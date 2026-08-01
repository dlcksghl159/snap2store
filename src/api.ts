import type { ListingRecord, RuntimeConfig } from "./domain/types";

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `요청이 실패했습니다 (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* 본문 없음 */
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function fetchConfig(): Promise<RuntimeConfig> {
  return json<RuntimeConfig>(await fetch("/api/config"));
}

export async function fetchListings(): Promise<ListingRecord[]> {
  return json<ListingRecord[]>(await fetch("/api/listings"));
}

export async function fetchListing(id: string): Promise<ListingRecord> {
  return json<ListingRecord>(await fetch(`/api/listings/${id}`));
}

export async function createListing(files: File[], note: string): Promise<{ id: string }> {
  const form = new FormData();
  for (const file of files) form.append("photos", file);
  if (note.trim()) form.append("note", note.trim());
  return json<{ id: string }>(await fetch("/api/listings", { method: "POST", body: form }));
}

/** 사진에 붙일 판단용 사본은 앞쪽 몇 장이면 족하다 — 서버도 같은 수로 자른다. */
const NOTE_VISION_PHOTOS = 6;
/**
 * 마감 정리의 인내심. 실측 4초짜리 호출이고, 이건 등록 앞에 서 있는 유일한 대기다 —
 * 모델이 붙들려 있다고 등록을 붙들 수는 없다 (OpenAI 클라이언트 자체 상한은 90초다).
 */
const NOTE_TIMEOUT_MS = 15_000;

/**
 * 촬영을 마치는 순간의 마감 정리 — 말로 받아 적은 메모를 **찍은 사진과 함께** 다시 읽는다.
 * 실패하거나 늦으면 말한 그대로 돌려준다. 메모 정리가 등록을 막지 않는다.
 */
export async function finalizeNote(files: File[], note: string): Promise<string> {
  const form = new FormData();
  for (const file of files.slice(0, NOTE_VISION_PHOTOS)) form.append("photos", file);
  form.append("note", note);

  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), NOTE_TIMEOUT_MS);
  try {
    const body = await json<{ note?: string }>(
      await fetch("/api/link/note", { method: "POST", body: form, signal: abort.signal }),
    );
    return typeof body.note === "string" ? body.note : note;
  } finally {
    window.clearTimeout(timer);
  }
}

/** ⚠ Intl 은 Invalid Date 에 RangeError 를 던진다 — 깨진 레코드 하나가 목록을 흰 화면으로 만들지 않게. */
export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("ko-KR")}원`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
