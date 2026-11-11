import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { mobileClawVitePlugin } from "capacitor-mobile-claw/vite-plugin";
import { shanayaSeoPlugin } from "./scripts/seoPlugin";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mobileClawVitePlugin(),
    shanayaSeoPlugin({ mode }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "social-card.svg"],
      manifest: {
        id: "/",
        name: "Shanaya · AI Companion",
        short_name: "Shanaya",
        description: "A multilingual AI companion with a living 3D avatar, voice chat, and optional on-device AI.",
        theme_color: "#080b14",
        background_color: "#080b14",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,wasm}"],
        runtimeCaching: [{
          urlPattern: /\/models\/.*\.glb$/,
          handler: "CacheFirst",
          options: {
            cacheName: "shanaya-avatar-models",
            expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
          },
        }],
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        about: resolve(projectRoot, "about/index.html"),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
}));
