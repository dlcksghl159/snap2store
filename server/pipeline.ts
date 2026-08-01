import { appendEvent, setStage } from "./events.js";
import { getListing, updateListing } from "./store.js";
import { loadSellerConfig } from "./seller-config.js";
import { env } from "./env.js";
import { runListingAgent, type AgentToolOutcomes } from "./agent.js";
import { generateImageSuite } from "./publish/image-suite.js";
import { orchestrateListing } from "./publish/orchestrator.js";
import type { ImageSuiteResult, ListingDraft, ListingResolution } from "../src/domain/types";

export interface RunPipelineInput {
  listingId: string;
  resumeFromDraft?: boolean;
  resolution?: ListingResolution | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runPipeline(input: RunPipelineInput): Promise<void> {
  const { listingId, resumeFromDraft = false, resolution = null } = input;
  const listing = await getListing(listingId);
  if (!listing) return;

  const config = loadSellerConfig();
  // 거부 판정이 나면 연출컷 생성을 즉시 끊는다 —
  // "거부한다면서 연출컷은 왜 만들었나"를 설계로 막는다.
  const suiteAbort = new AbortController();

  try {
    await setStage(listingId, "vision", 8, "사진을 읽고 있습니다");

    /**
     * 이미지 스위트 프리워밍 — 파이프라인 최장 구간이므로 가장 먼저 시작한다.
     * await 하지 않는다. .catch() 를 반드시 감는다 (unhandled rejection 방지).
     * 샷 플랜 LLM 에 참조 사진을 직접 첨부하므로 상품명 없이도 장면을 설계할 수 있다.
     */
    const imageSuitePromise: Promise<ImageSuiteResult> = generateImageSuite({
      listingId,
      photoPaths: listing.photoPaths,
      productName: "",
      categoryQuery: "",
      summary: "",
      specFacts: [],
      config,
      signal: suiteAbort.signal,
    }).catch((error: unknown): ImageSuiteResult => ({
      main: null,
      gallery: [],
      detailCuts: [],
      warnings: [`이미지 연출 실패: ${message(error)}`],
    }));

    let draft: ListingDraft;
    let toolOutcomes: AgentToolOutcomes | null = null;

    if (resumeFromDraft && listing.draft) {
      draft = listing.draft;
      await appendEvent(listingId, {
        source: "runtime",
        kind: "milestone",
        label: "저장된 등록안으로 재실행",
        payload: { title: draft.title },
      }).catch(console.warn);
    } else {
      if (!env.useOpenAI || !env.OPENAI_API_KEY) {
        throw new Error(
          "OPENAI_API_KEY 가 설정되지 않아 에이전트를 실행할 수 없습니다. .env.local 을 확인하세요.",
        );
      }
      const agentRun = await runListingAgent({
        listingId,
        photoPaths: listing.photoPaths,
        sellerNote: listing.sellerNote,
        suitePromise: imageSuitePromise,
        config,
      });
      draft = agentRun.draft;
      toolOutcomes = agentRun.outcomes;
      await updateListing(listingId, (current) => ({ ...current, draft }));
    }

    if (draft.riskLevel === "high") {
      suiteAbort.abort();
    }

    await orchestrateListing({
      listingId,
      draft,
      photoPaths: listing.photoPaths,
      photoUrls: listing.photoUrls,
      resolution,
      mode: env.SMARTSTORE_MODE,
      sellerNote: listing.sellerNote,
      imageSuitePromise,
      toolOutcomes,
      config,
    });
  } catch (error) {
    suiteAbort.abort();
    const reason = message(error);
    console.error(`[pipeline] ${listingId} 실패:`, error);
    await appendEvent(listingId, {
      source: "runtime",
      kind: "error",
      label: "파이프라인 실패",
      payload: { message: reason },
    }).catch(console.warn);
    await updateListing(listingId, (current) => ({
      ...current,
      status: "failed",
      stage: "failed",
      stageLabel: "실행 실패",
      progress: 100,
      error: reason,
    })).catch(console.warn);
  }
}
