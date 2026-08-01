import { z } from "zod";

export const EvidenceFactSchema = z.object({
  kind: z.enum(["observed", "verified", "configured", "inferred", "unresolved"]),
  claim: z.string().trim().min(1).max(240),
  source: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
  blocksPublishing: z.boolean(),
});

export const DetailSectionSchema = z.object({
  heading: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(500),
});

export const SpecFactSchema = z.object({
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(120),
});

export const ListingDraftSchema = z.object({
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(300),
  categoryQuery: z.string().trim().min(1).max(100),
  categoryName: z.string().trim().min(1).max(160),
  categoryId: z.string().trim().min(1).nullable(),
  salePrice: z.number().int().min(0).max(100_000_000),
  priceBasis: z.string().trim().max(500),
  stockQuantity: z.number().int().min(0).max(99_999),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
  detailSections: z.array(DetailSectionSchema).min(2).max(6),
  labelTexts: z.array(z.string().trim().min(1).max(200)).max(30),
  originMarking: z.string().trim().min(1).max(120).nullable(),
  specFacts: z.array(SpecFactSchema).max(12),
  brandObserved: z.string().trim().min(1).max(60).nullable(),
  brandVerified: z.boolean(),
  modelName: z.string().trim().min(1).max(100).nullable(),
  manufacturerName: z.string().trim().min(1).max(80).nullable(),
  facts: z.array(EvidenceFactSchema).min(1).max(30),
  riskLevel: z.enum(["low", "medium", "high"]),
  canAutoPublish: z.boolean(),
  blockReasons: z.array(z.string().trim().min(1).max(240)).max(12),
});

export type ListingDraftParsed = z.infer<typeof ListingDraftSchema>;
