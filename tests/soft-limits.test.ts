import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clipText, softMaxArray, softMaxString } from "../server/ai/openai-json.js";

/**
 * OpenAI 구조화 출력의 JSON Schema 는 `maxLength` 를 강제하지 않는다 — 글자수는
 * description 으로 부탁하는 것이 전부라 모델은 일상적으로 넘긴다.
 *
 * 실제로 이 규칙이 없어서 상세 기획이 통째로 사라진 런이 있었다: sceneHint 6개가
 * 160자를 넘겼고 `z.string().max(160)` 이 응답 **전체**를 폐기해, 컨셉·서사·패널
 * 스펙이 다 있었는데도 그 런은 상세페이지 없이 등록됐다.
 *
 * 여기서 잠그는 계약: 길이는 잘라서 살리고, 구조는 그대로 깐깐하게 본다.
 */

describe("softMaxString — 길이 초과는 자르되 버리지 않는다", () => {
  it("상한 이하는 그대로 통과한다", () => {
    expect(softMaxString(10).parse("짧은 문장")).toBe("짧은 문장");
  });

  it("앞뒤 공백은 정리한다", () => {
    expect(softMaxString(10).parse("  여백  ")).toBe("여백");
  });

  it("초과해도 파싱은 성공한다 — 이게 이 헬퍼의 존재 이유다", () => {
    const schema = softMaxString(20);
    expect(() => schema.parse("가".repeat(200))).not.toThrow();
    expect(schema.parse("가".repeat(200))).toHaveLength(20);
  });

  it("객체 안의 한 필드가 넘쳐도 나머지 필드가 살아남는다", () => {
    const Plan = z.object({
      role: z.enum(["hook", "closing"]),
      heading: softMaxString(10),
      sceneHint: softMaxString(30),
    });
    const parsed = Plan.parse({
      role: "hook",
      heading: "제목이 아주아주아주 길어졌다",
      sceneHint: "A ".repeat(80),
    });
    expect(parsed.role).toBe("hook");
    expect(parsed.heading).toHaveLength(10);
    expect(parsed.sceneHint.length).toBeLessThanOrEqual(30);
  });

  it("구조 위반은 여전히 거부한다 — 길이만 봐주고 계약은 봐주지 않는다", () => {
    const Plan = z.object({
      role: z.enum(["hook", "closing"]),
      sections: z.array(z.object({ body: softMaxString(20) })).min(2),
    });
    expect(() => Plan.parse({ role: "unknown", sections: [{ body: "a" }, { body: "b" }] })).toThrow();
    expect(() => Plan.parse({ role: "hook", sections: [{ body: "a" }] })).toThrow();
  });
});

describe("softMaxArray — 개수 초과도 자르되 버리지 않는다", () => {
  it("상한 이하는 그대로 통과한다", () => {
    expect(softMaxArray(z.string(), 6).parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("초과분만 잘라 낸다 — 실측으로 이게 상품명 분해 전체를 죽였다", () => {
    const schema = softMaxArray(z.string(), 6, 1);
    const parsed = schema.parse(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(parsed).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("최소 개수는 하드 계약으로 남는다 — 빈 목록은 거부한다", () => {
    expect(() => softMaxArray(z.string(), 6, 1).parse([])).toThrow();
  });

  it("항목 스키마 위반은 그대로 거부한다", () => {
    expect(() => softMaxArray(z.string(), 6, 1).parse([1, 2])).toThrow();
  });

  it("중첩해도 동작한다 — 유닛 목록 안의 표현 목록", () => {
    const Unit = z.object({
      importance: z.enum(["primary", "secondary"]),
      expressions: softMaxArray(softMaxString(4), 2, 1),
    });
    const Decomposition = z.object({ units: softMaxArray(Unit, 2, 1) });
    const parsed = Decomposition.parse({
      units: [
        { importance: "primary", expressions: ["가나다라마바", "b", "c", "d"] },
        { importance: "secondary", expressions: ["e"] },
        { importance: "secondary", expressions: ["f"] },
      ],
    });
    expect(parsed.units).toHaveLength(2);
    expect(parsed.units[0].expressions).toEqual(["가나다라", "b"]);
  });
});

describe("clipText — 문장·어절 경계에서 물러난다", () => {
  it("문장 끝이 상한 근처면 거기서 끊는다", () => {
    const text = "A studio scene on a warm oak desk. Then a second sentence that overflows the cap.";
    const clipped = clipText(text, 40);
    expect(clipped).toBe("A studio scene on a warm oak desk.");
  });

  it("문장 끝이 너무 앞이면 어절 경계로 물러난다", () => {
    const text = "끝. " + "긴단어 ".repeat(20);
    const clipped = clipText(text, 40);
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(clipped.endsWith(" ")).toBe(false);
    // 문장 끝(2자 위치)은 너무 앞이라 채택하지 않는다.
    expect(clipped.length).toBeGreaterThan(20);
  });

  it("경계가 없으면 상한에서 그냥 끊는다", () => {
    expect(clipText("가".repeat(100), 25)).toHaveLength(25);
  });
});
