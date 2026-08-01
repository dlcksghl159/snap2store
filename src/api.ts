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
