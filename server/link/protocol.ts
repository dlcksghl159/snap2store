import { randomBytes } from "node:crypto";

/**
 * 폰 ↔ 서버 ↔ 데스크톱 바이너리 프레이밍.
 *
 * 한 세션에 세 종류의 바이너리가 흐른다 — 라이브 프리뷰 JPEG, 셔터 원본 JPEG, PCM16 오디오.
 * WebSocket 메시지 하나 = [kind u8][seq u32 LE][payload]. JSON 제어 메시지는 텍스트 프레임.
 *
 * seq 의 의미는 kind 마다 다르다:
 *  - LIVE  : JPEG 프레임 카운터. 데스크톱은 createImageBitmap 완료가 순서를 앞지를 수 있어
 *            마지막으로 그린 seq 보다 작은 프레임을 버린다.
 *  - PHOTO : 셔터 id. 폰이 셔터 JSON({t:"shutter", id})을 먼저 보내고 같은 id 로 원본을 보낸다.
 *  - AUDIO : 청크 카운터 (진단용).
 *  - VIDEO : WebCodecs 인코드 프레임 카운터. payload[0] 은 플래그(bit0 = 키프레임),
 *            나머지가 코덱 비트스트림이다. 델타 프레임은 순서·유실에 민감하므로
 *            릴레이는 밀릴 때 "다음 키프레임까지 통째로 스킵" 전략만 쓴다.
 */

export const FRAME_LIVE = 0x01;
export const FRAME_PHOTO = 0x02;
export const FRAME_AUDIO = 0x03;
export const FRAME_VIDEO = 0x04;
export const VIDEO_FLAG_KEY = 0x01;

export const FRAME_HEADER_BYTES = 5;

export type FrameKind =
  | typeof FRAME_LIVE
  | typeof FRAME_PHOTO
  | typeof FRAME_AUDIO
  | typeof FRAME_VIDEO;

export interface LinkFrame {
  kind: FrameKind;
  seq: number;
  payload: Uint8Array;
}

export function encodeFrame(kind: FrameKind, seq: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new RangeError(`seq 는 u32 범위여야 합니다: ${seq}`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq, true);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/** 알 수 없는 kind·잘린 헤더는 null — 릴레이가 죽는 것보다 프레임 하나를 버리는 게 낫다. */
export function decodeFrame(data: Uint8Array): LinkFrame | null {
  if (data.byteLength < FRAME_HEADER_BYTES) return null;
  const kind = data[0];
  if (kind !== FRAME_LIVE && kind !== FRAME_PHOTO && kind !== FRAME_AUDIO && kind !== FRAME_VIDEO) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const seq = view.getUint32(1, true);
  return { kind, seq, payload: data.subarray(FRAME_HEADER_BYTES) };
}

/* ── 세션 코드 ───────────────────────────────────────────────── */

/** 0/O·1/I/L 같은 혼동 문자를 뺀 알파벳 — 폰에서 육안 대조할 수 있어야 한다. */
export const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const LINK_CODE_LENGTH = 6;

export function generateLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    code += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return code;
}

export function isValidLinkCode(value: string): boolean {
  if (value.length !== LINK_CODE_LENGTH) return false;
  for (const ch of value) {
    if (!LINK_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
