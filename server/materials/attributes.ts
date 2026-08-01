import { z } from "zod";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import {
  fetchProductAttributeValues,
  fetchProductAttributes,
  type NaverProductAttribute,
  type NaverProductAttributeValue,
} from "../commerce/client.js";
import type { AppliedAttribute, AttributeAnalysis, SpecFact } from "../../src/domain/types";

const MAX_APPLIED = 30;
const MAX_VALUES_IN_PROMPT = 60;
const AUTO_APPLY_CONFIDENCE = 0.8;

const PickSchema = z.object({
  attributeValueSeq: z.number().int(),
  realValue: z.string().max(60),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().max(8)).max(8),
});
const DecisionSchema = z.object({
  attributeSeq: z.number().int(),
  picks: z.array(PickSchema).max(8),
});
const AnalysisSchema = z.object({ decisions: z.array(DecisionSchema).max(200) });

const ANALYSIS_JSON_SCHEMA = strictObject({
  decisions: {
    type: "array",
    description:
      "카탈로그의 모든 속성이 카탈로그 순서대로 정확히 한 번씩 등장해야 한다. 해당 없으면 picks 는 빈 배열.",
    items: strictObject({
      attributeSeq: { type: "integer" },
      picks: {
        type: "array",
        items: strictObject({
          attributeValueSeq: { type: "integer", description: "선택 속성의 값 seq. RANGE 속성이면 0." },
          realValue: { type: "string", description: "RANGE 속성일 때의 실측값 문자열. 아니면 빈 문자열." },
          confidence: { type: "number", description: "0~1" },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
            description: "인용한 근거 ID (t1, s2, l3 …). 근거 없으면 빈 배열.",
          },
        }),
      },
    }),
  },
});

/**
 * confidence 루브릭을 프롬프트에 명시해야 캘리브레이션된다.
 * 빼면 모델이 전부 0.7 근처를 찍어 게이트가 무의미해진다.
 */
const RUBRIC = `confidence 채점 기준:
- 근거 텍스트에 값이 그대로 또는 명백한 동의어·번역으로 등장 (알루미늄↔aluminum) = 0.9
- 근거의 사실에서 한 단계 직접 도출 ("2단 힌지 접이식" → 접이형) = 0.85
- 화면에 보이거나 그럴듯하지만 텍스트 근거 없음 = 0.5`;

function buildCatalogPrompt(
  attributes: NaverProductAttribute[],
  valuesBySeq: Map<number, NaverProductAttributeValue[]>,
): string {
  const lines: string[] = [];
  for (const attribute of attributes) {
    const values = valuesBySeq.get(attribute.attributeSeq) ?? [];
    const kind = attribute.attributeClassificationType ?? "SINGLE_SELECT";
    const limit =
      kind === "MULTI_SELECT" ? (attribute.attributeValueMaxMatchingCount ?? 3) : kind === "RANGE" ? 1 : 1;
    lines.push(`## ${attribute.attributeSeq} · ${attribute.attributeName ?? "이름 없음"} (${kind}, 최대 ${limit}개)`);
    if (kind === "RANGE") {
      lines.push("  값: 실측 수치를 realValue 에 문자열로 적는다 (attributeValueSeq 는 0).");
      continue;
    }
    const shown = values.slice(0, MAX_VALUES_IN_PROMPT);
    if (values.length > MAX_VALUES_IN_PROMPT) {
      lines.push(`  (값 ${values.length}개 중 앞 ${MAX_VALUES_IN_PROMPT}개)`);
    }
    for (const value of shown) {
      const name = value.attributeValueName ?? value.valueName ?? "";
      if (!name) continue;
      lines.push(`  - ${value.attributeValueSeq}: ${name}`);
    }
  }
  return lines.join("\n");
}

export interface AttributeInput {
  categoryId: string;
  productTitle: string;
  productGroup: string;
  summary: string;
  specFacts: SpecFact[];
  labelTexts: string[];
}

const EMPTY: AttributeAnalysis = { applied: [], reviewed: 0, warnings: [] };

export async function analyzeProductAttributes(input: AttributeInput): Promise<AttributeAnalysis> {
  const warnings: string[] = [];

  let attributes: NaverProductAttribute[];
  let values: NaverProductAttributeValue[];
  try {
    [attributes, values] = await Promise.all([
      fetchProductAttributes(input.categoryId),
      fetchProductAttributeValues(input.categoryId),
    ]);
  } catch (error) {
    return { ...EMPTY, warnings: [`상품속성 카탈로그 조회 실패: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (attributes.length === 0) return EMPTY;

  const valuesBySeq = new Map<number, NaverProductAttributeValue[]>();
  for (const value of values) {
    const list = valuesBySeq.get(value.attributeSeq) ?? [];
    list.push(value);
    valuesBySeq.set(value.attributeSeq, list);
  }

  // 근거 조립 — 라벨에서 글자로 읽힌 것은 텍스트 근거로 인정한다.
  const evidence = new Map<string, string>();
  evidence.set("t1", `상품명: ${input.productTitle}`);
  evidence.set("t2", `상품군: ${input.productGroup}`);
  evidence.set("t3", `요약: ${input.summary}`);
  input.specFacts.slice(0, 12).forEach((fact, index) => {
    evidence.set(`s${index + 1}`, `스펙 ${fact.label}: ${fact.value}`);
  });
  input.labelTexts.slice(0, 20).forEach((text, index) => {
    evidence.set(`l${index + 1}`, `라벨 전사: ${text}`);
  });

  // ⚠ 정적 프롬프트에 카탈로그 전문을 싣는다 — 카테고리별로 바이트가 동일해 프리픽스 캐싱이 걸린다.
  const system = `당신은 네이버 스마트스토어 상품속성 매칭 담당자입니다.

출력 계약(반드시 지킬 것): 아래 카탈로그의 모든 속성이 카탈로그 순서대로 정확히 한 번씩
decisions 배열에 등장해야 합니다. 해당 없는 속성은 picks 를 빈 배열로 둡니다.
절대 조기 종료하지 마세요.

근거에 없는 값을 지어내지 마세요. 근거 ID를 evidenceIds 에 인용합니다.

${RUBRIC}

# 속성 카탈로그
${buildCatalogPrompt(attributes, valuesBySeq)}`;

  const user = [
    "# 근거",
    ...[...evidence.entries()].map(([id, text]) => `${id}. ${text}`),
  ].join("\n");

  let analysis: z.infer<typeof AnalysisSchema>;
  try {
    analysis = await requestOpenAiJson({
      system,
      user,
      schemaName: "product_attribute_decisions",
      jsonSchema: ANALYSIS_JSON_SCHEMA,
      validator: AnalysisSchema,
      // 파이프라인의 유일한 예외 — 속성 매칭은 카탈로그 수십 개 항목을 근거와 교차 대조해야 해서
      // low 에서는 전수 순회 자체가 무너진다. 이 호출은 크리티컬 패스가 아니다.
      reasoningEffort: "medium",
    });
  } catch (error) {
    return { ...EMPTY, warnings: [`상품속성 분석 실패: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const attributeBySeq = new Map(attributes.map((attribute) => [attribute.attributeSeq, attribute]));
  const valueBySeqPair = new Map<string, NaverProductAttributeValue>();
  for (const value of values) valueBySeqPair.set(`${value.attributeSeq}:${value.attributeValueSeq}`, value);

  const applied: AppliedAttribute[] = [];
  const usedPairs = new Set<string>();
  let reviewed = 0;
  let discarded = 0;

  for (const decision of analysis.decisions) {
    const attribute = attributeBySeq.get(decision.attributeSeq);
    if (!attribute) {
      discarded += 1;
      continue;
    }
    const kind = attribute.attributeClassificationType ?? "SINGLE_SELECT";
    const limit =
      kind === "MULTI_SELECT" ? Math.max(1, attribute.attributeValueMaxMatchingCount ?? 3) : 1;
    let takenForAttribute = 0;

    for (const pick of decision.picks) {
      reviewed += 1;
      // 자동 적용 게이트: confidence ≥ 0.8 AND 인용한 근거 ID ≥ 1.
      const citedValid = pick.evidenceIds.filter((id) => evidence.has(id));
      if (pick.confidence < AUTO_APPLY_CONFIDENCE || citedValid.length === 0) {
        discarded += 1;
        continue;
      }
      if (takenForAttribute >= limit || applied.length >= MAX_APPLIED) {
        discarded += 1;
        continue;
      }

      if (kind === "RANGE") {
        const realValue = pick.realValue.replace(/[^\d.~xX]/g, "").trim();
        if (!realValue) {
          discarded += 1;
          continue;
        }
        applied.push({
          attributeSeq: attribute.attributeSeq,
          attributeRealValue: realValue,
          ...(attribute.unitUsable && attribute.representativeUnitCode
            ? { attributeRealValueUnitCode: attribute.representativeUnitCode }
            : {}),
          attributeName: attribute.attributeName ?? String(attribute.attributeSeq),
          attributeValueName: realValue,
          confidence: pick.confidence,
        });
        takenForAttribute += 1;
        continue;
      }

      const pairKey = `${attribute.attributeSeq}:${pick.attributeValueSeq}`;
      const value = valueBySeqPair.get(pairKey);
      // 교차 배정(그 속성에 없는 attributeValueSeq)과 중복 쌍은 폐기한다.
      if (!value || usedPairs.has(pairKey)) {
        discarded += 1;
        continue;
      }
      usedPairs.add(pairKey);
      applied.push({
        attributeSeq: attribute.attributeSeq,
        attributeValueSeq: value.attributeValueSeq,
        attributeName: attribute.attributeName ?? String(attribute.attributeSeq),
        attributeValueName: value.attributeValueName ?? value.valueName ?? "",
        confidence: pick.confidence,
      });
      takenForAttribute += 1;
    }
  }

  if (discarded > 0) {
    warnings.push(`상품속성 ${discarded}건은 근거·신뢰도 게이트를 통과하지 못해 적용하지 않았습니다.`);
  }

  return { applied, reviewed, warnings };
}

/** 등록 페이로드용 productAttributes 배열. */
export function toProductAttributesPayload(applied: AppliedAttribute[]): Array<Record<string, unknown>> {
  return applied.map((entry) => ({
    attributeSeq: entry.attributeSeq,
    ...(entry.attributeValueSeq != null ? { attributeValueSeq: entry.attributeValueSeq } : {}),
    ...(entry.attributeRealValue ? { attributeRealValue: entry.attributeRealValue } : {}),
    ...(entry.attributeRealValueUnitCode
      ? { attributeRealValueUnitCode: entry.attributeRealValueUnitCode }
      : {}),
  }));
}
