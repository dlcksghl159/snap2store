/**
 * 상세 HTML 직렬화 — 네이버 상세는 se-viewer 규격이다.
 * 모바일에서 "원본보기" 폴백을 유발하는 네 가지를 구조적으로 배제한다:
 *  ① 외부 이미지 (pstatic.net 만 허용)
 *  ② 금지 태그 (a link iframe script style form table/thead/tbody/tr/td/th)
 *  ③ 표 (<table> 대신 inline-block 50% div 그리드)
 *  ④ <span> 의 font-size (font-size 는 반드시 <p> 레벨에)
 */
import type { SectionRole, SpecFact } from "../../src/domain/types";

export const NAVER_TRUSTED_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*pstatic\.net\//i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrap(inner: string): string {
  return `<div class="se-viewer se-theme-default" lang="ko-KR"><div class="se-main-container" style="width:100%;max-width:860px;margin:0 auto;">${inner}</div></div>`;
}

interface ImageFilterResult {
  urls: string[];
  dropped: string[];
}

function filterImageUrls(urls: Array<string | null | undefined>, trustAll: boolean): ImageFilterResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (trustAll || NAVER_TRUSTED_HOST_RE.test(url)) kept.push(url);
    else dropped.push(url);
  }
  return { urls: kept, dropped };
}

function imageBlock(url: string, alt: string, seamless = false): string {
  // 패널 이미지는 font-size:0; line-height:0 래퍼로 감싸 여백을 0으로 —
  // 연속 배치 시 한 장의 긴 페이지처럼 읽힌다.
  const wrapperStyle = seamless
    ? "display:block;width:100%;margin:0;font-size:0;line-height:0;"
    : "display:block;width:100%;margin:0;";
  return `<div style="${wrapperStyle}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="display:block;width:100%;max-width:860px;height:auto;margin:0 auto;" /></div>`;
}

function sectionBlock(heading: string, body: string): string {
  return `<div style="max-width:760px;margin:0 auto;padding:32px 24px;border-bottom:1px solid #ececec;"><p style="font-size: 20px;margin:0 0 12px;line-height:1.4;color:#111;font-weight:700;">${escapeHtml(heading)}</p><p style="font-size: 15px;margin:0;line-height:1.8;color:#444;white-space:pre-line;">${escapeHtml(body)}</p></div>`;
}

function headerBlock(headline: string, subheadline: string): string {
  const parts = [
    `<p style="font-size: 28px;margin:0 0 10px;line-height:1.3;color:#111;font-weight:800;">${escapeHtml(headline)}</p>`,
  ];
  if (subheadline.trim()) {
    parts.push(
      `<p style="font-size: 17px;margin:0;line-height:1.6;color:#555;font-weight:500;">${escapeHtml(subheadline)}</p>`,
    );
  }
  return `<div style="max-width:760px;margin:0 auto;padding:44px 24px 28px;text-align:center;">${parts.join("")}</div>`;
}

function hooksBlock(hooks: Array<{ label: string; value: string }>): string {
  if (hooks.length === 0) return "";
  const cells = hooks
    .map(
      (hook) =>
        `<div style="display:inline-block;width:${hooks.length >= 4 ? "25%" : "33%"};vertical-align:top;padding:6px 8px;text-align:center;"><p style="font-size: 13px;margin:0 0 4px;line-height:1.4;color:#3160f0;font-weight:700;">${escapeHtml(hook.label)}</p><p style="font-size: 14px;margin:0;line-height:1.5;color:#333;font-weight:500;">${escapeHtml(hook.value)}</p></div>`,
    )
    .join("");
  return `<div style="max-width:760px;margin:0 auto;padding:22px 16px;border-top:1px solid #ececec;border-bottom:1px solid #ececec;font-size:0;">${cells}</div>`;
}

function closingBlock(closing: string): string {
  if (!closing.trim()) return "";
  return `<div style="max-width:760px;margin:0 auto;padding:40px 24px;text-align:center;"><p style="font-size: 18px;margin:0;line-height:1.6;color:#111;font-weight:700;">${escapeHtml(closing)}</p></div>`;
}

/** ⚠ <table> 대신 inline-block 50% div 그리드. */
function specGrid(rows: SpecFact[]): string {
  if (rows.length === 0) return "";
  const cells = rows
    .map(
      (row) =>
        `<div style="display:inline-block;width:50%;vertical-align:top;padding:10px 8px;"><p style="font-size: 12px;margin:0 0 2px;line-height:1.4;color:#8b8b8b;font-weight:600;">${escapeHtml(row.label)}</p><p style="font-size: 14px;margin:0;line-height:1.5;color:#222;font-weight:500;">${escapeHtml(row.value)}</p></div>`,
    )
    .join("");
  return `<div style="max-width:760px;margin:0 auto;padding:34px 16px 10px;"><div style="border-top:2px solid #111;padding-top:16px;"><p style="font-size: 15px;margin:0 0 8px;line-height:1.4;color:#111;font-weight:700;">상품 정보</p><div style="font-size:0;">${cells}</div></div></div>`;
}

function noticeBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  const items = lines
    .map(
      (line) =>
        `<p style="font-size: 13px;margin:0 0 6px;line-height:1.7;color:#777;">· ${escapeHtml(line)}</p>`,
    )
    .join("");
  return `<div style="max-width:760px;margin:0 auto;padding:24px 24px 48px;"><p style="font-size: 14px;margin:0 0 10px;line-height:1.4;color:#333;font-weight:700;">배송 · 교환/반품 안내</p>${items}</div>`;
}

export interface ShowcaseDetailInput {
  headline: string;
  subheadline: string;
  hooks: Array<{ label: string; value: string }>;
  sections: Array<{ role: SectionRole; heading: string; body: string; imageUrl: string | null }>;
  closing: string;
  heroImageUrl?: string | null;
  extraImageUrls?: string[];
  specRows: SpecFact[];
  noticeLines: string[];
  productAlt: string;
  /** 업로드 전(로컬 URL) 상황에서만 true. 실전송에서 켜면 상세에 로컬 URL이 실려 모바일이 깨진다. */
  trustAllImageHosts?: boolean;
}

export interface DetailContentResult {
  html: string;
  droppedImageUrls: string[];
}

export function buildShowcaseDetailContent(input: ShowcaseDetailInput): DetailContentResult {
  const trustAll = Boolean(input.trustAllImageHosts);
  const dropped: string[] = [];
  const blocks: string[] = [];

  blocks.push(headerBlock(input.headline, input.subheadline));

  const panelUrls = input.sections.map((section) => section.imageUrl);
  const panels = filterImageUrls(panelUrls, trustAll);
  dropped.push(...panels.dropped);
  const allowedPanels = new Set(panels.urls);

  // 패널이 하나도 없을 때만 히어로 이미지를 세운다.
  if (allowedPanels.size === 0 && input.heroImageUrl) {
    const hero = filterImageUrls([input.heroImageUrl], trustAll);
    dropped.push(...hero.dropped);
    if (hero.urls[0]) blocks.push(imageBlock(hero.urls[0], input.productAlt));
  }

  blocks.push(hooksBlock(input.hooks));

  for (const section of input.sections) {
    if (section.imageUrl && allowedPanels.has(section.imageUrl)) {
      blocks.push(imageBlock(section.imageUrl, `${input.productAlt} — ${section.heading}`, true));
    }
    blocks.push(sectionBlock(section.heading, section.body));
  }

  const extras = filterImageUrls(input.extraImageUrls ?? [], trustAll);
  dropped.push(...extras.dropped);
  for (const url of extras.urls) blocks.push(imageBlock(url, input.productAlt));

  blocks.push(closingBlock(input.closing));
  blocks.push(specGrid(input.specRows));
  blocks.push(noticeBlock(input.noticeLines));

  const inner = blocks.filter(Boolean).join("");
  return {
    html: wrap(inner || `<p style="font-size: 15px;margin:0;">상세설명 준비 중</p>`),
    droppedImageUrls: [...new Set(dropped)],
  };
}

export interface BasicDetailInput {
  title: string;
  summary: string;
  imageUrls: string[];
  sections: Array<{ heading: string; body: string }>;
  specRows: SpecFact[];
  noticeLines: string[];
  trustAllImageHosts?: boolean;
}

/** 기획 실패 시 폴백. */
export function buildDetailContent(input: BasicDetailInput): DetailContentResult {
  const trustAll = Boolean(input.trustAllImageHosts);
  const images = filterImageUrls(input.imageUrls, trustAll);
  const blocks: string[] = [headerBlock(input.title, input.summary)];

  if (images.urls[0]) blocks.push(imageBlock(images.urls[0], input.title));
  for (const section of input.sections) blocks.push(sectionBlock(section.heading, section.body));
  for (const url of images.urls.slice(1)) blocks.push(imageBlock(url, input.title));
  blocks.push(specGrid(input.specRows));
  blocks.push(noticeBlock(input.noticeLines));

  const inner = blocks.filter(Boolean).join("");
  return {
    html: wrap(inner || `<p style="font-size: 15px;margin:0;">상세설명 준비 중</p>`),
    droppedImageUrls: images.dropped,
  };
}

/** 상세 미리보기 자산 — 결과 화면이 iframe 으로 연다. */
export function buildDetailPreviewDocument(detailHtml: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>상세 미리보기</title></head><body style="margin:0;background:#fff;">${detailHtml}</body></html>`;
}
