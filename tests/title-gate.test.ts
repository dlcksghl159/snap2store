import { describe, expect, it } from "vitest";
import { repairTitle, validateTitle } from "../server/materials/title-gate.js";

describe("상품명 하드 게이트", () => {
  it("등록 게이트에서 100자를 넘으면 거부한다", () => {
    const long = "가".repeat(101);
    expect(validateTitle(long, "registration").errors.join()).toContain("100자");
  });

  it("50자 초과는 등록 게이트에서 경고이지 에러가 아니다", () => {
    const title = "노트북 거치대 ".repeat(6).trim(); // 50자 초과 100자 이하
    const gate = validateTitle(title.slice(0, 60), "registration");
    expect(gate.errors.filter((error) => error.includes("자를 넘습니다"))).toHaveLength(0);
  });

  it("금지 특수문자를 거부한다", () => {
    for (const character of ["*", "?", '"', "<", ">"]) {
      const gate = validateTitle(`노트북 거치대${character}`, "generation");
      expect(gate.errors.join()).toContain("특수문자");
    }
  });

  it("홍보 표현을 거부한다", () => {
    expect(validateTitle("노트북 거치대 무료배송", "generation").errors.join()).toContain("홍보성");
    expect(validateTitle("노트북 거치대 최저가", "generation").errors.join()).toContain("홍보성");
  });

  it("한글 앞자 ~st 모조 표현은 거부한다", () => {
    expect(validateTitle("가방 샤넬st 토트백", "generation").errors.join()).toContain("모조품");
  });

  it("영문 정상 단어(Nest, Forest)는 통과한다 — 오탐 회귀 방지", () => {
    expect(validateTitle("Nest 온도조절기 거치대", "generation").errors).toHaveLength(0);
    expect(validateTitle("Forest 우드 도마", "generation").errors).toHaveLength(0);
    expect(validateTitle("Everest 등산 스틱", "generation").errors).toHaveLength(0);
  });

  it("반복 토큰과 동의어군 겹침을 거부한다", () => {
    expect(validateTitle("거치대 노트북 거치대", "generation").errors.join()).toContain("반복");
    expect(validateTitle("핸드폰 휴대폰 거치대", "generation").errors.join()).toContain("같은 뜻");
  });

  it("검증되지 않은 주장 표현을 거부한다", () => {
    expect(validateTitle("무독성 실리콘 매트", "generation").errors.join()).toContain("주장");
    expect(validateTitle("프리미엄 원목 트레이", "generation").errors.join()).toContain("주장");
  });

  it("길이는 바이트가 아니라 문자 수다", () => {
    const fifty = "가".repeat(50);
    expect(validateTitle(fifty, "generation").errors).toHaveLength(0);
    expect(validateTitle(`${fifty}가`, "generation").errors.join()).toContain("50자");
  });
});

describe("자동 보정", () => {
  it("위반을 제거하고 게이트를 재통과시킨다", () => {
    const repaired = repairTitle("노트북 거치대 무료배송 최저가", "노트북 거치대");
    expect(validateTitle(repaired.title, "registration").errors).toHaveLength(0);
    expect(repaired.title).toContain("노트북");
    expect(repaired.changed).toBe(true);
  });

  it("반복 토큰은 첫 등장만 남긴다", () => {
    const repaired = repairTitle("거치대 노트북 거치대", "노트북 거치대");
    expect(validateTitle(repaired.title, "registration").errors).toHaveLength(0);
  });

  it("전부 지워지면 폴백 상품군 명을 쓴다", () => {
    const repaired = repairTitle("최저가 무료배송 특가", "노트북 거치대");
    expect(repaired.title).toBe("노트북 거치대");
  });

  it("폴백마저 없으면 '상품'을 쓴다", () => {
    const repaired = repairTitle("최저가 무료배송", "");
    expect(repaired.title).toBe("상품");
  });

  it("영문 정상 단어를 지우지 않는다", () => {
    const repaired = repairTitle("Forest 우드 도마 무료배송", "우드 도마");
    expect(repaired.title).toContain("Forest");
  });
});
