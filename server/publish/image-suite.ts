import { writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { z } from "zod";
import { env } from "../env.js";
import { appendEvent } from "../events.js";
import { requestOpenAiJson, strictObject } from "../ai/openai-json.js";
import { sleep } from "../commerce/http.js";
import { ensureListingAssetDirectory, listingAssetUrl } from "../store.js";
import type { SellerConfig } from "../seller-config.js";
import type { ImageSuiteResult, ShotKind, SpecFact, SuiteImage } from "../../src/domain/types";

/** 갤러리 샷 동시 생성 — 429 는 SDK retry-after 가 흡수한다. */
const GEN_CONCURRENCY = 4;
/** ⚠ 816×816 은 gpt-image-2 의 최소 유효 정사각이다 (16의 배수 & 655,360px 이상). */
const GALLERY_SIZE = "816x816";
const MAIN_SIZE = "1024x1024";
/** gpt-image 계열은 참조 이미지를 최대 16장 받는다. */
export const MAX_REFERENCE_IMAGES = 16;

/** 품질이 올라가면 샷당 시간이 크게 늘어난다 — 예산도 함께 올린다. */
function suiteBudgetMs(quality: string, mainQuality: string): number {
  const worst = quality === "high" || mainQuality === "high" ? "high" : quality === "medium" || mainQuality === "medium" ? "medium" : "low";
  if (worst === "high") return 190_000;
  if (worst === "medium") return 120_000;
  return 70_000;
}

let imageClient: OpenAI | null = null;

/** ⚠ 240초 기본 타임아웃은 무대 예산과 양립 불가다. 샷당 상한을 건다. */
export function getImageClient(): OpenAI {
  if (!imageClient) {
    imageClient = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 150_000, maxRetries: 1 });
  }
  return imageClient;
}

/**
 * 보존 규칙 — 모든 생성 프롬프트에 붙인다.
 * 참조를 여러 장 넘기므로 "여러 각도의 같은 하나의 물건"임을 명시한다.
 * 이 문장이 없으면 모델이 참조들을 서로 다른 상품으로 읽고 특징을 섞는다.
 */
export const PRESERVATION_RULES = `The attached reference photos are ALL of the SAME single physical product,
photographed from different angles and distances. Combine them into one consistent
understanding of that exact object — never treat them as different products and never
blend features from more than one product.
Use the reference photos as the only source of product identity.
Preserve the product's exact shape, silhouette, proportions, colors, color placement,
materials, surface finish, textures, part count, and any printed logos or labels
physically on the product. The generated product must be recognizable as the very same
item a buyer would receive.
Remove promotional overlay text, watermarks, stickers, and price callouts that are not
physically part of the product.
Do NOT invent readable text, brand names, labels, badges, certificates, or UI overlays.
Do NOT change the number of products, redesign, recolor, restyle, or add invented
accessories, parts, or features.
If part of the product is outside the frame in the references, keep it outside the frame
or use a cropped composition — do not invent the unseen portion.
Professional commercial product photography, crisp focus on the product, natural realistic
lighting, high detail.`;

const SHOT_KINDS = ["main_studio", "alt_studio", "lifestyle", "usage", "closeup", "mood"] as const;

const ShotPlanSchema = z.object({
  shots: z
    .array(z.object({ kind: z.enum(SHOT_KINDS), scene: z.string().max(300) }))
    .min(1)
    .max(8),
});

const SHOT_PLAN_JSON_SCHEMA = strictObject({
  shots: {
    type: "array",
    items: strictObject({
      kind: { type: "string", enum: [...SHOT_KINDS] },
      scene: { type: "string", description: "영어로. 배경·환경·소품·조명·구도를 구체적으로." },
    }),
  },
});

const DEFAULT_MAIN_SCENE =
  "bright clean studio backdrop, the product filling most of the frame, soft even light with a subtle contact shadow";

/** 패딩 샷 풀 — 플랜이 목표 수보다 적게 올 때 순환하며 채운다. */
const PADDING_SHOTS: Array<{ kind: ShotKind; scene: string }> = [
  {
    kind: "lifestyle",
    scene:
      "styled in a fitting real-life Korean home or workspace with tasteful props, natural window light, aspirational but realistic",
  },
  {
    kind: "closeup",
    scene:
      "macro close-up of the product's most convincing detail — material texture and build quality, shallow depth of field",
  },
  {
    kind: "mood",
    scene:
      "hero shot on a minimal pedestal with dramatic soft key light, premium quiet atmosphere",
  },
  {
    kind: "usage",
    scene:
      "the product in natural use in its intended context, human presence only as needed, candid commercial style",
  },
  {
    kind: "alt_studio",
    scene: "studio shot from a different informative angle on a soft warm-gray background",
  },
];

export interface GenerateImageSuiteInput {
  listingId: string;
  photoPaths: string[];
  productName: string;
  categoryQuery: string;
  summary: string;
  specFacts: SpecFact[];
  config: SellerConfig;
  signal?: AbortSignal;
  /** 대표 컷이 정착하는 즉시 알린다 — 상세 패널이 이걸 앵커로 기다린다. */
  onHeroReady?: (filePath: string) => void;
}

export interface PreparedReference {
  buffer: Buffer;
  name: string;
}

/**
 * 업로드한 사진 **전부**를 참조로 준비한다.
 * 첫 장만 넘기면 여러 각도로 찍은 입력에서 보이지 않던 면을 모델이 창작해
 * 실제 상품과 다른 이미지가 나온다.
 */
export async function prepareReferences(
  photoPaths: string[],
  limit = MAX_REFERENCE_IMAGES,
): Promise<PreparedReference[]> {
  const references: PreparedReference[] = [];
  for (const [index, photoPath] of photoPaths.slice(0, limit).entries()) {
    try {
      const buffer = await sharp(photoPath, { failOn: "none" })
        .rotate()
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer();
      references.push({ buffer, name: `reference-${index + 1}.jpg` });
    } catch {
      continue;
    }
  }
  if (references.length === 0) throw new Error("참조 사진을 준비하지 못했습니다.");
  return references;
}

async function toUploadables(references: PreparedReference[]) {
  return Promise.all(
    references.map((reference) => toFile(reference.buffer, reference.name, { type: "image/jpeg" })),
  );
}

async function planShots(input: {
  references: PreparedReference[];
  productName: string;
  categoryQuery: string;
  summary: string;
  specFacts: SpecFact[];
  galleryCount: number;
}): Promise<Array<{ kind: ShotKind; scene: string }>> {
  const total = 1 + input.galleryCount;
  const multi = input.references.length > 1;
  const system = `커머스 화보 촬영 감독으로서 샷 플랜을 만듭니다. 각 shot의 scene은 영어로,
배경·환경·소품·조명·구도를 구체적으로 씁니다.
${multi ? `첨부된 ${input.references.length}장은 모두 같은 하나의 상품을 여러 각도에서 찍은 것입니다. 상품의 실제 형태·색·구성을 그 사진들에서 종합해 파악하고, 사진에 없는 특징을 상상해 넣지 마세요.\n` : ""}구성 규칙:
- 첫 샷은 반드시 main_studio: 밝고 깨끗한 스튜디오, 상품이 프레임 대부분을 차지, 은은한 그림자.
- 이어서 갤러리 ${input.galleryCount}샷: 상품 특성에 어울리는 다양한 연출
  (alt_studio 다른 배경색/각도, lifestyle 어울리는 실제 공간, usage 사용 장면 중 택).
- 소품은 상품을 돋보이게 하는 선에서만, 읽을 수 있는 텍스트가 있는 소품 금지.
- 반드시 총 ${total}개의 shot을 반환합니다.`;

  const details = [
    input.productName ? `상품명: ${input.productName}` : null,
    input.categoryQuery ? `상품군: ${input.categoryQuery}` : null,
    input.summary ? `요약: ${input.summary}` : null,
    input.specFacts.length > 0
      ? `스펙: ${input.specFacts.map((fact) => `${fact.label}=${fact.value}`).join(", ")}`
      : null,
  ].filter(Boolean);

  try {
    const plan = await requestOpenAiJson({
      system,
      user: `첨부 사진의 상품입니다. ${details.join(" / ")} 총 ${total}샷.`,
      // 샷 플랜도 전 각도를 본다 — 한 장만 보면 안 보이는 면을 전제로 장면을 설계한다.
      imageUrls: input.references
        .slice(0, 6)
        .map((reference) => `data:image/jpeg;base64,${reference.buffer.toString("base64")}`),
      schemaName: "image_shot_plan",
      jsonSchema: SHOT_PLAN_JSON_SCHEMA,
      validator: ShotPlanSchema,
      reasoningEffort: "low",
    });
    return normalizePlan(plan.shots, total);
  } catch (error) {
    console.warn("[image-suite] 샷 플랜 실패 — 기본 플랜으로 진행합니다:", error instanceof Error ? error.message : error);
    return normalizePlan([], total);
  }
}

/** 보정 두 가지: ① 첫 샷이 main_studio 가 아니면 앞에 끼운다 ② 부족하면 패딩한다. */
export function normalizePlan(
  shots: Array<{ kind: ShotKind; scene: string }>,
  target: number,
): Array<{ kind: ShotKind; scene: string }> {
  const output = shots.filter((shot) => shot.scene.trim().length > 0);
  if (output.length === 0 || output[0].kind !== "main_studio") {
    output.unshift({ kind: "main_studio", scene: DEFAULT_MAIN_SCENE });
  }
  let cursor = 0;
  while (output.length < target) {
    output.push(PADDING_SHOTS[cursor % PADDING_SHOTS.length]);
    cursor += 1;
  }
  return output.slice(0, target);
}

function buildPrompt(
  shot: { kind: ShotKind; scene: string },
  productName: string,
  referenceCount: number,
  hasAnchor: boolean,
): string {
  return [
    `Product: ${productName || "the product in the reference photos"}`,
    `Create a Korean e-commerce ${shot.kind === "closeup" ? "macro detail shot" : "product image"}.`,
    `Scene: ${shot.scene}`,
    referenceCount > 1
      ? `You are given ${referenceCount} reference photos of this one product.`
      : "",
    hasAnchor
      ? "The FIRST reference image is the APPROVED STUDIO HERO of this product. It is the authoritative rendering: match its colors, proportions, materials and details exactly. The remaining references only add angles you cannot see in it. Change the scene around the product, never the product."
      : "",
    PRESERVATION_RULES,
  ]
    .filter(Boolean)
    .join("\n");
}

interface ShotResult {
  index: number;
  kind: ShotKind;
  scene: string;
  filePath: string;
  url: string;
}

export async function generateImageSuite(input: GenerateImageSuiteInput): Promise<ImageSuiteResult> {
  const startedAt = Date.now();
  const { config } = input;
  const budget = suiteBudgetMs(config.media.quality, config.media.mainQuality);
  const budgetLeft = (): number => budget - (Date.now() - startedAt);
  const warnings: string[] = [];

  if (!env.OPENAI_API_KEY) {
    return { main: null, gallery: [], detailCuts: [], warnings: ["OPENAI_API_KEY 가 없어 연출 이미지를 만들지 못했습니다."] };
  }

  const directory = await ensureListingAssetDirectory(input.listingId);
  const references = await prepareReferences(input.photoPaths);

  const galleryCount = config.media.galleryCount;
  // ⚠ 상세 컷은 스위트가 만들지 않는다 — 상세는 세로 패널 시스템이 전담한다.
  const targetShotCount = 1 + galleryCount;

  const shots = await planShots({
    references,
    productName: input.productName,
    categoryQuery: input.categoryQuery,
    summary: input.summary,
    specFacts: input.specFacts,
    galleryCount,
  });

  const emit = (label: string, payload: Record<string, unknown>): void => {
    void appendEvent(input.listingId, { source: "openai", kind: "image", label, payload }).catch(
      console.warn,
    );
  };

  const results: (ShotResult | null)[] = new Array(shots.length).fill(null);
  const failed = new Set<number>();
  /** 대표 컷이 완성되면 나머지 샷의 정체성 앵커로 재사용한다. */
  let anchor: PreparedReference | null = null;

  const renderShot = async (index: number): Promise<void> => {
    if (input.signal?.aborted) return;
    const shot = shots[index];
    const isMain = index === 0;
    const quality = isMain ? config.media.mainQuality : config.media.quality;
    const size = isMain ? MAIN_SIZE : GALLERY_SIZE;
    const shotStartedAt = Date.now();
    // 승인된 대표 컷을 **맨 앞**에 둔다 — 모델이 첫 참조를 정체성 기준으로 강하게 잡는다.
    const shotReferences = anchor && !isMain ? [anchor, ...references] : references;
    emit("image.shot_started", {
      kind: shot.kind,
      index,
      quality,
      referenceCount: shotReferences.length,
    });

    try {
      const response = await getImageClient().images.edit({
        model: env.OPENAI_IMAGE_MODEL,
        // 업로드한 사진 전부(+대표 앵커)를 참조로 넘긴다.
        image: await toUploadables(shotReferences.slice(0, MAX_REFERENCE_IMAGES)),
        prompt: buildPrompt(shot, input.productName, shotReferences.length, Boolean(anchor) && !isMain),
        size: size as never,
        quality: quality as never,
        output_format: "jpeg",
        output_compression: 92,
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new Error("이미지 응답이 비어 있습니다.");
      if (input.signal?.aborted) return;

      const bytes = Buffer.from(b64, "base64");
      const filename = `suite-${shot.kind}-${index + 1}.jpg`;
      const filePath = path.join(directory, filename);
      await writeFile(filePath, bytes);
      const url = listingAssetUrl(input.listingId, filename);
      results[index] = { index, kind: shot.kind, scene: shot.scene, filePath, url };
      failed.delete(index);
      if (isMain) {
        anchor = { buffer: bytes, name: "approved-hero.jpg" };
        input.onHeroReady?.(filePath);
      }
      emit("image.shot_completed", {
        kind: shot.kind,
        index,
        tookMs: Date.now() - shotStartedAt,
        url,
      });
    } catch (error) {
      failed.add(index);
      console.warn(
        `[image-suite] 샷 ${index} (${shot.kind}) 실패:`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  /**
   * 대표 컷을 먼저 만든다 — 나머지 샷과 상세 패널이 이걸 앵커로 삼아야 일관성이 유지된다.
   * ⚠ 대표에 **전용 서브예산**을 준다. 전체 예산을 대표가 다 쓰면 갤러리까지 통째로
   *   건너뛰고 결국 "원본 사진으로 등록"까지 떨어진다 — 실제로 그렇게 터졌다.
   */
  const mainBudget = Math.max(20_000, Math.floor(budget * 0.55));
  await Promise.race([renderShot(0), sleep(mainBudget)]);

  // 대표가 낙오해도 갤러리는 반드시 돈다 — 생성 이미지 하나도 없는 상태로 끝내지 않는다.
  if (!input.signal?.aborted && shots.length > 1 && budgetLeft() > 6_000) {
    const queue = shots.map((_, index) => index).slice(1);
    const workers = Array.from({ length: Math.min(GEN_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const index = queue.shift();
        if (index === undefined) break;
        if (budgetLeft() < 4_000 || input.signal?.aborted) break;
        await renderShot(index);
      }
    });
    // 예산 안에 정착한 샷만 채택한다. 낙오 샷은 백그라운드에서 조용히 끝나더라도 넣지 않는다.
    await Promise.race([Promise.all(workers), sleep(Math.max(1_000, budgetLeft()))]);
  }

  // 대표가 비었는데 갤러리가 살아 있으면, 갤러리 1번을 대표로 승격한다.
  // 원본 사진을 대표로 쓰는 것보다 언제나 낫다.
  if (!results[0] && !input.signal?.aborted) {
    const promoted = results.findIndex((result) => result !== null);
    if (promoted > 0) {
      results[0] = { ...results[promoted]!, index: 0 };
      results[promoted] = null;
      warnings.push("대표 컷이 예산 안에 완성되지 않아 생성된 갤러리 컷을 대표로 승격했습니다.");
      input.onHeroReady?.(results[0]!.filePath);
    }
  }

  // 예산이 넉넉히 남았을 때만 실패 샷을 직렬 재시도한다.
  if (!input.signal?.aborted && failed.size > 0 && budgetLeft() > 30_000) {
    for (const index of [...failed]) {
      if (budgetLeft() < 25_000 || input.signal?.aborted) break;
      await sleep(3_000);
      await renderShot(index);
    }
  }

  const settled = results.filter((result): result is ShotResult => result !== null);
  if (settled.length < targetShotCount) {
    warnings.push(`연출 이미지 ${targetShotCount - settled.length}컷이 예산 안에 완성되지 않아 제외했습니다.`);
  }

  const mainShot = settled.find((result) => result.index === 0) ?? null;
  const rest = settled.filter((result) => result !== mainShot).sort((a, b) => a.index - b.index);

  const toSuiteImage = (result: ShotResult): SuiteImage => ({
    kind: result.kind,
    filePath: result.filePath,
    url: result.url,
    scene: result.scene,
  });

  let main: SuiteImage | null = mainShot ? toSuiteImage(mainShot) : null;

  // 전멸하면 원본 사진을 정돈해 대표로 쓴다.
  if (!main && !input.signal?.aborted && input.photoPaths.length > 0) {
    try {
      const groomed = await sharp(input.photoPaths[0], { failOn: "none" })
        .rotate()
        .resize({ width: 940, height: 940, fit: "inside", withoutEnlargement: false })
        .extend({ top: 30, bottom: 30, left: 30, right: 30, background: "#ffffff" })
        .resize({ width: 1000, height: 1000, fit: "contain", background: "#ffffff" })
        .jpeg({ quality: 92 })
        .toBuffer();
      const filename = "suite-main_studio-99.jpg";
      const filePath = path.join(directory, filename);
      await writeFile(filePath, groomed);
      main = {
        kind: "main_studio",
        filePath,
        url: listingAssetUrl(input.listingId, filename),
        scene: "원본 사진 정돈 폴백",
      };
      warnings.push("연출 이미지 생성에 실패해 원본 사진을 정돈해 대표 이미지로 사용합니다.");
    } catch {
      warnings.push("연출 이미지와 원본 정돈이 모두 실패했습니다 — 원본 사진 그대로 등록합니다.");
    }
  }

  return {
    main,
    gallery: rest.slice(0, galleryCount).map(toSuiteImage),
    detailCuts: rest.slice(galleryCount).map(toSuiteImage),
    warnings,
  };
}
