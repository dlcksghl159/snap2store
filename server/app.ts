import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { env, hasLiveSmartstoreCredentials } from "./env.js";
import { subscribeLiveEvents } from "./live-events.js";
import { STREAM_PAGE_HTML } from "./stream-page.js";
import {
  ensureListingAssetDirectory,
  getListing,
  insertListing,
  listListings,
  listingAssetUrl,
  updateListing,
} from "./store.js";
import { runPipeline } from "./pipeline.js";
import type { ListingRecord, ListingResolution, RuntimeConfig } from "../src/domain/types";

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_NOTE_LENGTH = 2000;
const MIN_SHORT_EDGE_PX = 240;
const MAX_LONG_EDGE_PX = 2400;

const ACCEPTED_MIME = /^image\/(jpe?g|png|webp|heic|heif|avif)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS },
  fileFilter: (_req, file, callback) => {
    if (ACCEPTED_MIME.test(file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new UploadRejection(`지원하지 않는 파일 형식입니다: ${file.mimetype}`));
  },
});

class UploadRejection extends Error {}

/** 시간차 이중 실행 방어 — register.ts 의 락은 "동시에 겹치는" 호출만 막는다. */
const activeRestarts = new Set<string>();

function emptyRecord(id: string): ListingRecord {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    stage: "queued",
    stageLabel: "대기 중",
    progress: 2,
    photoUrls: [],
    photoPaths: [],
    sellerNote: null,
    draft: null,
    materials: null,
    publication: null,
    blockReasons: [],
    warnings: [],
    error: null,
    events: [],
  };
}

async function normalizePhotos(
  listingId: string,
  files: Express.Multer.File[],
): Promise<{ paths: string[]; urls: string[] }> {
  const dir = await ensureListingAssetDirectory(listingId);
  const paths: string[] = [];
  const urls: string[] = [];

  for (const [index, file] of files.entries()) {
    const filename = `photo-${index + 1}.jpg`;
    const target = path.join(dir, filename);
    let normalized: Buffer;
    let metadata: sharp.Metadata;
    try {
      const pipeline = sharp(file.buffer, { failOn: "none" }).rotate();
      metadata = await pipeline.metadata();
      normalized = await pipeline
        .resize({ width: MAX_LONG_EDGE_PX, height: MAX_LONG_EDGE_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (error) {
      throw new UploadRejection(
        `사진 ${index + 1}장째를 읽지 못했습니다 (${file.originalname}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const shortEdge = Math.min(width, height);
    if (shortEdge > 0 && shortEdge < MIN_SHORT_EDGE_PX) {
      throw new UploadRejection(
        `사진 ${index + 1}장째가 너무 작습니다 — 짧은 변이 ${MIN_SHORT_EDGE_PX}px 이상이어야 합니다 (현재 ${shortEdge}px).`,
      );
    }

    await writeFile(target, normalized);
    paths.push(target);
    urls.push(listingAssetUrl(listingId, filename));
  }

  return { paths, urls };
}

function publicConfig(): RuntimeConfig {
  return {
    agentMode: env.useOpenAI ? "openai" : "demo",
    smartstoreMode: env.SMARTSTORE_MODE,
    openaiReady: Boolean(env.OPENAI_API_KEY),
    smartstoreReady: env.SMARTSTORE_MODE === "dry-run" || hasLiveSmartstoreCredentials(),
  };
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // 키 값 자체는 절대 내보내지 않는다.
  app.get("/api/config", (_req, res) => {
    res.json(publicConfig());
  });

  app.get("/api/listings", async (_req, res, next) => {
    try {
      res.json(await listListings());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/listings/:id", async (req, res, next) => {
    try {
      const listing = await getListing(req.params.id);
      if (!listing) {
        res.status(404).json({ error: "리스팅을 찾을 수 없습니다." });
        return;
      }
      res.json(listing);
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/listings",
    (req: Request, res: Response, next: NextFunction) => {
      upload.array("photos", MAX_PHOTOS)(req, res, (error: unknown) => {
        if (error) {
          const message =
            error instanceof multer.MulterError
              ? error.code === "LIMIT_FILE_SIZE"
                ? `사진 한 장은 ${MAX_PHOTO_BYTES / 1024 / 1024}MB 이하여야 합니다.`
                : error.code === "LIMIT_FILE_COUNT"
                  ? `사진은 최대 ${MAX_PHOTOS}장까지 올릴 수 있습니다.`
                  : error.message
              : error instanceof Error
                ? error.message
                : "업로드에 실패했습니다.";
          res.status(400).json({ error: message });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          res.status(400).json({ error: "사진을 최소 한 장 올려주세요." });
          return;
        }

        const rawNote = typeof req.body?.note === "string" ? req.body.note : "";
        const sellerNote = rawNote.trim().slice(0, MAX_NOTE_LENGTH) || null;

        const listingId = randomUUID();
        let photos: { paths: string[]; urls: string[] };
        try {
          photos = await normalizePhotos(listingId, files);
        } catch (error) {
          if (error instanceof UploadRejection) {
            res.status(400).json({ error: error.message });
            return;
          }
          throw error;
        }

        const record = emptyRecord(listingId);
        record.photoPaths = photos.paths;
        record.photoUrls = photos.urls;
        record.sellerNote = sellerNote;
        await insertListing(record);

        // 파이프라인을 await 하지 않고 시작하고 202 를 즉시 반환한다.
        // 최외곽 catch 는 unhandled rejection 방지선이다.
        void runPipeline({ listingId }).catch((error: unknown) => {
          console.error(`[pipeline] ${listingId} 최외곽 실패:`, error);
        });

        res.status(202).json({ id: listingId });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── 자율성 계약 밖의 보조 기능. 시연 중에는 절대 쓰지 않는다. ──
  const restart = async (req: Request, res: Response, next: NextFunction, resolution: ListingResolution | null) => {
    const id = String(req.params.id ?? "");
    try {
      const listing = await getListing(id);
      if (!listing) {
        res.status(404).json({ error: "리스팅을 찾을 수 없습니다." });
        return;
      }
      if (listing.status === "running" || listing.status === "queued") {
        res.status(409).json({ error: "이미 실행 중입니다." });
        return;
      }
      if (!listing.draft) {
        res.status(400).json({ error: "저장된 등록안이 없습니다 — 처음부터 다시 올려주세요." });
        return;
      }
      if (activeRestarts.has(id)) {
        res.status(409).json({ error: "이미 재실행이 진행 중입니다." });
        return;
      }
      activeRestarts.add(id);
      void runPipeline({ listingId: id, resumeFromDraft: true, resolution })
        .catch((error: unknown) => {
          console.error(`[pipeline] ${id} 재실행 실패:`, error);
        })
        .finally(() => {
          activeRestarts.delete(id);
        });
      res.status(202).json({ id });
    } catch (error) {
      activeRestarts.delete(id);
      next(error);
    }
  };

  app.post("/api/listings/:id/retry", (req, res, next) => {
    void restart(req, res, next, null);
  });

  app.post("/api/listings/:id/resolve", (req, res, next) => {
    const body = (req.body ?? {}) as ListingResolution;
    const resolution: ListingResolution = {
      categoryId: typeof body.categoryId === "string" ? body.categoryId : null,
      categoryName: typeof body.categoryName === "string" ? body.categoryName : null,
      salePrice: typeof body.salePrice === "number" ? body.salePrice : null,
      originAreaCode: typeof body.originAreaCode === "string" ? body.originAreaCode : null,
      originContent: typeof body.originContent === "string" ? body.originContent : null,
      kcCertificationNumber:
        typeof body.kcCertificationNumber === "string" ? body.kcCertificationNumber : null,
    };
    void restart(req, res, next, resolution);
  });

  app.get("/api/stream", (_req, res) => {
    subscribeLiveEvents(res);
  });

  app.get("/stream", (_req, res) => {
    res.type("html").send(STREAM_PAGE_HTML);
  });

  app.use("/runtime", express.static(env.runtimeRoot, { fallthrough: false, etag: true }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] 처리되지 않은 오류:", error);
    if (res.headersSent) return;
    res.status(500).json({ error: error instanceof Error ? error.message : "서버 오류" });
  });

  return app;
}

export { updateListing };
