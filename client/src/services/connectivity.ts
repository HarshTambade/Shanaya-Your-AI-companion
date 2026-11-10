import { useEffect, useState } from "react";
import { addNetworkStatusListener, getNetworkStatus } from "./AIService";

export function useConnectivity() {
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);

  useEffect(() => {
    let active = true;
    let networkListener: { remove: () => Promise<void> } | undefined;

    const setBrowserStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", setBrowserStatus);
    window.addEventListener("offline", setBrowserStatus);

    void getNetworkStatus().then((status) => {
      if (active) setIsOnline(status.connected && navigator.onLine);
    }).catch(() => setBrowserStatus());

    void addNetworkStatusListener((connected) => {
      if (active) setIsOnline(connected);
    }).then((listener) => {
      if (active) networkListener = listener;
      else void listener.remove();
    }).catch(() => undefined);

    return () => {
      active = false;
      window.removeEventListener("online", setBrowserStatus);
      window.removeEventListener("offline", setBrowserStatus);
      void networkListener?.remove();
    };
  }, []);

  return isOnline;
}
