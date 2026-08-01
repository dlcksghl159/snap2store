import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { appendEvent, setStage } from "../events.js";
import { ensureListingAssetDirectory, listingAssetUrl, updateListing } from "../store.js";
import { hasLiveSmartstoreCredentials } from "../env.js";
import { matchCategory } from "../materials/category-match.js";
import { resolveNotice } from "../materials/notice.js";
import { resolveKc } from "../materials/kc.js";
import { resolveOrigin } from "../materials/origin.js";
import { resolvePrice, calcReturnExchangeFeeKrw } from "../materials/pricing.js";
import { buildSeoInfo, generateTagPortfolio, resolveTags } from "../materials/tags.js";
import { generateSeoTitle } from "../materials/title-seo.js";
import { repairTitle, validateTitle } from "../materials/title-gate.js";
import { analyzeProductAttributes, toProductAttributesPayload } from "../materials/attributes.js";
import { prepareImagesForUpload, uploadImagesToNaver } from "../commerce/images.js";
import { composeDetailPlan } from "./detail-composer.js";
import { generateDetailPanels } from "./detail-panels.js";
import {
  buildDetailContent,
  buildDetailPreviewDocument,
  buildShowcaseDetailContent,
} from "./detail-content.js";
import { buildProductPayload, buildShoppingSearchInfo } from "./payload.js";
import { runPreflight } from "./preflight.js";
import { registerProduct } from "./register.js";
import type { SellerConfig } from "../seller-config.js";
import type { AgentToolOutcomes } from "../agent.js";
import type {
  AttributeAnalysis,
  DetailPanel,
  DetailPanelSpec,
  DetailPlan,
  ImageSuiteResult,
  ListingDraft,
  ListingMaterials,
  ListingResolution,
  OriginResolution,
  PriceResolution,
  ResolvedCategory,
  SeoTitleResult,
  SpecFact,
  TagResolution,
} from "../../src/domain/types";

export interface OrchestratorInput {
  listingId: string;
  draft: ListingDraft;
  photoPaths: string[];
  photoUrls: string[];
  resolution: ListingResolution | null;
  mode: "live" | "dry-run";
  sellerNote: string | null;
  imageSuitePromise: Promise<ImageSuiteResult>;
  toolOutcomes: AgentToolOutcomes | null;
  config: SellerConfig;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function referenceDataUrl(photoPaths: string[]): Promise<string | null> {
  for (const photoPath of photoPaths) {
    try {
      const buffer = await sharp(photoPath, { failOn: "none" })
        .rotate()
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
    } catch {
      continue;
    }
  }
  return null;
}

export async function orchestrateListing(input: OrchestratorInput): Promise<void> {
  const { listingId, draft, config } = input;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const blockReasons: string[] = [];
  const holdReasons: string[] = [];
  const timings = { category: 0, materials: 0, detail: 0, register: 0, total: 0 };

  const onEvent = async (label: string, payload?: Record<string, unknown>): Promise<void> => {
    await appendEvent(listingId, { source: "runtime", kind: "milestone", label, payload: payload ?? null });
  };

  // 스위트 대표 컷이 먼저 끝나면 패널이 그것을 정체성 앵커로 쓴다.
  // ⚠ await 하지 않는다 — 기다리면 패널이 대표 컷 뒤로 직렬화된다.
  let heroPath: string | null = null;
  void input.imageSuitePromise.then((suite) => {
    heroPath = suite.main?.filePath ?? null;
  });

  /* ── ① 거부 게이트 — 반드시 재료 생산 앞에 둔다 ── */
  if (draft.riskLevel === "high") {
    blockReasons.push(
      "고위험 의심 상품(불법·위험·모조 가능성) — 에이전트가 등록을 거부했습니다. 이 판정 자체가 이 런의 최종 산출물입니다.",
    );
    blockReasons.push(...draft.blockReasons);
    await appendEvent(listingId, {
      source: "runtime",
      kind: "error",
      label: "자동 등록 중단",
      payload: { issues: blockReasons },
    }).catch(console.warn);
    await updateListing(listingId, (listing) => ({
      ...listing,
      status: "needs_review",
      stage: "blocked",
      stageLabel: "에이전트 판정 보고",
      progress: 100,
      blockReasons: [...new Set(blockReasons)],
      warnings,
    }));
    return;
  }

  /* ── ② 카테고리 확정 — 우선순위 4단 ── */
  await setStage(listingId, "category", 48, "카테고리를 정하는 중입니다");
  const categoryStartedAt = Date.now();
  const imageDataUrl = await referenceDataUrl(input.photoPaths);

  let category: ResolvedCategory = {
    outcome: "unavailable",
    categoryId: null,
    categoryName: null,
    leafName: null,
    verified: false,
    match: null,
  };

  try {
    const resolution = input.resolution;
    const overrideHaystack = `${draft.title} ${draft.categoryQuery} ${draft.categoryName}`.toLocaleLowerCase("ko-KR");
    const override = config.categoryOverrides.find((entry) =>
      entry.includes.every((keyword) => overrideHaystack.includes(keyword.toLocaleLowerCase("ko-KR"))),
    );

    if (resolution?.categoryId) {
      // 1) 판매자 해소 입력 — 트리 확인 실패해도 판매자 지정값을 존중한다.
      category = {
        outcome: "manual",
        categoryId: resolution.categoryId,
        categoryName: resolution.categoryName ?? resolution.categoryId,
        leafName: (resolution.categoryName ?? "").split(">").pop()?.trim() ?? null,
        verified: true,
        match: null,
      };
    } else if (override) {
      // 2) 설정 키워드 고정
      category = {
        outcome: "manual",
        categoryId: override.categoryId,
        categoryName: override.categoryName,
        leafName: override.categoryName.split(">").pop()?.trim() ?? override.categoryName,
        verified: true,
        match: null,
      };
    } else if (input.toolOutcomes?.category?.categoryId) {
      // 3) 에이전트 도구 결과 재사용
      const match = input.toolOutcomes.category;
      category = {
        outcome: match.outcome,
        categoryId: match.categoryId,
        categoryName: match.categoryName,
        leafName: match.leafName,
        verified: match.outcome === "verified",
        match,
      };
    } else if (hasLiveSmartstoreCredentials() || input.mode === "dry-run") {
      // 4) 서버 폴백 자동 매칭
      const match = await matchCategory({
        productGroupName: draft.categoryQuery,
        productSummary: draft.summary,
        productTitle: draft.title,
        imageDataUrl,
      });
      category = {
        outcome: match.outcome,
        categoryId: match.categoryId,
        categoryName: match.categoryName,
        leafName: match.leafName,
        verified: match.outcome === "verified",
        match,
      };
    }
  } catch (error) {
    warnings.push(`카테고리 매칭 중 오류가 발생해 미확정으로 진행합니다: ${message(error)}`);
  }

  // 최후 폴백 — 득표 1위 자동 채택. 사람을 기다리는 것보다 "미검증" 라벨이 붙은 완주가 낫다.
  if (!category.categoryId && (category.match?.candidates.length ?? 0) > 0) {
    const top = category.match!.candidates[0];
    category = {
      outcome: "review_required",
      categoryId: top.categoryId,
      categoryName: top.categoryName,
      leafName: top.categoryName.split(">").pop()?.trim() ?? top.categoryName,
      verified: false,
      match: category.match,
    };
    warnings.push(`카테고리 검증 미통과 — 최다 득표 후보(${top.categoryName})로 자동 진행합니다.`);
  }

  timings.category = Date.now() - categoryStartedAt;
  await onEvent("카테고리 매칭", {
    outcome: category.outcome,
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    rounds: category.match?.attempts.length ?? 0,
    tookMs: timings.category,
  }).catch(console.warn);

  /* ── ③ 재료 병렬 생산 ── */
  await setStage(listingId, "materials", 58, "등록 재료를 만드는 중입니다");
  const materialsStartedAt = Date.now();
  const panelTarget = config.media.detailPanelCount;

  // 갈래 A — 제목 → 태그 체인 (순서 의존). 다른 재료와는 병렬.
  const titleTagsPromise = (async (): Promise<{
    seoResult: SeoTitleResult;
    tagResult: TagResolution;
    resolvedTitle: string;
  }> => {
    const emptySeo: SeoTitleResult = {
      title: null,
      strategy: null,
      coveredQueries: [],
      uncoveredQueries: [],
      monthlyVolume: 0,
      warnings: [],
    };
    const seoResult = await generateSeoTitle({
      draftTitle: draft.title,
      productGroup: draft.categoryQuery,
      categoryPath: category.categoryName,
      specFacts: draft.specFacts,
      labelTexts: draft.labelTexts,
      comps: category.match?.compsSample ?? [],
    }).catch(() => emptySeo);

    const resolvedTitle = seoResult.title ?? draft.title;
    const tagResult = await generateTagPortfolio({
      productTitle: resolvedTitle,
      productGroup: draft.categoryQuery,
      summary: draft.summary,
      agentTags: draft.tags,
      uncoveredQueries: seoResult.uncoveredQueries,
      leafName: category.leafName,
      categoryPath: category.categoryName,
    }).catch(() => resolveTags({ candidates: draft.tags, leafName: category.leafName }));

    return { seoResult, tagResult, resolvedTitle };
  })();

  // 갈래 B — 상세 기획 → 패널 (긴 작업이라 조기 시작)
  const planPanelsPromise = (async (): Promise<{
    plan: DetailPlan | null;
    panels: DetailPanel[];
    panelWarnings: string[];
  }> => {
    if (panelTarget <= 0) return { plan: null, panels: [], panelWarnings: [] };
    void onEvent("detail.plan_started", { panelTarget }).catch(console.warn);

    const plan = await composeDetailPlan({
      productTitle: draft.title,
      productGroup: draft.categoryQuery,
      summary: draft.summary,
      agentSections: draft.detailSections,
      specFacts: draft.specFacts,
      labelTexts: draft.labelTexts,
      sellerNote: input.sellerNote,
      panelTarget,
      imageDataUrl,
    });
    if (!plan) return { plan: null, panels: [], panelWarnings: ["상세 기획 실패"] };

    void onEvent("detail.plan_completed", {
      concept: plan.concept,
      angle: plan.angle,
      sections: plan.sections.map((section) => ({
        role: section.role,
        heading: section.heading,
        hasPanel: Boolean(section.panel),
      })),
      panelCount: plan.sections.filter((section) => section.panel).length,
    }).catch(console.warn);

    const specs: DetailPanelSpec[] = plan.sections
      .map((section, index) =>
        section.panel
          ? {
              sectionIndex: index,
              role: section.role,
              headline: section.panel.headline,
              subline: section.panel.subline,
              sceneHint: section.panel.sceneHint,
            }
          : null,
      )
      .filter((spec): spec is DetailPanelSpec => spec !== null);

    try {
      const generated = await generateDetailPanels({
        listingId,
        photoPaths: input.photoPaths,
        productName: draft.title,
        specs,
        config,
        anchorPath: () => heroPath,
        onShotEvent: (label, payload) => {
          // fire-and-forget — 반드시 catch. 영속 실패가 패널 생산을 죽이면 안 된다.
          void onEvent(label, payload).catch(console.warn);
        },
      });
      return { plan, panels: generated.panels, panelWarnings: generated.warnings };
    } catch (error) {
      return { plan, panels: [], panelWarnings: [`패널 생성 실패: ${message(error)}`] };
    }
  })();

  // 가격 브랜치 — 3단 폴백 + 바깥 catch 이중 방어
  const pricePromise = (async (): Promise<PriceResolution> => {
    if (input.resolution?.salePrice && input.resolution.salePrice >= 100) {
      return {
        resolved: true,
        salePrice: input.resolution.salePrice,
        priceBasis: "판매자 지정가",
        source: "seller_input",
        sampleSize: 0,
        distribution: null,
      };
    }
    if (input.toolOutcomes?.price?.resolved) return input.toolOutcomes.price;

    const resolved = await resolvePrice({
      comps: category.match?.compsSample ?? [],
      searchQuery: draft.categoryQuery,
      estimatedPriceKrw: draft.salePrice >= 100 ? draft.salePrice : null,
      config,
    });
    if (resolved.resolved) return resolved;

    warnings.push(
      `판매가 근거 부재 — 최저 안전가(${config.pricing.minSalePrice}원)로 자동 진행합니다.`,
    );
    return {
      ...resolved,
      resolved: true,
      salePrice: config.pricing.minSalePrice,
      priceBasis: "최저 안전가 — 시세·추정 부재 (검토 권장)",
      source: "floor",
    };
  })().catch((): PriceResolution => {
    warnings.push(`판매가 산출 실패 — 최저 안전가(${config.pricing.minSalePrice}원)로 자동 진행합니다.`);
    return {
      resolved: true,
      salePrice: config.pricing.minSalePrice,
      priceBasis: "최저 안전가 — 시세·추정 부재 (검토 권장)",
      source: "floor",
      sampleSize: 0,
      distribution: null,
    };
  });

  const emptyAttributes: AttributeAnalysis = { applied: [], reviewed: 0, warnings: [] };

  const [notice, kc, origin, price, titleTags, attributeAnalysis, imageSuite, planPanels] =
    await Promise.all([
      resolveNotice({
        categoryId: category.categoryId,
        config,
        productName: draft.title,
        modelName: draft.modelName,
        manufacturerName: draft.manufacturerName,
      }).catch(() =>
        resolveNotice({
          categoryId: null,
          config,
          productName: draft.title,
          modelName: draft.modelName,
          manufacturerName: draft.manufacturerName,
          fetchTypes: async () => [],
        }),
      ),
      resolveKc({
        categoryId: category.categoryId,
        config,
        certificationNumber: input.resolution?.kcCertificationNumber ?? null,
      }).catch(() =>
        resolveKc({ categoryId: null, config, detail: null, certificationNumber: null }),
      ),
      resolveOrigin({
        marking: draft.originMarking,
        config,
        sellerOverride: input.resolution
          ? {
              originAreaCode: input.resolution.originAreaCode,
              content: input.resolution.originContent,
            }
          : null,
      }).catch((error): OriginResolution => {
        warnings.push(`원산지 해석 실패: ${message(error)}`);
        return {
          resolved: false,
          needsReview: true,
          reviewReason: "원산지 해석 중 오류",
          countryLabel: null,
          domestic: false,
          originAreaInfo: null,
          source: "label",
          warnings: [],
        };
      }),
      pricePromise,
      titleTagsPromise,
      (category.categoryId
        ? analyzeProductAttributes({
            categoryId: category.categoryId,
            productTitle: draft.title,
            productGroup: draft.categoryQuery,
            summary: draft.summary,
            specFacts: draft.specFacts,
            labelTexts: draft.labelTexts,
          })
        : Promise.resolve(emptyAttributes)
      ).catch(() => emptyAttributes),
      input.imageSuitePromise,
      planPanelsPromise,
    ]);

  warnings.push(
    ...notice.warnings,
    ...kc.warnings,
    ...origin.warnings,
    ...titleTags.seoResult.warnings,
    ...titleTags.tagResult.warnings,
    ...attributeAnalysis.warnings,
    ...imageSuite.warnings,
    ...planPanels.panelWarnings,
  );

  timings.materials = Date.now() - materialsStartedAt;
  await onEvent("재료 생산 완료", {
    noticeType: notice.noticeType,
    kcStatus: kc.status,
    originResolved: origin.resolved && !origin.needsReview,
    salePrice: price.salePrice,
    tagCount: titleTags.tagResult.tags.length,
    // 확정된 상품명을 싣는다 — SEO 파이프라인이 무너져도 null 이 나가지 않는다.
    seoTitle: titleTags.resolvedTitle,
    titleStrategy: titleTags.seoResult.strategy,
    attributeCount: attributeAnalysis.applied.length,
    generatedImages:
      (imageSuite.main ? 1 : 0) + imageSuite.gallery.length + planPanels.panels.length,
    tookMs: timings.materials,
  }).catch(console.warn);

  /* ── ④ 검증 + 폴백 해소 ── */
  await setStage(listingId, "validation", 74, "규정을 검증하는 중입니다");

  // 폴백 1 — 상품명 자동 보정
  let registrationTitle = titleTags.resolvedTitle;
  const gate = validateTitle(registrationTitle, "registration");
  if (gate.errors.length > 0) {
    const repaired = repairTitle(registrationTitle, draft.categoryQuery || draft.title);
    const regate = validateTitle(repaired.title, "registration");
    if (regate.errors.length === 0) {
      warnings.push(
        `상품명 자동 보정: "${registrationTitle}" → "${repaired.title}" (사유: ${gate.errors.join(" / ")})`,
      );
      registrationTitle = repaired.title;
    } else {
      // 멈추지 않는다 — 최종 게이트는 네이버다.
      warnings.push(`상품명 게이트 위반 잔존: ${regate.errors.join(" / ")}`);
      registrationTitle = repaired.title;
    }
  }

  // 폴백 3 — 원산지 최후 폴백. 원산지 때문에 런이 멈추는 경로는 존재하지 않는다.
  let effectiveOrigin = origin;
  if (origin.needsReview || !origin.originAreaInfo) {
    effectiveOrigin = {
      ...origin,
      resolved: true,
      needsReview: false,
      reviewReason: null,
      originAreaInfo: {
        originAreaCode: config.origin.originAreaCode,
        content: config.origin.content,
        ...(config.origin.originAreaCode === "00" ? {} : { importer: config.origin.importer }),
      },
      source: "config",
    };
    warnings.push(`원산지 미판독 — 판매자 설정 기본값(${config.origin.content})으로 진행합니다.`);
  }

  // 에이전트 미확정 항목은 경고로 강등한다.
  const agentConcerns = [
    ...draft.blockReasons,
    ...draft.facts.filter((fact) => fact.kind === "unresolved" && fact.blocksPublishing).map((fact) => fact.claim),
  ].filter(Boolean);
  if (agentConcerns.length > 0) {
    warnings.push(`에이전트 미확정 항목(자동 진행): ${[...new Set(agentConcerns)].join(" · ")}`);
  }

  // 실전송 보류 사유 — 완주는 계속, 쓰기만 강등
  if (kc.blocking && kc.blockReason) {
    holdReasons.push(`${kc.blockReason} 등록안은 완성되며, 인증번호 입력 즉시 실등록할 수 있습니다.`);
  }
  if (!category.categoryId) {
    holdReasons.push("판매 카테고리를 확정하지 못했습니다 — 등록안은 완성되며 실등록만 보류합니다.");
  }
  if (input.mode === "live" && !hasLiveSmartstoreCredentials()) {
    holdReasons.push("커머스 API 자격증명이 없어 스토어 전송을 하지 못했습니다.");
  }

  let effectiveMode: "live" | "dry-run" = input.mode;
  if (effectiveMode === "live" && holdReasons.length > 0) effectiveMode = "dry-run";
  const isLive = effectiveMode === "live";

  /* ── ⑤ 이미지 업로드 ── */
  await setStage(listingId, "publishing", 84, "이미지를 올리는 중입니다");

  interface UploadEntry {
    path: string;
    localUrl: string;
    role: "main" | "gallery" | "cut";
    kind: string;
  }

  const suiteEntries: UploadEntry[] = [
    ...(imageSuite.main
      ? [{ path: imageSuite.main.filePath, localUrl: imageSuite.main.url, role: "main" as const, kind: imageSuite.main.kind }]
      : []),
    ...imageSuite.gallery.map((image) => ({
      path: image.filePath,
      localUrl: image.url,
      role: "gallery" as const,
      kind: image.kind,
    })),
    ...planPanels.panels.map((panel) => ({
      path: panel.filePath,
      localUrl: panel.url,
      role: "cut" as const,
      kind: `panel_${panel.role}`,
    })),
  ];

  let mediaFallbackUsed = false;
  const uploadPlan: UploadEntry[] =
    suiteEntries.length > 0
      ? suiteEntries
      : input.photoPaths.map((photoPath, index) => ({
          path: photoPath,
          localUrl: input.photoUrls[index] ?? "",
          role: index === 0 ? ("main" as const) : ("gallery" as const),
          kind: "raw_photo",
        }));
  if (suiteEntries.length === 0) {
    mediaFallbackUsed = true;
    warnings.push("연출 이미지가 없어 원본 사진으로 등록합니다.");
  }

  const urlByPath = new Map<string, string>();
  for (const entry of uploadPlan) urlByPath.set(entry.path, entry.localUrl);

  if (isLive && uploadPlan.length > 0) {
    try {
      const prepared = await prepareImagesForUpload(uploadPlan.map((entry) => entry.path));
      warnings.push(...prepared.warnings);
      if (prepared.prepared.length === 0) throw new Error("업로드 가능한 이미지가 없습니다.");
      const uploaded = await uploadImagesToNaver(prepared.prepared);
      warnings.push(...uploaded.warnings);
      for (const [filePath, url] of uploaded.urlByPath) urlByPath.set(filePath, url);
    } catch (error) {
      warnings.push(`이미지 업로드 실패 — 실등록을 보류합니다: ${message(error)}`);
      holdReasons.push(`이미지 업로드에 실패했습니다: ${message(error)}`);
      effectiveMode = "dry-run";
    }
  }

  const liveNow = effectiveMode === "live";
  const resolved = uploadPlan
    .map((entry) => ({ ...entry, finalUrl: urlByPath.get(entry.path) ?? entry.localUrl }))
    .filter((entry) => Boolean(entry.finalUrl));

  const mainEntry = resolved.find((entry) => entry.role === "main") ?? resolved[0] ?? null;
  const representativeImageUrl = mainEntry?.finalUrl ?? null;
  // ⚠ 패널(role: "cut")은 추가 노출 이미지에 넣지 않는다 — 상세 본문 전용이다.
  const optionalImageUrls = resolved
    .filter((entry) => entry !== mainEntry && entry.role !== "cut")
    .slice(0, 9)
    .map((entry) => entry.finalUrl);

  /* ── ⑥ 상세 조립 ── */
  const detailStartedAt = Date.now();
  const salePrice = price.salePrice;
  const claimFee = calcReturnExchangeFeeKrw(salePrice);
  const noticeLines = [
    `배송비: ${
      config.delivery.deliveryFeeType === "FREE"
        ? "무료배송"
        : config.delivery.deliveryFeeType === "CONDITIONAL_FREE"
          ? `${config.delivery.baseFee.toLocaleString("ko-KR")}원 (${(config.delivery.freeConditionalAmount ?? 50000).toLocaleString("ko-KR")}원 이상 무료)`
          : `${config.delivery.baseFee.toLocaleString("ko-KR")}원`
    }`,
    `반품/교환 배송비: 각 ${claimFee.toLocaleString("ko-KR")}원 (단순 변심 기준)`,
    `A/S 안내: ${config.afterService.guideContent} (${config.afterService.telephoneNumber})`,
    config.noticeDefaults.noRefundReason,
  ];

  const specRows: SpecFact[] = [
    ...draft.specFacts,
    ...(effectiveOrigin.originAreaInfo
      ? [{ label: "원산지", value: effectiveOrigin.originAreaInfo.content }]
      : []),
  ];

  const panelUrlBySection = new Map<number, string>();
  for (const panel of planPanels.panels) {
    const finalUrl = urlByPath.get(panel.filePath);
    if (finalUrl) panelUrlBySection.set(panel.sectionIndex, finalUrl);
  }

  const extraImageUrls = resolved
    .filter((entry) => entry.role === "gallery")
    .map((entry) => entry.finalUrl);

  // ⚠ trustAllImageHosts 는 실전송이 아닐 때만 켠다.
  const trustAllImageHosts = !liveNow;
  const detail = planPanels.plan
    ? buildShowcaseDetailContent({
        headline: planPanels.plan.headline,
        subheadline: planPanels.plan.subheadline,
        hooks: planPanels.plan.hooks,
        sections: planPanels.plan.sections.map((section, index) => ({
          role: section.role,
          heading: section.heading,
          body: section.body,
          imageUrl: panelUrlBySection.get(index) ?? null,
        })),
        closing: planPanels.plan.closing,
        heroImageUrl: representativeImageUrl,
        extraImageUrls,
        specRows,
        noticeLines,
        productAlt: registrationTitle,
        trustAllImageHosts,
      })
    : buildDetailContent({
        title: registrationTitle,
        summary: draft.summary,
        imageUrls: [representativeImageUrl, ...extraImageUrls].filter((url): url is string => Boolean(url)),
        sections: draft.detailSections,
        specRows,
        noticeLines,
        trustAllImageHosts,
      });

  if (!planPanels.plan) warnings.push("상세 기획을 만들지 못해 기본 상세 레이아웃으로 조립했습니다.");
  if (detail.droppedImageUrls.length > 0) {
    warnings.push(`네이버 업로드 URL 이 아닌 이미지 ${detail.droppedImageUrls.length}장을 상세에서 제외했습니다.`);
  }

  // 상세 미리보기 자산
  let detailPreviewUrl: string | null = null;
  try {
    const directory = await ensureListingAssetDirectory(listingId);
    await writeFile(path.join(directory, "detail.html"), buildDetailPreviewDocument(detail.html), "utf8");
    detailPreviewUrl = listingAssetUrl(listingId, "detail.html");
  } catch (error) {
    warnings.push(`상세 미리보기 저장 실패: ${message(error)}`);
  }
  timings.detail = Date.now() - detailStartedAt;

  /* ── ⑦ 사전 비행 ── */
  // ⚠ KC 보류를 프리플라이트에 이중으로 넘기지 않는다 — 이미 강등으로 흡수했다.
  const kcForPreflight = kc.blocking ? { ...kc, blocking: false, blockReason: null } : kc;
  const preflight = await runPreflight({
    isLive: liveNow,
    title: registrationTitle,
    category,
    salePrice,
    stockQuantity: draft.stockQuantity > 0 ? draft.stockQuantity : config.product.stockQuantityDefault,
    representativeImageUrl,
    optionalImageUrls,
    detailContent: detail.html,
    origin: effectiveOrigin,
    kc: kcForPreflight,
    notice,
    tags: titleTags.tagResult,
    config,
  });
  warnings.push(...preflight.warnings);

  let publishMode: "live" | "dry-run" = effectiveMode;
  if (!preflight.publishAllowed) {
    if (publishMode === "live") publishMode = "dry-run";
    holdReasons.push(...preflight.errors);
    warnings.push(...preflight.errors.map((error) => `프리플라이트: ${error}`));
  }

  if (holdReasons.length > 0) {
    await onEvent("실등록 보류 판정", { reasons: [...new Set(holdReasons)] }).catch(console.warn);
  }

  /* ── ⑧ 등록 ── */
  await setStage(listingId, "publishing", 92, "스마트스토어에 등록하는 중입니다");
  const registerStartedAt = Date.now();

  const stockQuantity =
    draft.stockQuantity > 0 ? draft.stockQuantity : config.product.stockQuantityDefault;
  const seoInfo = buildSeoInfo({
    title: registrationTitle,
    summary: draft.summary,
    tags: titleTags.tagResult.tags,
  });

  const registration = await (async () => {
    if (publishMode !== "live" || !category.categoryId || !representativeImageUrl || !effectiveOrigin.originAreaInfo) {
      return registerProduct({ listingId, payload: null, mode: "dry-run" });
    }
    const payload = buildProductPayload({
      listingId,
      title: registrationTitle,
      leafCategoryId: category.categoryId,
      representativeImageUrl,
      optionalImageUrls,
      detailContent: detail.html,
      salePrice,
      stockQuantity,
      config,
      notice: notice.payload,
      originAreaInfo: effectiveOrigin.originAreaInfo,
      searchInfo: buildShoppingSearchInfo({
        brandVerified: draft.brandVerified,
        brandName: draft.brandObserved,
        manufacturerName: draft.manufacturerName,
        modelName: draft.modelName,
      }),
      certificationTargetExcludeContent: kc.certificationTargetExcludeContent,
      productCertificationInfos: kc.productCertificationInfos,
      productAttributes: toProductAttributesPayload(attributeAnalysis.applied),
      seoInfo,
    });
    return registerProduct({ listingId, payload, mode: "live" });
  })();
  timings.register = Date.now() - registerStartedAt;
  timings.total = Date.now() - startedAt;

  if (registration.status !== "registered") {
    blockReasons.push(registration.message);
  }

  await onEvent("단계 소요시간(ms)", {
    category: timings.category,
    materials: timings.materials,
    detail: timings.detail,
    register: timings.register,
  }).catch(console.warn);

  /* ── 최종 상태 ── */
  const succeeded = blockReasons.length === 0;
  const liveRegistered = registration.mode === "live" && registration.status === "registered";
  const stageLabel = succeeded
    ? liveRegistered
      ? "스마트스토어 등록 완료"
      : "등록안 완성 — 스토어 전송 보류"
    : "에이전트 판정 보고";

  const materials: ListingMaterials = {
    category,
    notice,
    kc,
    origin: effectiveOrigin,
    price,
    tags: titleTags.tagResult,
    seo: titleTags.seoResult,
    attributes: attributeAnalysis,
    detailPlan: planPanels.plan,
    registrationTitle,
    detailHtml: detail.html,
    timings,
    media: {
      mainUrl: representativeImageUrl,
      galleryUrls: optionalImageUrls,
      galleryCount: optionalImageUrls.length,
      // ⚠ 결과 화면이 상세 패널을 전시하려면 URL 이 레코드에 있어야 한다.
      //   이벤트 로그는 160건에서 잘리므로 거기에 기대지 않는다.
      panelUrls: planPanels.panels
        .slice()
        .sort((a, b) => a.sectionIndex - b.sectionIndex)
        .map((panel) => urlByPath.get(panel.filePath) ?? panel.url),
      panelCount: planPanels.panels.length,
      detailPreviewUrl,
      fallbackUsed: mediaFallbackUsed,
    },
  };

  const publication = {
    mode: registration.mode,
    originProductNo: registration.originProductNo,
    channelProductNo: registration.channelProductNo,
    registeredAt: registration.registeredAt,
    message:
      holdReasons.length > 0 && registration.mode === "dry-run"
        ? `등록안 완성 — 실등록 보류: ${[...new Set(holdReasons)].join(" · ")}`
        : registration.message,
    productUrl: registration.productUrl,
    liveStatus: registration.status,
    holdReasons: holdReasons.length > 0 ? [...new Set(holdReasons)] : null,
  };

  if (succeeded) {
    await onEvent(stageLabel, {
      mode: registration.mode,
      originProductNo: registration.originProductNo,
      channelProductNo: registration.channelProductNo,
      productUrl: registration.productUrl,
      warningCount: new Set(warnings).size,
    }).catch(console.warn);
  } else {
    await appendEvent(listingId, {
      source: "runtime",
      kind: "error",
      label: "자동 등록 중단",
      payload: { issues: [...new Set(blockReasons)] },
    }).catch(console.warn);
  }

  await updateListing(listingId, (listing) => ({
    ...listing,
    status: succeeded ? "registered" : "needs_review",
    stage: succeeded ? "complete" : "blocked",
    stageLabel,
    progress: 100,
    // ⚠ 파이프라인 차단 사유를 draft.blockReasons 에 섞지 않는다 —
    //   재실행 시 파이프라인 사유를 에이전트 차단으로 재해석하는 자기중독을 막는다.
    blockReasons: [...new Set(blockReasons)],
    warnings: [...new Set(warnings)],
    materials,
    publication,
    draft: { ...draft, title: registrationTitle, salePrice, priceBasis: price.priceBasis },
  }));
}
