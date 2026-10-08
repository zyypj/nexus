import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files itself in production.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    // WebView2 is evergreen Chromium.
    target: "chrome120",
    outDir: "dist",
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 800,
  },
  worker: { format: "es" },
});
