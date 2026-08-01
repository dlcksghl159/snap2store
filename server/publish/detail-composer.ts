import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import type { DetailPlan, DetailSection, SpecFact } from "../../src/domain/types";

const ROLES = [
  "hook",
  "problem",
  "solution",
  "feature",
  "usage",
  "detail",
  "trust",
  "closing",
] as const;

const PlanSchema = z.object({
  concept: z.string().max(60),
  angle: z.string().max(80),
  headline: z.string().max(40),
  subheadline: z.string().max(70),
  hooks: z.array(z.object({ label: z.string().max(12), value: z.string().max(30) })).min(3).max(4),
  sections: z
    .array(
      z.object({
        role: z.enum(ROLES),
        heading: z.string().max(34),
        body: z.string().max(340),
        panel: z
          .object({
            headline: z.string().max(14),
            subline: z.string().max(26),
            sceneHint: z.string().max(160),
          })
          .nullable(),
      }),
    )
    .min(4)
    .max(8),
  closing: z.string().max(90),
});

const PLAN_JSON_SCHEMA = strictObject({
  concept: { type: "string", description: "이 상세페이지 전체를 지배할 컨셉 한 줄 (60자 이내)" },
  angle: { type: "string", description: "누구의 어떤 순간·문제를 겨냥하는가 (80자 이내)" },
  headline: { type: "string", description: "40자 이내" },
  subheadline: { type: "string", description: "70자 이내" },
  hooks: {
    type: "array",
    description: "3~4개",
    items: strictObject({
      label: { type: "string", description: "키워드 (12자 이내)" },
      value: { type: "string", description: "한 줄 (30자 이내)" },
    }),
  },
  sections: {
    type: "array",
    description: "6~8개. hook 이 반드시 첫 번째, closing 이 마지막.",
    items: strictObject({
      role: { type: "string", enum: [...ROLES] },
      heading: { type: "string", description: "34자 이내" },
      body: { type: "string", description: "340자 이내" },
      panel: {
        anyOf: [
          strictObject({
            headline: { type: "string", description: "이미지 위에 인쇄될 한글 문구 (14자 이내)" },
            subline: { type: "string", description: "이미지 위에 인쇄될 한글 문구 (26자 이내)" },
            sceneHint: { type: "string", description: "영어로 장면 묘사 (160자 이내)" },
          }),
          { type: "null" },
        ],
      },
    }),
  },
  closing: { type: "string", description: "90자 이내" },
});

function buildSystem(panelTarget: number, evidenceRich: boolean): string {
  return `당신은 한국 커머스 상세페이지의 기획자이자 카피라이터입니다. 이 상품을 정말
팔아야 하는 판매자의 확신으로 일합니다.

먼저 기획하고, 그다음 씁니다:
1) concept — 이 상세페이지 전체를 지배할 컨셉 한 줄을 선언합니다
   (예: "아침 책상 위의 1kg 미니멀리즘").
2) angle — 누구의 어떤 순간·문제를 겨냥하는지 판매 각도를 확정합니다.
3) sections — 그 컨셉이 위에서 아래로 한 호흡에 읽히는 서사를 씁니다.
   역할(role)을 명시한 6~8개 섹션:
   - hook: 첫 화면. 구매 욕구를 여는 강한 장면 (반드시 1개, 첫 번째).
   - problem 또는 solution: 공감되는 불편 → 이 상품이 바꾸는 것.
   - feature: 눈에 보이는 만듦새·구조가 주는 실제 가치 (1~2개).
   - usage: 구체적인 생활 사용 장면 (아침/퇴근 후/주말 등 시간대와 공간을 그려라).
   - detail: 재질·마감·디테일 클로즈업 서사.
   - trust: 구성·관리법·이런 분께 — 신뢰를 닫는 섹션.
   - closing: 마지막 설득 (마지막 섹션).
   각 섹션은 앞 섹션을 반복하지 않고 서사를 전진시킵니다. 같은 가치를 두 번 말하지 마세요.

과감성 규칙: 근거가 사진뿐이어도 위축되지 않습니다. 관찰 가능한 특징(형태·재질감·
구성·마감)에서 출발해 상품군의 보편 가치와 구체적 생활 장면을 단정형으로 그리세요.
"~일 수 있습니다", "~로 보입니다" 같은 회피 표현 금지.
날조 금지 규칙: 검증되지 않은 수치 스펙·인증·브랜드·수상·의료/안전 효능은 쓰지
않습니다. 최상급 단정("최고", "1위", "프리미엄")과 배송/할인 언급 금지.

패널 설계: 정확히 ${panelTarget}개 섹션에 panel(세로 이미지 연출)을 설계합니다 —
hook 섹션은 반드시 포함. panel.headline(≤14자)과 panel.subline(≤26자)은 이미지 위에
그대로 인쇄될 한글 문구입니다: 짧고 강하게, 맞춤법 완벽하게, 이 기획에 있는 사실·
표현만. sceneHint는 영어로 그 섹션의 장면을 구체적으로 묘사합니다(배경·소품·조명·구도).
나머지 섹션은 panel: null.

hooks 3~4개: 짧은 소구 포인트(label=키워드, value=한 줄). headline은 concept를
구매자 언어로 옮긴 한 줄(상품명 반복 금지), subheadline은 그것을 받치는 구체적 한 줄.
${
    evidenceRich
      ? "근거(스펙·라벨 전사)가 충분합니다 — 근거의 사실을 서사의 뼈대로 쓰세요."
      : "근거가 사진 관찰뿐입니다 — 구체 수치 없이, 관찰과 상품군 보편 가치로 확신 있는 서사를 만드세요."
  }`;
}

export interface ComposeDetailPlanInput {
  productTitle: string;
  productGroup: string;
  summary: string;
  agentSections: DetailSection[];
  specFacts: SpecFact[];
  labelTexts: string[];
  sellerNote: string | null;
  panelTarget: number;
  imageDataUrl?: string | null;
}

/** 기획 실패는 null 반환. 오케스트레이터가 기본 상세 레이아웃으로 폴백하고 런은 계속된다. */
export async function composeDetailPlan(input: ComposeDetailPlanInput): Promise<DetailPlan | null> {
  const evidenceRich = input.specFacts.length + input.labelTexts.length >= 3;

  const userLines = [
    `상품명: ${input.productTitle}`,
    `상품군: ${input.productGroup}`,
    `요약: ${input.summary}`,
    input.agentSections.length > 0
      ? `에이전트 관찰 섹션:\n${input.agentSections.map((section) => `- ${section.heading}: ${section.body}`).join("\n")}`
      : "에이전트 관찰 섹션: 없음",
    input.specFacts.length > 0
      ? `확정 스펙: ${input.specFacts.map((fact) => `${fact.label}=${fact.value}`).join(" / ")}`
      : "확정 스펙: 없음",
    input.labelTexts.length > 0
      ? `라벨 전사: ${input.labelTexts.slice(0, 20).join(" | ")}`
      : "라벨 전사: 없음",
    input.sellerNote
      ? `판매자 추가 정보: ${input.sellerNote}\n(판매자 제공 사실입니다 — 컨셉과 서사에 적극 반영하세요.)`
      : "판매자 추가 정보: 없음",
    `세로 패널 설계 수: ${input.panelTarget}`,
  ];

  try {
    const plan = await requestOpenAiJson({
      system: buildSystem(input.panelTarget, evidenceRich),
      user: userLines.join("\n"),
      imageUrls: input.imageDataUrl ? [input.imageDataUrl] : undefined,
      schemaName: "detail_plan",
      jsonSchema: PLAN_JSON_SCHEMA,
      validator: PlanSchema,
      reasoningEffort: "low",
    });
    return plan as DetailPlan;
  } catch (error) {
    console.warn("[detail-composer] 기획 실패:", error instanceof Error ? error.message : error);
    return null;
  }
}
