import { describe, expect, it } from "vitest";
import {
  FRAME_AUDIO,
  FRAME_HEADER_BYTES,
  FRAME_LIVE,
  FRAME_PHOTO,
  FRAME_VIDEO,
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  decodeFrame,
  encodeFrame,
  generateLinkCode,
  isValidLinkCode,
} from "../server/link/protocol.js";

describe("link 바이너리 프레이밍", () => {
  it("인코드→디코드 왕복에서 kind·seq·payload 가 보존된다", () => {
    const payload = new Uint8Array([7, 0, 255, 3, 128]);
    for (const kind of [FRAME_LIVE, FRAME_PHOTO, FRAME_AUDIO, FRAME_VIDEO] as const) {
      const encoded = encodeFrame(kind, 123_456_789, payload);
      expect(encoded.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength);
      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.kind).toBe(kind);
      expect(decoded!.seq).toBe(123_456_789);
      expect([...decoded!.payload]).toEqual([...payload]);
    }
  });

  it("u32 경계의 seq 를 그대로 나른다 — 긴 세션에서 프레임 카운터가 깨지면 안 된다", () => {
    const decoded = decodeFrame(encodeFrame(FRAME_LIVE, 0xffffffff, new Uint8Array(0)));
    expect(decoded!.seq).toBe(0xffffffff);
    expect(() => encodeFrame(FRAME_LIVE, -1, new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodeFrame(FRAME_LIVE, 0x1_0000_0000, new Uint8Array(0))).toThrow(RangeError);
  });

  it("subarray 로 온 버퍼(오프셋 있는 뷰)도 올바로 디코드한다", () => {
    // ws 가 큰 버퍼의 조각을 넘길 수 있다 — byteOffset 을 무시하면 seq 가 쓰레기값이 된다.
    const raw = encodeFrame(FRAME_PHOTO, 42, new Uint8Array([1, 2, 3]));
    const padded = new Uint8Array(raw.byteLength + 8);
    padded.set(raw, 8);
    const view = padded.subarray(8);
    const decoded = decodeFrame(view);
    expect(decoded!.kind).toBe(FRAME_PHOTO);
    expect(decoded!.seq).toBe(42);
    expect([...decoded!.payload]).toEqual([1, 2, 3]);
  });

  it("깨진 입력은 던지지 않고 null — 릴레이는 프레임 하나를 버리고 계속 산다", () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(new Uint8Array([1, 2]))).toBeNull();
    expect(decodeFrame(encodeFrame(FRAME_LIVE, 1, new Uint8Array(0)).fill(0x7f, 0, 1))).toBeNull();
  });
});

describe("link 세션 코드", () => {
  it("혼동 문자(0/O·1/I/L) 없이 정해진 길이로 만든다", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateLinkCode();
      expect(code).toHaveLength(LINK_CODE_LENGTH);
      expect(isValidLinkCode(code)).toBe(true);
      for (const ch of code) expect(LINK_CODE_ALPHABET).toContain(ch);
    }
    expect(LINK_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it("검증은 길이·알파벳 밖 문자를 거른다", () => {
    expect(isValidLinkCode("ABC23")).toBe(false);
    expect(isValidLinkCode("ABC234X")).toBe(false);
    expect(isValidLinkCode("ABC10D")).toBe(false);
    expect(isValidLinkCode("abc234")).toBe(false);
  });
});
