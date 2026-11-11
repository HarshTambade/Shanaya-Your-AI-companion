import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Reuse the committed avatar, Draco decoder, and circuit backdrop assets from
// the primary client so the Python Edition does not publish broken /models URLs.
const sharedPublicDir = fileURLToPath(new URL("../../client/public", import.meta.url));

export default defineConfig({
  envDir: "../..",
  publicDir: sharedPublicDir,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": process.env.VITE_API_BASE_URL || "http://127.0.0.1:8000",
    },
  },
  build: { sourcemap: false },
});
