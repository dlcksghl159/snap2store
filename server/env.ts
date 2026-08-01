import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const projectRoot = process.cwd();

// ⚠ 로딩 순서와 override 가 핵심이다.
// `.env.local` 이 이 앱의 진실의 원천이다. override: true 없이는 셸에 export된 낡은
// OPENAI_API_KEY 가 파일 값을 조용히 이기고, "파일을 고쳤는데 반영이 안 되는" 사고가 난다.
loadDotEnv({ path: path.join(projectRoot, ".env.local"), quiet: true, override: true });
loadDotEnv({ path: path.join(projectRoot, ".env"), quiet: true });

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined);

// 클라이언트 시크릿은 bcrypt salt 형식($2a$…)이다. 변수 확장을 하는 로더에서 복사해 온
// 값은 `\$` 로 이스케이프되어 있어 그대로 쓰면 `Invalid salt version` 이 난다.
const optionalEscapedSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => {
    const cleaned = v?.replace(/\\\$/g, "$").trim();
    return cleaned || undefined;
  });

const EnvironmentSchema = z.object({
  OPENAI_API_KEY: optionalSecret,
  // 지연이 전부다. 같은 세대에서 더 빠른 변종이 나오면 교체한다.
  OPENAI_MODEL: z.string().trim().default("gpt-5.6-luna"),
  OPENAI_IMAGE_MODEL: z.string().trim().default("gpt-image-2"),
  AGENT_MODE: z.enum(["auto", "demo", "openai"]).default("auto"),
  AGENT_API_PORT: z.coerce.number().int().min(1024).max(65535).default(8788),

  // 폰 링크 — 폰 카메라(getUserMedia)는 보안 컨텍스트 필수라 LAN 접속용 HTTPS 포트를 따로 연다.
  LINK_HTTPS_PORT: z.coerce.number().int().min(1024).max(65535).default(8443),
  // auto = 부팅 때 cloudflared 퀵 터널을 미리 연다 (같은 와이파이 제약·인증서 경고 제거).
  LINK_TUNNEL: z.enum(["off", "auto"]).default("off"),
  /**
   * 밖에서 이 서버(API 포트)로 들어오는 공개 주소. 설정되면 QR 이 무조건 이쪽을 가리킨다.
   *
   * ⚠ 시연장 와이파이는 기기끼리의 통신을 막는 경우가 흔하다(AP 격리). 그러면 LAN 직결은
   * 무슨 짓을 해도 안 되고, 계정 없는 cloudflared 퀵 터널은 레이트 리밋(1015)에 걸린다 —
   * 둘 다 우리 통제 밖이다. 그래서 "어떤 터널이든 꽂을 수 있는 구멍"을 하나 둔다:
   * ngrok · Cloudflare named tunnel · tailscale funnel 무엇이든 8788 로 내보내고 그 주소를 여기에.
   * 예: LINK_PUBLIC_URL=https://snap2store.ngrok.app
   */
  LINK_PUBLIC_URL: z.string().trim().default(""),
  /**
   * 판매권한이 없는 카테고리(식품 등)에 막혔을 때 갈아탈 리프 카테고리 ID 목록(쉼표 구분).
   * 계정이 실제로 등록할 수 있는 곳만 넣는다 — 권한 없는 ID 를 넣으면 벽을 벽으로 바꾼다.
   * 비우면 코드 기본값을 쓰고, "off" 로 두면 갈아타지 않고 권한 신청 안내로 끝낸다.
   */
  PUBLISH_FALLBACK_CATEGORIES: z.string().trim().default(""),
  // 발화 → 메모 서기의 기본 경로: 최신 realtime 모델이 소리를 직접 이해해 메모를 쓴다(1홉).
  VOICE_REALTIME_MODEL: z.string().trim().default("gpt-realtime-2.1"),
  // 자막(입력 전사) 사이드카 + 폴백 경로의 전사 모델. 정확도 우선 기본값.
  VOICE_TRANSCRIBE_MODEL: z.string().trim().default("gpt-4o-transcribe"),
  VOICE_LANGUAGE: z.string().trim().default("ko"),
  // 폴백(전사+서기 2홉)에서 메모를 정리하는 텍스트 모델. 비우면 OPENAI_MODEL.
  VOICE_SCRIBE_MODEL: z.string().trim().default(""),

  // 기본값은 실제 등록이다. dry-run 은 사람이 고르는 모드가 아니라
  // 시스템이 스스로 내려앉는 바닥이다 (화면에 노출하지 않는다).
  SMARTSTORE_MODE: z.enum(["dry-run", "live"]).default("live"),
  // off = 판정·보류 게이트(고위험, KC 보류, 프리플라이트 차단)를 경고로만 남기고 완주한다.
  RISK_GATE: z.enum(["on", "off"]).default("on"),

  NAVER_COMMERCE_CLIENT_ID: optionalSecret,
  NAVER_COMMERCE_CLIENT_SECRET: optionalEscapedSecret,
  COMMERCE_PROXY_URL: optionalSecret,

  NAVER_SEARCHAD_CUSTOMER_ID: optionalSecret,
  NAVER_SEARCHAD_API_KEY: optionalSecret,
  NAVER_SEARCHAD_SECRET_KEY: optionalSecret,

  SMARTSTORE_DEFAULTS_PATH: z.string().trim().default("config/smartstore.local.json"),
});

const parsed = EnvironmentSchema.parse({
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,
  AGENT_MODE: process.env.AGENT_MODE,
  AGENT_API_PORT: process.env.AGENT_API_PORT,
  LINK_HTTPS_PORT: process.env.LINK_HTTPS_PORT,
  LINK_TUNNEL: process.env.LINK_TUNNEL,
  LINK_PUBLIC_URL: process.env.LINK_PUBLIC_URL,
  PUBLISH_FALLBACK_CATEGORIES: process.env.PUBLISH_FALLBACK_CATEGORIES,
  VOICE_REALTIME_MODEL: process.env.VOICE_REALTIME_MODEL,
  VOICE_TRANSCRIBE_MODEL: process.env.VOICE_TRANSCRIBE_MODEL,
  VOICE_LANGUAGE: process.env.VOICE_LANGUAGE,
  VOICE_SCRIBE_MODEL: process.env.VOICE_SCRIBE_MODEL,
  SMARTSTORE_MODE: process.env.SMARTSTORE_MODE,
  RISK_GATE: process.env.RISK_GATE,
  NAVER_COMMERCE_CLIENT_ID: process.env.NAVER_COMMERCE_CLIENT_ID,
  NAVER_COMMERCE_CLIENT_SECRET: process.env.NAVER_COMMERCE_CLIENT_SECRET,
  COMMERCE_PROXY_URL: process.env.COMMERCE_PROXY_URL,
  NAVER_SEARCHAD_CUSTOMER_ID: process.env.NAVER_SEARCHAD_CUSTOMER_ID,
  NAVER_SEARCHAD_API_KEY: process.env.NAVER_SEARCHAD_API_KEY,
  NAVER_SEARCHAD_SECRET_KEY: process.env.NAVER_SEARCHAD_SECRET_KEY,
  SMARTSTORE_DEFAULTS_PATH: process.env.SMARTSTORE_DEFAULTS_PATH,
});

export const env = {
  ...parsed,
  projectRoot,
  // RUNTIME_ROOT 오버라이드는 테스트 격리용 — 실런타임을 공유하면
  // 스토어 초기화 테스트가 실제 등록 이력을 지운다 (복구 불가).
  runtimeRoot: process.env.RUNTIME_ROOT
    ? path.resolve(projectRoot, process.env.RUNTIME_ROOT)
    : path.join(projectRoot, "data", "runtime"),
  cacheRoot: path.join(projectRoot, "data", "cache"),
  resolvedSmartstoreDefaultsPath: path.resolve(projectRoot, parsed.SMARTSTORE_DEFAULTS_PATH),
  useOpenAI:
    parsed.AGENT_MODE === "openai" ||
    (parsed.AGENT_MODE === "auto" && Boolean(parsed.OPENAI_API_KEY)),
};

export function hasLiveSmartstoreCredentials(): boolean {
  return Boolean(
    env.SMARTSTORE_MODE === "live" &&
      env.NAVER_COMMERCE_CLIENT_ID &&
      env.NAVER_COMMERCE_CLIENT_SECRET,
  );
}

export function hasCommerceCredentials(): boolean {
  return Boolean(env.NAVER_COMMERCE_CLIENT_ID && env.NAVER_COMMERCE_CLIENT_SECRET);
}

export function hasSearchAdCredentials(): boolean {
  return Boolean(
    env.NAVER_SEARCHAD_CUSTOMER_ID &&
      env.NAVER_SEARCHAD_API_KEY &&
      env.NAVER_SEARCHAD_SECRET_KEY,
  );
}
