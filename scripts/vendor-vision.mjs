import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * MediaPipe wasm 을 node_modules 에서 public/vision/wasm 으로 복사한다.
 *
 * 왜 스크립트인가:
 *  - 폰 아이는 시연장 네트워크에 추론을 걸지 않는다. wasm 은 반드시 우리 오리진에서 나가야 한다.
 *  - 그렇다고 12MB 바이너리를 깃에 넣을 이유는 없다. 이미 의존성으로 들어와 있으니
 *    dev·build 직전에 복사하면 되고, 그러면 패키지 버전과 절대 어긋나지 않는다.
 *
 * 모델(.tflite)은 npm 패키지에 없어서 public/vision/models 에 커밋해 둔다.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const to = join(root, "public", "vision", "wasm");

// SIMD 빌드만 가져간다 — 맥 시연 브라우저(Chrome·Safari)는 전부 SIMD 를 지원한다.
const FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];

if (!existsSync(from)) {
  console.error("[vendor-vision] @mediapipe/tasks-vision 이 설치돼 있지 않습니다 — npm install 먼저.");
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(from, file), join(to, file));
}
console.log(`[vendor-vision] wasm ${FILES.length}개 복사 → public/vision/wasm`);
