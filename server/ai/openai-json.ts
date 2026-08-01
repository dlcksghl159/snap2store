import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env.js";

let client: OpenAI | null = null;

export function getJsonClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 90_000, maxRetries: 2 });
  }
  return client;
}

export interface OpenAiJsonInput<T> {
  /** 정적 부분을 앞에 → 프리픽스 캐싱에 유리. */
  system: string;
  user: string;
  /** data URL 또는 https. 항상 detail: "low" 로 첨부한다. */
  imageUrls?: string[];
  schemaName: string;
  /** additionalProperties:false, required 전 필드. */
  jsonSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/**
 * strict JSON Schema 로 구조화 출력을 강제하고 zod 로 한 번 더 검증하는 단발 호출.
 *
 * 이미지는 항상 detail: "low". 이 헬퍼를 쓰는 판단은 "이게 무슨 종류의 물건인지"만
 * 보면 되므로 고해상도가 필요 없다. 사진에서 글자를 읽어야 하는 것은 에이전트 본체뿐이고,
 * 거기서만 detail: "high" 를 쓴다.
 */
export async function requestOpenAiJson<T>(input: OpenAiJsonInput<T>): Promise<T> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY 가 없습니다.");

  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: input.user }];
  for (const url of input.imageUrls ?? []) {
    content.push({ type: "input_image", image_url: url, detail: "low" });
  }

  const response = await getJsonClient().responses.create({
    model: input.model ?? env.OPENAI_MODEL,
    reasoning: { effort: input.reasoningEffort ?? "low" },
    input: [
      { role: "system", content: [{ type: "input_text", text: input.system }] },
      { role: "user", content },
    ] as never,
    text: {
      format: {
        type: "json_schema",
        name: input.schemaName,
        schema: input.jsonSchema,
        strict: true,
      },
    },
  });

  const raw = extractText(response);
  if (!raw) throw new Error(`${input.schemaName}: 모델이 빈 응답을 반환했습니다.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${input.schemaName}: JSON 파싱 실패 — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return input.validator.parse(parsed);
}

function extractText(response: unknown): string {
  const record = response as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }
  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      const content = (item as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === "string") chunks.push(text);
      }
    }
    return chunks.join("");
  }
  return "";
}

/**
 * 창작 텍스트의 길이 상한 — **자르되 버리지 않는다**.
 *
 * ⚠ OpenAI 구조화 출력의 JSON Schema 는 `maxLength` 를 강제하지 않는다. 글자수는
 * description 으로 부탁하는 것이 전부라서 모델은 일상적으로 몇 십 자를 넘긴다.
 * 그 필드에 `z.string().max(n)` 을 걸면 초과 한 건이 **응답 전체**를 폐기시킨다 —
 * 실측으로 sceneHint 6개가 160자를 넘겨 상세 기획(컨셉·서사·패널 8섹션)이
 * 통째로 사라졌고, 그 런은 상세페이지 없이 등록됐다.
 *
 * 길이는 취향이고 구조(역할·개수·enum)는 계약이다. 취향 위반으로 계약을 깨지 않는다.
 */
export function softMaxString(max: number) {
  return z.string().transform((value) => clipText(value, max));
}

/**
 * 목록 길이의 상한 — 문자열과 같은 이유로 **자르되 버리지 않는다**.
 *
 * 실측으로 이것도 터졌다: 상품명 분해의 `expressions` 가 6개 상한을 한 칸 넘겨
 * 분해 전체가 거부됐고, 그 런은 SEO 상품명 대신 에이전트 평문 제목으로 등록됐다.
 * "몇 개까지"는 취향이고, 최소 개수(`min`)와 항목의 모양이 계약이다.
 */
export function softMaxArray<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z
    .array(item)
    .min(min)
    .transform((values) => values.slice(0, max));
}

/** 문장 끝 → 어절 끝 순으로 물러나며 자른다. 너무 많이 잘려 나가면 그냥 상한에서 끊는다. */
export function clipText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const floor = max * 0.6;
  const sentence = Math.max(
    head.lastIndexOf("."),
    head.lastIndexOf("!"),
    head.lastIndexOf("?"),
    head.lastIndexOf("。"),
  );
  if (sentence >= floor) return head.slice(0, sentence + 1).trim();
  const space = head.lastIndexOf(" ");
  if (space >= floor) return head.slice(0, space).trim();
  return head.trim();
}

/** strict JSON Schema 헬퍼 — required 는 전 필드, additionalProperties 는 false 여야 한다. */
export function strictObject(
  properties: Record<string, unknown>,
  options: { description?: string } = {},
): Record<string, unknown> {
  return {
    type: "object",
    ...(options.description ? { description: options.description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
