import { Capacitor } from "@capacitor/core";
import { Permissions } from "@capgo/capacitor-permissions";

export async function requestCallMicrophonePermission() {
  // Browser calls prompt through WebRTC; native CallKit/Telecom needs the app permission first.
  if (!Capacitor.isNativePlatform()) return true;

  try {
    const current = await Permissions.check({ permission: "microphone" });
    if (current.status === "granted") return true;

    const requested = await Permissions.request({ permission: "microphone" });
    return requested.status === "granted";
  } catch {
    // Treat unsupported or failed native permission APIs as a denial, never as consent.
    return false;
  }
}
