import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  Agent,
  Runner,
  setDefaultOpenAIClient,
  tool,
  webSearchTool,
  type AgentInputItem,
} from "@openai/agents";
import OpenAI from "openai";
import sharp from "sharp";
import { env } from "./env.js";
import { appendEvent, emitLiveOnly, sanitizePayload } from "./events.js";
import { ListingDraftSchema } from "./schemas.js";
import { matchCategory } from "./materials/category-match.js";
import { resolvePrice } from "./materials/pricing.js";
import type { SellerConfig } from "./seller-config.js";
import type {
  CategoryMatchResult,
  ImageSuiteResult,
  ListingDraft,
  PriceResolution,
} from "../src/domain/types";

/* ── 1.1 커스텀 OpenAI 클라이언트 (필수) ────────────────────────
 *
 * Agents SDK 는 멀티턴에서 대화 이력을 되돌려 보낼 때 hosted tool 항목에
 * 서버가 붙여준 `action` 필드를 그대로 싣는다. Responses API 입력 스키마는 이를 거부한다:
 *   400 Unknown parameter: 'input[N].action'
 * `computer_call` 의 action 은 정당한 입력이므로 건드리지 않는다.
 */
const STRIP_ACTION_ITEM_TYPES = new Set(["web_search_call", "image_generation_call"]);

export function sanitizeResponsesRequestBody(body: string): string {
  const parsed = JSON.parse(body) as { input?: unknown };
  if (!Array.isArray(parsed.input)) return body;
  let changed = false;
  for (const item of parsed.input) {
    if (
      item &&
      typeof item === "object" &&
      STRIP_ACTION_ITEM_TYPES.has((item as { type?: string }).type ?? "") &&
      "action" in (item as Record<string, unknown>)
    ) {
      delete (item as Record<string, unknown>).action;
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : body;
}

let clientConfigured = false;

function ensureAgentClient(): void {
  if (clientConfigured) return;
  clientConfigured = true;
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      let nextInit = init;
      if (
        init?.method === "POST" &&
        typeof init.body === "string" &&
        String(url).includes("/responses")
      ) {
        try {
          nextInit = { ...init, body: sanitizeResponsesRequestBody(init.body) };
        } catch {
          /* 파싱 실패 시 원본 그대로 */
        }
      }
      return fetch(url as never, nextInit as never);
    }) as never,
  });
  setDefaultOpenAIClient(client);
}

/* ── 도구 산출물 재사용 계약 ────────────────────────────────── */

export interface AgentToolOutcomes {
  category: CategoryMatchResult | null;
  price: PriceResolution | null;
  suite: ImageSuiteResult | null;
}

export interface RunListingAgentInput {
  listingId: string;
  photoPaths: string[];
  sellerNote: string | null;
  suitePromise: Promise<ImageSuiteResult>;
  config: SellerConfig;
}

export interface RunListingAgentResult {
  draft: ListingDraft;
  outcomes: AgentToolOutcomes;
}

/** 영속 스토어에는 굵은 것만 남긴다 — 고빈도 raw 델타는 버스에만. */
const PERSISTED_RAW_TYPES = new Set(["response_started", "response_done"]);

let cachedInstructions: string | null = null;

async function loadInstructions(): Promise<string> {
  if (cachedInstructions) return cachedInstructions;
  // 파일로 두고 읽는다 — 코드 재배포 없이 고칠 수 있어야 한다.
  cachedInstructions = await readFile(path.join(env.projectRoot, "docs", "prompt.md"), "utf8");
  return cachedInstructions;
}

async function toReferenceDataUrl(photoPath: string): Promise<string | null> {
  try {
    const buffer = await sharp(photoPath, { failOn: "none" })
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

const SELLER_NOTE_BLOCK = (note: string): string => `

판매자가 직접 적어 준 추가 정보:
"""
${note}
"""
이 텍스트는 판매자 제공 사실이다 — 사진과 모순되지 않는 한 신뢰하고 등록안
(상품 파악·스펙·상세·검색어)에 적극 반영하라. 단, 브랜드·모델 정체성 주장은
여전히 웹 검증을 거쳐야 brandVerified가 된다. 판매자 제공 사실은 facts에
kind "configured"로 기록하라.`;

export async function runListingAgent(
  input: RunListingAgentInput,
): Promise<RunListingAgentResult> {
  ensureAgentClient();
  const { listingId } = input;

  const outcomes: AgentToolOutcomes = { category: null, price: null, suite: null };

  // ⚠ 스위트 프라미스를 await 하지 않는다. .then() 으로 스냅샷만 채워 둔다 —
  //   도구가 await 하면 지연이 30~50초 늘어난다. 최종 조인은 서버가 한다.
  let suiteSnapshot: ImageSuiteResult | null = null;
  void input.suitePromise.then((result) => {
    suiteSnapshot = result;
    outcomes.suite = result;
  });

  const referenceDataUrl = input.photoPaths.length > 0 ? await toReferenceDataUrl(input.photoPaths[0]) : null;

  /* ── 2.1 resolve_category ── */
  const resolveCategoryTool = tool({
    name: "resolve_category",
    description:
      "Match the product to the real Naver SmartStore sales category. Searches the official Naver catalog for comparable product models, votes on where they are actually shelved, and runs an LLM verification loop that retries with new keywords on MISMATCH. Call once you know the product-group shelf name; call again with a better name if the result looks wrong.",
    parameters: z.object({
      productGroupName: z
        .string()
        .describe("한국 쇼핑객이 검색하는 상품군 명사구 (예: '노트북 거치대')"),
      productSummary: z.string().describe("상품 한 줄 설명"),
    }),
    execute: async ({ productGroupName, productSummary }) => {
      const result = await matchCategory({
        productGroupName,
        productSummary,
        imageDataUrl: referenceDataUrl,
      });
      outcomes.category = result;
      return {
        outcome: result.outcome,
        categoryPath: result.categoryName,
        verificationRounds: result.attempts.length,
        verdicts: result.attempts.map((attempt) => ({
          round: attempt.round,
          categoryPath: attempt.categoryName,
          verdict: attempt.verdict,
          reason: attempt.reason,
        })),
        comparableListings: result.compsSample.length,
        topCandidates: result.candidates.slice(0, 5).map((candidate) => ({
          categoryPath: candidate.categoryName,
          votes: Number(candidate.votes.toFixed(1)),
        })),
      };
    },
  });

  /* ── 2.2 research_market_price ── */
  const researchPriceTool = tool({
    name: "research_market_price",
    description:
      "Derive the sale price. Uses the comparable price distribution when market prices are available (IQR outlier removal, conservative percentile); otherwise your estimatedPriceKrw becomes the listed price — estimate carefully from what the product visibly is, at realistic Korean retail level. Call after resolve_category.",
    parameters: z.object({
      searchQuery: z.string().describe("시세 검색어 (상품군 명사구)"),
      estimatedPriceKrw: z.number().describe("사진과 상식으로 추정한 판매가"),
    }),
    execute: async ({ searchQuery, estimatedPriceKrw }) => {
      const result = await resolvePrice({
        comps: outcomes.category?.compsSample ?? [],
        searchQuery,
        // estimatedPriceKrw >= 100 일 때만 에이전트 추정으로 인정한다.
        estimatedPriceKrw: estimatedPriceKrw >= 100 ? Math.round(estimatedPriceKrw) : null,
        config: input.config,
      });
      outcomes.price = result;
      return {
        resolved: result.resolved,
        salePriceKrw: result.salePrice,
        basis: result.priceBasis,
        sampleSize: result.sampleSize,
      };
    },
  });

  /* ── 2.3 generate_image_suite — 논블로킹 스냅샷 ── */
  const imageSuiteTool = tool({
    name: "generate_image_suite",
    description:
      "Check on the staged commercial image set (studio main + lifestyle/usage/closeup cuts) being produced from the uploaded photos with gpt-image-2. Generation was pre-warmed at upload time; this returns current progress without blocking. Call once before finishing to confirm what will ship.",
    parameters: z.object({}),
    execute: async () => {
      const snapshot = suiteSnapshot;
      if (!snapshot) {
        return {
          status: "generating",
          note: "이미지 연출이 백그라운드에서 생성 중 — 서버가 등록 전에 조인합니다.",
        };
      }
      return {
        status: "ready",
        mainReady: Boolean(snapshot.main),
        galleryCount: snapshot.gallery.length,
        detailCutCount: snapshot.detailCuts.length,
        kinds: [snapshot.main?.kind, ...snapshot.gallery.map((image) => image.kind)].filter(Boolean),
      };
    },
  });

  const agent = new Agent({
    name: "Snap2Store Listing Agent",
    instructions: await loadInstructions(),
    model: env.OPENAI_MODEL,
    modelSettings: {
      // 지연 예산의 핵심 레버.
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      // 독립 도구를 같은 턴에 부를 수 있게.
      parallelToolCalls: true,
    },
    tools: [
      resolveCategoryTool,
      researchPriceTool,
      imageSuiteTool,
      webSearchTool({ searchContextSize: "low" }),
    ],
    outputType: ListingDraftSchema,
  });

  /* ── 1.4 입력 조립 ── */
  const images = await Promise.all(
    input.photoPaths.slice(0, 10).map(async (photoPath) => {
      try {
        return await readFile(photoPath);
      } catch {
        return null;
      }
    }),
  );

  const agentInput: AgentInputItem[] = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            "첨부한 사진들의 판매 상품으로 스마트스토어 등록안을 완성하세요. " +
            "보통은 같은 상품의 여러 컷이지만, 서로 다른 상품이 섞여 있다고 판단되면 " +
            "지침대로 대표 상품 하나를 골라 진행하고 그 사실을 기록하세요. " +
            "라벨·패키지의 글자는 빠짐없이 옮겨 적으세요." +
            (input.sellerNote ? SELLER_NOTE_BLOCK(input.sellerNote) : ""),
        },
        ...images
          .filter((buffer) => buffer !== null)
          .map((buffer) => ({
            type: "input_image" as const,
            image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
            // 사진에서 글자를 읽어야 하는 것은 에이전트 본체뿐이다 — 여기서만 high.
            detail: "high" as const,
          })),
      ],
    },
  ] as AgentInputItem[];

  const runner = new Runner({
    workflowName: "Snap2Store photo-to-listing",
    groupId: listingId,
    traceIncludeSensitiveData: false,
  });

  const stream = await runner.run(agent, agentInput, {
    stream: true,
    context: { listingId, photoCount: input.photoPaths.length },
    maxTurns: 10,
  });

  /* ── 3. 스트리밍 이벤트 중계 ──
   * ⚠ raw 이벤트 타입명 필터를 짜지 않는다. 전부 흘린 뒤 타입명을 라벨로 쓴다 —
   *   실제로 오는 값은 model / output_text_delta / response_started / response_done 이고,
   *   다른 문서에서 보이는 *.created / output_item.added 는 오지 않는다.
   */
  for await (const event of stream) {
    if (event.type === "raw_model_stream_event") {
      const data = (event as { data?: unknown }).data;
      const type = (data as { type?: string } | undefined)?.type ?? "model_event";
      emitLiveOnly(listingId, "openai_raw", type, sanitizePayload(data));
      if (PERSISTED_RAW_TYPES.has(type)) {
        await appendEvent(listingId, {
          source: "openai",
          kind: "model_event",
          label: type,
          payload: sanitizePayload(data) as Record<string, unknown>,
        }).catch(console.warn);
      }
      continue;
    }

    if (event.type === "run_item_stream_event") {
      const rawItem = (event.item.toJSON() as { rawItem?: unknown }).rawItem;
      const name =
        rawItem && typeof rawItem === "object" && "name" in rawItem
          ? String((rawItem as { name?: unknown }).name)
          : "tool";
      if (event.name === "tool_called") {
        await appendEvent(listingId, {
          source: "openai",
          kind: "tool_call",
          label: name,
          payload: sanitizePayload(rawItem) as Record<string, unknown>,
        }).catch(console.warn);
      }
      if (event.name === "tool_output") {
        await appendEvent(listingId, {
          source: "openai",
          kind: "tool_result",
          label: name,
          payload: sanitizePayload(rawItem) as Record<string, unknown>,
        }).catch(console.warn);
      }
    }
  }

  await stream.completed;
  if (stream.error) throw stream.error;
  const output = stream.finalOutput;
  if (!output) throw new Error("에이전트가 등록안을 반환하지 않았습니다.");

  return { draft: ListingDraftSchema.parse(output) as ListingDraft, outcomes };
}
