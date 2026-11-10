import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { mobileClawVitePlugin } from "capacitor-mobile-claw/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    mobileClawVitePlugin(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Shanaya · AI Companion",
        short_name: "Shanaya",
        description: "A private, multilingual AI companion.",
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
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
