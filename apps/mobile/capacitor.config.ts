import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.projectshanaya.companion",
  appName: "Shanaya",
  webDir: "../frontend/dist",
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
  },
  ios: { contentInset: "automatic" },
  android: { allowMixedContent: false },
};

export default config;
