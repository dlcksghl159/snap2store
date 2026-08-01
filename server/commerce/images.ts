import { readFile } from "node:fs/promises";
import sharp from "sharp";
// ⚠ multipart 의 FormData 도 반드시 npm undici 것. Node 전역 FormData 인스턴스는
// undici fetch 의 브랜드 체크에 걸려 직렬화되지 않고 서버가 415 를 반환한다.
// 값(Blob)은 전역 Blob 을 쓴다 (undici v7+ 는 자체 File/Blob 을 제거했다).
import { FormData as UndiciFormData } from "undici";
import { UPLOAD_TIMEOUT_MS, sleep } from "./http.js";
import { CommerceApiError } from "./errors.js";
import { uploadProductImages } from "./client.js";

const MIN_EDGE_PX = 300;
const MAX_EDGE_PX = 4000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RATIO = 2;
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 200;
const RATE_LIMIT_BACKOFF_MS = [500, 1000, 2000, 4000];

export interface PreparedImage {
  path: string;
  buffer: Buffer;
}

export interface PrepareResult {
  prepared: PreparedImage[];
  warnings: string[];
}

/**
 * 업로드 전 규격 검증 + JPEG 재인코딩.
 * 네이버는 WebP 를 거부한다 → 무조건 JPEG 로 재인코딩한다.
 */
export async function prepareImagesForUpload(paths: string[]): Promise<PrepareResult> {
  const prepared: PreparedImage[] = [];
  const warnings: string[] = [];

  for (const path of paths) {
    try {
      const raw = await readFile(path);
      const image = sharp(raw, { failOn: "none" }).rotate();
      const metadata = await image.metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;

      if (width === 0 || height === 0) {
        warnings.push(`이미지 규격 판독 실패로 제외: ${path}`);
        continue;
      }
      const shortEdge = Math.min(width, height);
      const longEdge = Math.max(width, height);
      if (shortEdge < MIN_EDGE_PX) {
        warnings.push(`이미지가 너무 작아 제외 (짧은 변 ${shortEdge}px < ${MIN_EDGE_PX}px): ${path}`);
        continue;
      }
      if (longEdge / shortEdge > MAX_RATIO) {
        warnings.push(`이미지 비율이 극단적이라 제외 (${width}×${height}): ${path}`);
        continue;
      }

      let pipeline = image;
      if (longEdge > MAX_EDGE_PX) {
        pipeline = pipeline.resize({
          width: MAX_EDGE_PX,
          height: MAX_EDGE_PX,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      let buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
      if (buffer.byteLength > MAX_BYTES) {
        buffer = await sharp(raw, { failOn: "none" })
          .rotate()
          .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      }
      if (buffer.byteLength > MAX_BYTES) {
        warnings.push(`이미지 용량이 20MB 를 넘어 제외: ${path}`);
        continue;
      }

      prepared.push({ path, buffer });
    } catch (error) {
      warnings.push(
        `이미지 준비 실패로 제외 (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { prepared, warnings };
}

function buildForm(images: PreparedImage[]): UndiciFormData {
  // ⚠ FormData 는 시도마다 새로 만든다 — fetch 가 스트림으로 소비해 재사용 불가.
  const form = new UndiciFormData();
  images.forEach((image, index) => {
    form.append(
      "imageFiles",
      new Blob([new Uint8Array(image.buffer)], { type: "image/jpeg" }),
      `snap2store_${Date.now()}_${index + 1}.jpg`,
    );
  });
  return form;
}

async function uploadBatch(images: PreparedImage[]): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt += 1) {
    try {
      const response = await uploadProductImages(buildForm(images), UPLOAD_TIMEOUT_MS);
      const urls = (response.images ?? [])
        .map((entry) => entry?.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      return urls;
    } catch (error) {
      lastError = error;
      // 429 만 백오프로 재시도한다.
      const retryable = error instanceof CommerceApiError && error.status === 429;
      if (!retryable || attempt === RATE_LIMIT_BACKOFF_MS.length) throw error;
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
    }
  }
  throw lastError;
}

export interface UploadResult {
  urlByPath: Map<string, string>;
  warnings: string[];
}

export async function uploadImagesToNaver(images: PreparedImage[]): Promise<UploadResult> {
  const urlByPath = new Map<string, string>();
  const warnings: string[] = [];
  if (images.length === 0) throw new Error("업로드할 이미지가 없습니다.");

  for (let offset = 0; offset < images.length; offset += BATCH_SIZE) {
    const batch = images.slice(offset, offset + BATCH_SIZE);
    if (offset > 0) await sleep(BATCH_PAUSE_MS);

    let urls: string[] = [];
    try {
      urls = await uploadBatch(batch);
    } catch (error) {
      warnings.push(
        `이미지 배치 업로드 실패 — 개별 재업로드로 전환합니다: ${error instanceof Error ? error.message : String(error)}`,
      );
      urls = [];
    }

    if (urls.length === batch.length) {
      batch.forEach((image, index) => urlByPath.set(image.path, urls[index]));
      continue;
    }

    // ⚠ 응답 URL 개수가 요청 개수와 다르면 순서 매핑을 신뢰할 수 없다
    //    → 1개씩 개별 재업로드해 1:1 매핑을 복구한다.
    if (urls.length > 0) {
      warnings.push(
        `업로드 응답 개수 불일치(요청 ${batch.length} / 응답 ${urls.length}) — 순서 매핑을 버리고 개별 업로드합니다.`,
      );
    }
    for (const image of batch) {
      try {
        const single = await uploadBatch([image]);
        if (single.length > 0) {
          urlByPath.set(image.path, single[0]);
        } else {
          warnings.push(`이미지 업로드 결과가 비어 제외: ${image.path}`);
        }
      } catch (error) {
        warnings.push(
          `이미지 업로드 실패로 제외 (${image.path}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(BATCH_PAUSE_MS);
    }
  }

  // 개별 실패는 drop, 전부 실패하면 throw (이미지 없는 상품 등록 방지).
  if (urlByPath.size === 0) {
    throw new Error(`이미지 업로드가 전부 실패했습니다: ${warnings.join(" / ")}`);
  }
  return { urlByPath, warnings };
}
