import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { env, hasLiveSmartstoreCredentials } from "./env.js";
import { linkHub } from "./link/hub.js";
import { renderPhonePage } from "./link/phone-page.js";
import { finalizeSellerNote } from "./link/scribe.js";
import { lanAddresses } from "./link/tls.js";
import { TunnelUnavailableError, activeTunnelUrl, ensureTunnel } from "./link/tunnel.js";
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
/** 메모 대조에 붙이는 사진 수 — 같은 물건을 열 각도에서 봐도 판단은 달라지지 않는다. */
const NOTE_VISION_PHOTOS = 6;
const NOTE_VISION_EDGE_PX = 768;

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

/** 모델에 바로 물릴 수 있게 줄여 인라인한다 — 디스크에 남길 이유가 없는 임시 판단용 사본이다. */
async function inlineDataUrl(file: Express.Multer.File): Promise<string> {
  const buffer = await sharp(file.buffer, { failOn: "none" })
    .rotate()
    .resize({
      width: NOTE_VISION_EDGE_PX,
      height: NOTE_VISION_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 72 })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
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

  const acceptPhotos = (req: Request, res: Response, next: NextFunction) => {
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
  };

  app.post(
    "/api/listings",
    acceptPhotos,
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

  /*
    마감 메모 — 폰이 촬영을 마치는 순간 데스크톱이 한 번 부른다. 말로 받아 적은 메모를
    찍은 사진과 대조해 완성하고, 그 결과가 그대로 등록 메모가 된다.

    이 호출은 등록의 **전제 조건이 아니다**. 실패하면 말한 그대로 돌려주고 등록은 계속
    간다 — 메모 정리 실패가 등록 자체를 막으면 그게 더 큰 사고다.
  */
  app.post("/api/link/note", acceptPhotos, (req: Request, res: Response) => {
    const spoken =
      typeof req.body?.note === "string" ? req.body.note.trim().slice(0, MAX_NOTE_LENGTH) : "";
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    void (async () => {
      try {
        const imageUrls = await Promise.all(files.slice(0, NOTE_VISION_PHOTOS).map(inlineDataUrl));
        res.json({ note: await finalizeSellerNote({ note: spoken, imageUrls }) });
      } catch (error) {
        console.warn("[note] 사진과 함께 정리 실패 — 말한 그대로 갑니다:", error);
        res.json({ note: spoken });
      }
    })();
  });

  // ── 폰 링크 ── 데스크톱이 세션을 만들고, 폰은 QR 로 /phone 에 들어와 WS 로 합류한다.
  const linkUrls = (code: string) => {
    const ips = lanAddresses();
    // 손으로 꽂은 공개 주소가 최우선이다 — 시연장에서 확실히 되는 길을 알고 있다면
    // 자동 탐색(퀵 터널)이 그걸 이겨서는 안 된다.
    const tunnel = env.LINK_PUBLIC_URL.replace(/\/+$/, "") || activeTunnelUrl();
    const lanUrls = ips.map((ip) => `https://${ip}:${env.LINK_HTTPS_PORT}/phone?s=${code}`);
    // 터널이 켜져 있으면 그쪽이 첫 번째다 — 어느 네트워크에서든 열리고 인증서 경고도 없다.
    const phoneUrls = tunnel ? [`${tunnel}/phone?s=${code}`, ...lanUrls] : lanUrls;
    return {
      code,
      phoneUrl: phoneUrls[0] ?? null,
      phoneUrls,
      tunnel,
      // QR 이 막혔을 때 폰에 직접 쳐 넣는 짧은 주소 — http(기본 스킴)로 받아 https 로 넘긴다.
      manualHost: ips[0] ? `${ips[0]}:${env.AGENT_API_PORT}/p` : null,
      httpsPort: env.LINK_HTTPS_PORT,
    };
  };

  app.post("/api/link/sessions", (_req, res) => {
    const { code } = linkHub.createSession();
    res.status(201).json(linkUrls(code));
  });

  // 인터넷 터널 — 같은 와이파이 제약이 걸릴 때의 구조대. 서버 수명 동안 하나를 공유한다.
  app.post("/api/link/tunnel", (_req, res) => {
    ensureTunnel()
      .then((url) => res.json({ ok: true, url }))
      .catch((error: unknown) => {
        const unavailable = error instanceof TunnelUnavailableError ? error : null;
        res.status(503).json({
          error: unavailable?.message ?? (error instanceof Error ? error.message : "터널 실패"),
          installed: unavailable?.installed ?? true,
        });
      });
  });

  // 핫스팟 전환 등으로 IP 가 바뀌면 같은 코드로 주소만 다시 뽑는다.
  app.get("/api/link/sessions/:code/urls", (req, res) => {
    const code = String(req.params.code ?? "").toUpperCase();
    if (!linkHub.sessionExists(code)) {
      res.status(404).json({ error: "세션이 없습니다 — 새로 열어주세요." });
      return;
    }
    res.json(linkUrls(code));
  });

  // 수동 입장 지름길 — 폰 브라우저는 스킴 없이 치면 http 로 붙는다. 여기서 https 폰 페이지로 보낸다.
  app.get("/p", (req, res) => {
    const ip = lanAddresses()[0] ?? "localhost";
    const code = typeof req.query.s === "string" ? `?s=${encodeURIComponent(req.query.s)}` : "";
    res.redirect(302, `https://${ip}:${env.LINK_HTTPS_PORT}/phone${code}`);
  });

  // 폰 페이지 — 프론트 빌드에 넣지 않는다. 빌드가 깨져도 폰 링크는 살아 있어야 한다.
  // 코드 없이 열면 페이지 안에서 6자리 코드를 직접 입력해 입장한다.
  app.get("/phone", (req, res) => {
    const code = typeof req.query.s === "string" ? req.query.s.toUpperCase() : "";
    res.type("html").send(renderPhonePage(code));
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
