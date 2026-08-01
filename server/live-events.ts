import type { Response } from "express";
import type { LiveEvent } from "../src/domain/types";

const RING_SIZE = 1000;
const ring: LiveEvent[] = [];
let nextSeq = 1;
const subscribers = new Set<Response>();

export function publishLiveEvent(input: {
  listingId: string;
  channel: string;
  label: string;
  payload?: unknown;
}): void {
  const event: LiveEvent = {
    seq: nextSeq++,
    at: new Date().toISOString(),
    listingId: input.listingId,
    channel: input.channel,
    label: input.label,
    payload: input.payload ?? null,
  };
  ring.push(event);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  let frame: string;
  try {
    frame = `event: live\ndata: ${JSON.stringify(event)}\n\n`;
  } catch {
    return;
  }
  for (const response of subscribers) {
    try {
      response.write(frame);
    } catch {
      subscribers.delete(response);
    }
  }
}

export function subscribeLiveEvents(response: Response, backlog = 50): void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
  response.write(`retry: 1500\n\n`);

  for (const event of ring.slice(-backlog)) {
    response.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
  }
  subscribers.add(response);

  const heartbeat = setInterval(() => {
    try {
      response.write(`: hb ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, 15_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  };

  response.on("close", cleanup);
  response.on("error", cleanup);
}

export function liveSubscriberCount(): number {
  return subscribers.size;
}

/** 테스트 전용 — 링버퍼를 비운다. */
export function resetLiveEventsForTests(): void {
  ring.length = 0;
}
