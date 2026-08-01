import { writeFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import sharp from "sharp";
import { env } from "../env.js";
import { sleep } from "../commerce/http.js";
import { ensureListingAssetDirectory, listingAssetUrl } from "../store.js";
import { getImageClient } from "./image-suite.js";
import type { SellerConfig } from "../seller-config.js";
import type { DetailPanel, DetailPanelSpec, SectionRole } from "../../src/domain/types";

/**
 * ⚠ 예산 산수 주의: 패널 생성은 크리티컬 패스다.
 * "패널 예산 ≤ (목표 p95 − 에이전트+재료 실측)" 으로 역산해서 잡는다.
 * 초과해도 크래시가 아니라 저품질 완주(패널 일부 누락)가 실패 모드다.
 */
const PANEL_BUDGET_MS = 110_000;
const PANEL_CONCURRENCY = 6;
const PANEL_SIZE = "1024x1536";

/** 배경 연속성 — 전 패널이 같은 밝은 중성 배경을 가장자리까지 채운다. */
const PANEL_BACKGROUND = "#F7F6F3";

export const PANEL_LAYOUT: Record<SectionRole, string> = {
  hook: "Top third: large Korean headline centered on generous negative space; middle: the product staged as the hero with soft dramatic light; bottom: clean floor shadow.",
  problem:
    "Top band: Korean headline; body: the everyday situation this product resolves, staged in a realistic Korean home or workspace — muted, slightly dim tones; the product may sit small at the edge or be absent; keep the text zone uncluttered.",
  solution:
    "Upper band: Korean headline + subline with breathing room; below: the product presented as the clear answer — bright, ordered scene contrasting a calmer mood, product prominent.",
  feature:
    "Upper band: Korean headline + subline, left-aligned with breathing room; below: the product angled to showcase the named feature, with a subtle soft-focus environment.",
  usage:
    "Top band: Korean headline; body: the product in natural use in a realistic Korean lifestyle setting at a specific time of day; keep the text zone uncluttered.",
  detail:
    "Top band: Korean headline; body: macro close-up of the product's material, finish, or joint — shallow depth of field, texture-forward lighting.",
  trust:
    "Top: Korean headline; center: the product front-facing, clean catalog style; lower band: the Korean subline as a caption row.",
  closing:
    "Generous negative space; the product small and centered low like a signature; Korean headline floating above — quiet, warm, final.",
};

function buildPanelPrompt(spec: DetailPanelSpec, productName: string): string {
  return `Korean e-commerce detail-page panel (vertical 2:3) for: ${productName}.
${PANEL_LAYOUT[spec.role]}
Scene: ${spec.sceneHint}
Overlay Korean text — render EXACTLY these strings and nothing else:
HEADLINE: "${spec.headline}"
SUBLINE: "${spec.subline}"
Typography: clean modern Korean sans-serif, dark charcoal (#222) on light background,
headline bold and large, subline smaller and lighter. Perfect spelling of the given strings.
Background: seamless very light warm-neutral (${PANEL_BACKGROUND}) filling edge-to-edge, including the
very top and bottom edges, so consecutive panels connect without visible seams.
Product identity from the reference photo only: preserve exact shape, proportions, colors,
materials, printed logos. Do NOT invent any other readable text, labels, badges, or brand
marks. Do not alter the product.
Premium commercial detail-page aesthetic, crisp focus, soft realistic lighting.`;
}

export interface GenerateDetailPanelsInput {
  listingId: string;
  photoPaths: string[];
  productName: string;
  specs: DetailPanelSpec[];
  config: SellerConfig;
  onShotEvent: (label: string, payload: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface DetailPanelsResult {
  panels: DetailPanel[];
  warnings: string[];
}

async function prepareReference(photoPaths: string[]): Promise<Buffer> {
  for (const photoPath of photoPaths) {
    try {
      return await sharp(photoPath, { failOn: "none" })
        .rotate()
        .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      continue;
    }
  }
  throw new Error("패널 참조 사진을 준비하지 못했습니다.");
}

export async function generateDetailPanels(
  input: GenerateDetailPanelsInput,
): Promise<DetailPanelsResult> {
  const warnings: string[] = [];
  if (input.specs.length === 0) return { panels: [], warnings };
  if (!env.OPENAI_API_KEY) {
    return { panels: [], warnings: ["OPENAI_API_KEY 가 없어 상세 패널을 만들지 못했습니다."] };
  }

  const startedAt = Date.now();
  const directory = await ensureListingAssetDirectory(input.listingId);
  const reference = await prepareReference(input.photoPaths);
  const total = input.specs.length;
  const results: (DetailPanel | null)[] = new Array(total).fill(null);

  const renderPanel = async (position: number): Promise<void> => {
    if (input.signal?.aborted) return;
    const spec = input.specs[position];
    const panelStartedAt = Date.now();
    input.onShotEvent("image.panel_started", {
      role: spec.role,
      headline: spec.headline,
      index: position,
      total,
    });

    try {
      const response = await getImageClient().images.edit({
        model: env.OPENAI_IMAGE_MODEL,
        image: await toFile(reference, "reference.png", { type: "image/png" }),
        prompt: buildPanelPrompt(spec, input.productName),
        size: PANEL_SIZE as never,
        quality: input.config.media.quality as never,
        output_format: "jpeg",
        output_compression: 90,
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error("패널 응답이 비어 있습니다.");
      if (input.signal?.aborted) return;

      const filename = `panel-${position + 1}-${spec.role}.jpg`;
      const filePath = path.join(directory, filename);
      await writeFile(filePath, Buffer.from(b64, "base64"));
      const url = listingAssetUrl(input.listingId, filename);
      results[position] = {
        // sectionIndex 가 조립 시 서사 순서 정렬 기준이다.
        sectionIndex: spec.sectionIndex,
        role: spec.role,
        headline: spec.headline,
        filePath,
        url,
      };
      input.onShotEvent("image.panel_completed", {
        role: spec.role,
        headline: spec.headline,
        url,
        index: position,
        total,
        tookMs: Date.now() - panelStartedAt,
      });
    } catch (error) {
      console.warn(
        `[detail-panels] 패널 ${position} (${spec.role}) 실패:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  const queue = input.specs.map((_, index) => index);
  const workers = Array.from({ length: Math.min(PANEL_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const index = queue.shift();
      if (index === undefined) break;
      await renderPanel(index);
    }
  });

  const elapsed = (): number => Date.now() - startedAt;
  await Promise.race([Promise.all(workers), sleep(Math.max(1_000, PANEL_BUDGET_MS - elapsed()))]);

  const panels = results.filter((panel): panel is DetailPanel => panel !== null);
  if (panels.length < total) {
    // 예산 내 완성되지 않은 패널은 제외하고 경고를 남긴다.
    warnings.push(`상세 패널 ${total - panels.length}컷이 예산 안에 완성되지 않아 제외했습니다.`);
  }
  return { panels, warnings };
}
