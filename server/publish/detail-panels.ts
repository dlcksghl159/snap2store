import { writeFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import { env } from "../env.js";
import { sleep } from "../commerce/http.js";
import { ensureListingAssetDirectory, listingAssetUrl } from "../store.js";
import {
  MAX_REFERENCE_IMAGES,
  getImageClient,
  prepareReferences,
  type PreparedReference,
} from "./image-suite.js";
import type { SellerConfig } from "../seller-config.js";
import type { DetailPanel, DetailPanelSpec, SectionRole } from "../../src/domain/types";

/**
 * ⚠ 예산 산수 주의: 패널 생성은 크리티컬 패스다.
 * "패널 예산 ≤ (목표 p95 − 에이전트+재료 실측)" 으로 역산해서 잡는다.
 * 초과해도 크래시가 아니라 저품질 완주(패널 일부 누락)가 실패 모드다.
 */
function panelBudgetMs(quality: string): number {
  if (quality === "high") return 210_000;
  if (quality === "medium") return 150_000;
  return 110_000;
}
/**
 * 패널 동시 생성 상한 — 6컷 기본값을 **한 웨이브에** 다 굽고도 남는 값이다.
 * 4 였을 때는 6컷이 두 웨이브로 갈려 패널 구간이 샷 하나치의 두 배가 됐다.
 */
const PANEL_CONCURRENCY = 12;
/**
 * 세로 2:3. **픽셀을 줄여도 빨라지지 않는다** — 2026-08-02 실측(medium, 참조 3장, 2회 평균):
 *   672×1008 (0.68MP) 42.4s / 832×1248 (1.04MP) 46.9s / 1024×1536 (1.57MP) 46.7s
 * 픽셀을 57% 줄여 버는 시간이 4초뿐인데, 스마트스토어 상세 본문은 폭 ~860px 로 그려지므로
 * 672px 는 거기서 확대돼 물러진다. 지연은 크기가 아니라 **품질**이 지배한다.
 */
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

function buildPanelPrompt(
  spec: DetailPanelSpec,
  productName: string,
  referenceCount: number,
  hasAnchor: boolean,
): string {
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
The attached ${referenceCount} reference photos are ALL of the SAME single product, shot from
different angles — combine them into one consistent understanding of that exact object and never
blend in a different product.${
    hasAnchor
      ? "\nThe FIRST reference image is the APPROVED STUDIO HERO — the exact product rendering already used as this listing's thumbnail. It is authoritative: reproduce its colors, proportions, materials, finish and details identically so the detail page and the thumbnail read as one product. The other references only supply angles the hero does not show."
      : ""
  }
Product identity from the reference photos only: preserve exact shape, silhouette, proportions,
colors and their placement, materials, finish, part count, and printed logos. Do NOT invent any
other readable text, labels, badges, or brand marks. Do not alter, restyle, or recolor the product.
If a part of the product is not visible in the references, keep it out of frame — do not invent it.
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
  /** 스위트 대표 컷이 이미 완성돼 있으면 정체성 앵커로 함께 넘긴다 (기다리지 않는다). */
  anchorPath?: () => string | null;
}

export interface DetailPanelsResult {
  panels: DetailPanel[];
  warnings: string[];
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
  const budget = panelBudgetMs(input.config.media.panelQuality);
  const deadline = startedAt + budget;
  /*
    ⚠ 예산은 **결과 스냅샷 시점**과 같아야 한다.
    예전에는 예산이 끝나도 워커가 계속 돌아서, 늦게 완성된 패널이
    `image.panel_completed` 를 쏘았다. 그 패널은 이미 스냅샷된 결과에 없으므로
    무대에는 뜨는데 등록된 상세페이지에는 없는 유령 컷이 됐다.
  */
  const expired = (): boolean => Boolean(input.signal?.aborted) || Date.now() >= deadline;
  const directory = await ensureListingAssetDirectory(input.listingId);
  // 업로드한 사진 전부를 참조로 넘긴다 — 한 장만 넘기면 보이지 않던 면을 모델이 창작한다.
  const references = await prepareReferences(input.photoPaths);
  const total = input.specs.length;
  const results: (DetailPanel | null)[] = new Array(total).fill(null);

  const anchorFor = async (): Promise<PreparedReference | null> => {
    const anchor = input.anchorPath?.() ?? null;
    if (!anchor) return null;
    try {
      const [prepared] = await prepareReferences([anchor], 1);
      return prepared ? { ...prepared, name: "approved-hero.jpg" } : null;
    } catch {
      return null;
    }
  };

  const renderPanel = async (position: number): Promise<void> => {
    if (expired()) return;
    const spec = input.specs[position];
    const panelStartedAt = Date.now();
    const anchor = await anchorFor();
    // 승인된 썸네일을 **맨 앞**에 둔다 — 상세페이지는 썸네일과 같은 상품으로 읽혀야 한다.
    const panelReferences = (anchor ? [anchor, ...references] : references).slice(
      0,
      MAX_REFERENCE_IMAGES,
    );
    input.onShotEvent("image.panel_started", {
      role: spec.role,
      headline: spec.headline,
      index: position,
      total,
      referenceCount: panelReferences.length,
    });

    try {
      const response = await getImageClient().images.edit({
        model: env.OPENAI_IMAGE_MODEL,
        image: await Promise.all(
          panelReferences.map((reference) =>
            toFile(reference.buffer, reference.name, { type: "image/jpeg" }),
          ),
        ),
        prompt: buildPanelPrompt(spec, input.productName, panelReferences.length, Boolean(anchor)),
        size: PANEL_SIZE as never,
        quality: input.config.media.panelQuality as never,
        output_format: "jpeg",
        output_compression: 92,
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error("패널 응답이 비어 있습니다.");
      // 예산을 넘겨 도착했다 — 결과에도 넣지 않고 방송도 하지 않는다.
      if (expired()) return;

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
    // 예산이 끝나면 남은 일감을 새로 집지 않는다 — 버려질 그림을 굽지 않기 위해서다.
    while (queue.length > 0 && !expired()) {
      const index = queue.shift();
      if (index === undefined) break;
      await renderPanel(index);
    }
  });

  const elapsed = (): number => Date.now() - startedAt;
  await Promise.race([Promise.all(workers), sleep(Math.max(1_000, budget - elapsed()))]);

  const panels = results.filter((panel): panel is DetailPanel => panel !== null);
  if (panels.length < total) {
    // 예산 내 완성되지 않은 패널은 제외하고 경고를 남긴다.
    warnings.push(`상세 패널 ${total - panels.length}컷이 예산 안에 완성되지 않아 제외했습니다.`);
  }
  return { panels, warnings };
}
