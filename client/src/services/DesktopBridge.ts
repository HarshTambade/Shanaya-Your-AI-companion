export type DesktopScreenshot = { base64: string; mediaType: "image/png" | "image/jpeg" };

export type DesktopBridge = {
  confirmAction: (action: string, input: Record<string, unknown>) => Promise<string | null>;
  screenshot: (approvalToken: string) => Promise<DesktopScreenshot>;
  perform: (action: string, input: Record<string, unknown>, approvalToken: string) => Promise<void>;
};

declare global {
  interface Window {
    shanayaDesktop?: DesktopBridge;
  }
}

export function getDesktopBridge() {
  return typeof window === "undefined" ? undefined : window.shanayaDesktop;
}
