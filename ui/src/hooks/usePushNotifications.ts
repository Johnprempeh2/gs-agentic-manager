import { useCallback, useEffect, useState } from "react";
import { pushApi } from "../api/push";

export type PushState = "unsupported" | "needs-home-screen" | "denied" | "off" | "on" | "working";

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos() {
  return typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/**
 * This phone's decision notifications for the company. On iPhone, Web Push
 * exists only in the Home Screen app, so a Safari tab reports
 * `needs-home-screen`. Turning on must come from a tap (the permission
 * prompt requires it).
 */
export function usePushNotifications(companyId: string | null | undefined) {
  const [state, setState] = useState<PushState>(() => {
    if (pushSupported()) return "off";
    return isIos() ? "needs-home-screen" : "unsupported";
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId || !pushSupported()) return;
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    let cancelled = false;
    void (async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) return;
      const config = await pushApi.config(companyId, subscription.endpoint);
      if (!cancelled) setState(config.subscribed ? "on" : "off");
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const enable = useCallback(async () => {
    if (!companyId || !pushSupported()) return;
    setError(null);
    setState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await pushApi.config(companyId);
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }));
      const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("This phone did not return a usable subscription.");
      await pushApi.subscribe(companyId, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setState("on");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not turn on notifications.");
      setState("off");
    }
  }, [companyId]);

  const disable = useCallback(async () => {
    if (!companyId || !pushSupported()) return;
    setError(null);
    setState("working");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await pushApi.unsubscribe(companyId, subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not turn off notifications.");
      setState("on");
    }
  }, [companyId]);

  const sendTest = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    try {
      const result = await pushApi.test(companyId);
      if (result.delivered === 0) setError("No phone received the test. Turn notifications off and on again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send a test.");
    }
  }, [companyId]);

  return { state, error, enable, disable, sendTest };
}

/** Mirror a count onto the Home Screen app icon, where the platform allows it. */
export function useAppBadge(count: number) {
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (typeof nav.setAppBadge !== "function") return;
    void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => undefined);
  }, [count]);
}
