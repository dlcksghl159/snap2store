/**
 * 서버·프론트 공유 타입. 타입만 공유하므로 런타임 결합은 없다
 * (서버는 `import type` 으로만 참조한다).
 */

/* ── 에이전트 산출물 ─────────────────────────────────────────── */

export type FactKind = "observed" | "verified" | "configured" | "inferred" | "unresolved";

export interface EvidenceFact {
  kind: FactKind;
  claim: string;
  source: string;
  confidence: number;
  blocksPublishing: boolean;
}

export interface DetailSection {
  heading: string;
  body: string;
}

export interface SpecFact {
  label: string;
  value: string;
}

export interface ListingDraft {
  title: string;
  summary: string;
  categoryQuery: string;
  categoryName: string;
  categoryId: string | null;
  salePrice: number;
  priceBasis: string;
  stockQuantity: number;
  tags: string[];
  detailSections: DetailSection[];
  labelTexts: string[];
  originMarking: string | null;
  specFacts: SpecFact[];
  brandObserved: string | null;
  brandVerified: boolean;
  modelName: string | null;
  manufacturerName: string | null;
  facts: EvidenceFact[];
  riskLevel: "low" | "medium" | "high";
  canAutoPublish: boolean;
  blockReasons: string[];
}

/* ── 카테고리 ────────────────────────────────────────────────── */

export interface ShoppingSearchItem {
  title: string;
  categoryPath: string[];
  categoryId: string | null;
  brandName: string | null;
  manufacturerName: string | null;
  price: number | null;
  link: string | null;
}

export interface CategoryCandidate {
  categoryId: string;
  categoryName: string;
  leafName: string;
  votes: number;
  matchKind: "exact_path" | "suffix" | "leaf_name" | "tree_search";
}

export interface CategoryAttempt {
  round: number;
  categoryId: string | null;
  categoryName: string | null;
  verdict: "MATCH" | "MISMATCH" | "ERROR";
  reason: string;
  suggestedKeywords: string[];
}

export interface CategoryMatchResult {
  outcome: "verified" | "review_required" | "unavailable";
  categoryId: string | null;
  categoryName: string | null;
  leafName: string | null;
  matchSource: "catalog_models" | "tree_search" | null;
  reviewRequired: boolean;
  attempts: CategoryAttempt[];
  candidates: CategoryCandidate[];
  compsSample: ShoppingSearchItem[];
}

export interface ResolvedCategory {
  outcome: "verified" | "review_required" | "unavailable" | "manual";
  categoryId: string | null;
  categoryName: string | null;
  leafName: string | null;
  verified: boolean;
  match: CategoryMatchResult | null;
}

/* ── 가격 ────────────────────────────────────────────────────── */

export interface PriceDistribution {
  sampleSize: number;
  keptSize: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  removedOutliers: number;
}

export interface PriceResolution {
  resolved: boolean;
  salePrice: number;
  priceBasis: string;
  source: "market_distribution" | "agent_estimate" | "seller_input" | "floor";
  sampleSize: number;
  distribution: PriceDistribution | null;
}

/* ── 재료 ────────────────────────────────────────────────────── */

export interface NoticeResolution {
  noticeType: string;
  noticeTypeName: string | null;
  payload: Record<string, unknown>;
  usedFallbackType: boolean;
  typeUnconfirmed: boolean;
  warnings: string[];
}

export interface KcResolution {
  status: "not_target" | "safe_criterion" | "certified" | "child_fallback" | "unknown";
  statusLabel: string;
  blocking: boolean;
  blockReason: string | null;
  certificationTargetExcludeContent: Record<string, unknown> | null;
  productCertificationInfos: Array<Record<string, unknown>>;
  warnings: string[];
}

export interface OriginAreaInfo {
  originAreaCode: string;
  content: string;
  importer?: string;
}

export interface OriginResolution {
  resolved: boolean;
  needsReview: boolean;
  reviewReason: string | null;
  countryLabel: string | null;
  domestic: boolean;
  originAreaInfo: OriginAreaInfo | null;
  source: "label" | "config" | "seller_input" | "search";
  warnings: string[];
}

export interface ResolvedTag {
  text: string;
  official: boolean;
  restricted: boolean;
  relation: string | null;
  score: number;
}

export interface TagResolution {
  tags: ResolvedTag[];
  restrictedRemoved: string[];
  dictionaryChecked: boolean;
  warnings: string[];
}

export interface SeoTitleResult {
  title: string | null;
  strategy: "accuracy" | "balanced" | "conversion" | null;
  coveredQueries: string[];
  uncoveredQueries: string[];
  monthlyVolume: number;
  warnings: string[];
}

export interface AppliedAttribute {
  attributeSeq: number;
  attributeValueSeq?: number;
  attributeRealValue?: string;
  attributeRealValueUnitCode?: string;
  attributeName: string;
  attributeValueName: string;
  confidence: number;
}

export interface AttributeAnalysis {
  applied: AppliedAttribute[];
  reviewed: number;
  warnings: string[];
}

/* ── 이미지 ──────────────────────────────────────────────────── */

export type ShotKind = "main_studio" | "alt_studio" | "lifestyle" | "usage" | "closeup" | "mood";

export interface SuiteImage {
  kind: ShotKind;
  filePath: string;
  url: string;
  scene: string;
}

export interface ImageSuiteResult {
  main: SuiteImage | null;
  gallery: SuiteImage[];
  detailCuts: SuiteImage[];
  warnings: string[];
}

export type SectionRole =
  | "hook"
  | "problem"
  | "solution"
  | "feature"
  | "usage"
  | "detail"
  | "trust"
  | "closing";

export interface DetailPanelSpec {
  sectionIndex: number;
  role: SectionRole;
  headline: string;
  subline: string;
  sceneHint: string;
}

export interface DetailPanel {
  sectionIndex: number;
  role: SectionRole;
  headline: string;
  filePath: string;
  url: string;
}

export interface DetailPlanSection {
  role: SectionRole;
  heading: string;
  body: string;
  panel: { headline: string; subline: string; sceneHint: string } | null;
}

export interface DetailPlan {
  concept: string;
  angle: string;
  headline: string;
  subheadline: string;
  hooks: Array<{ label: string; value: string }>;
  sections: DetailPlanSection[];
  closing: string;
}

/* ── 레코드 ──────────────────────────────────────────────────── */

export type ListingStatus = "queued" | "running" | "registered" | "needs_review" | "failed";

export type ListingStage =
  | "queued"
  | "vision"
  | "research"
  | "assets"
  | "category"
  | "materials"
  | "validation"
  | "publishing"
  | "complete"
  | "blocked"
  | "failed";

export type EventSource = "runtime" | "openai" | "commerce" | "seller";
export type EventKind =
  | "status"
  | "milestone"
  | "tool_call"
  | "tool_result"
  | "model_event"
  | "image"
  | "error";

export interface ListingEvent {
  id: string;
  at: string;
  source: EventSource;
  kind: EventKind;
  label: string;
  payload: Record<string, unknown> | null;
}

export interface ListingMaterials {
  category: ResolvedCategory;
  notice: NoticeResolution;
  kc: KcResolution;
  origin: OriginResolution;
  price: PriceResolution;
  tags: TagResolution;
  seo: SeoTitleResult;
  attributes: AttributeAnalysis;
  detailPlan: DetailPlan | null;
  registrationTitle: string;
  detailHtml: string;
  timings: { category: number; materials: number; detail: number; register: number; total: number };
  media: {
    mainUrl: string | null;
    galleryUrls: string[];
    galleryCount: number;
    panelUrls: string[];
    panelCount: number;
    detailPreviewUrl: string | null;
    fallbackUsed: boolean;
  };
}

export interface PublicationResult {
  mode: "live" | "dry-run";
  originProductNo: string | null;
  channelProductNo: string | null;
  registeredAt: string | null;
  message: string;
  productUrl: string | null;
  liveStatus: "registered" | "ambiguous" | "failed";
  holdReasons: string[] | null;
}

export interface ListingResolution {
  categoryId?: string | null;
  categoryName?: string | null;
  salePrice?: number | null;
  originAreaCode?: string | null;
  originContent?: string | null;
  kcCertificationNumber?: string | null;
}

export interface ListingRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ListingStatus;
  stage: ListingStage;
  stageLabel: string;
  progress: number;
  photoUrls: string[];
  photoPaths: string[];
  sellerNote: string | null;
  draft: ListingDraft | null;
  materials: ListingMaterials | null;
  publication: PublicationResult | null;
  blockReasons: string[];
  warnings: string[];
  error: string | null;
  events: ListingEvent[];
}

export interface ListingSummary {
  id: string;
  createdAt: string;
  status: ListingStatus;
  stage: ListingStage;
  title: string | null;
  salePrice: number | null;
  imageUrl: string | null;
}

/* ── 라이브 이벤트 ───────────────────────────────────────────── */

export type LiveChannel =
  | "openai_raw"
  | "tool_call"
  | "tool_result"
  | "milestone"
  | "status"
  | "image"
  | "error";

export interface LiveEvent {
  seq: number;
  at: string;
  listingId: string;
  channel: LiveChannel | string;
  label: string;
  payload: unknown;
}

export interface RuntimeConfig {
  agentMode: "openai" | "demo";
  smartstoreMode: "live" | "dry-run";
  openaiReady: boolean;
  smartstoreReady: boolean;
}
