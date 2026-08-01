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

  // 기본값은 실제 등록이다. dry-run 은 사람이 고르는 모드가 아니라
  // 시스템이 스스로 내려앉는 바닥이다 (화면에 노출하지 않는다).
  SMARTSTORE_MODE: z.enum(["dry-run", "live"]).default("live"),

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
  SMARTSTORE_MODE: process.env.SMARTSTORE_MODE,
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
