import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 로컬 패키지로 로드한다 — 외부 CDN 의존은 시연장 네트워크에서 위험하다.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import App from "./App";
import { PreviewApp, previewModeFromLocation } from "./preview";
import { EyeLab, eyeLabRequested } from "./eye-lab";

const root = createRoot(document.getElementById("root")!);
const preview = previewModeFromLocation();

root.render(
  <StrictMode>
    {eyeLabRequested() ? <EyeLab /> : preview ? <PreviewApp mode={preview} /> : <App />}
  </StrictMode>,
);
