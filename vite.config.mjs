import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const AGENT_ORIGIN = process.env.AGENT_API_ORIGIN || "http://127.0.0.1:8788";

export default defineConfig({
  build: { outDir: "dist/client" },
  optimizeDeps: { include: ["react", "react-dom/client"] },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": { target: AGENT_ORIGIN, changeOrigin: true },
      "/runtime": { target: AGENT_ORIGIN, changeOrigin: true },
      // 세컨드 화면 — dev에서 /stream 링크가 SPA 폴백으로 새지 않게
      "/stream": { target: AGENT_ORIGIN, changeOrigin: true },
    },
    warmup: { clientFiles: ["./src/main.tsx"] },
  },
  plugins: [react()],
});
