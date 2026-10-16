import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import { useOptionalToastActions } from "@/context/ToastContext";
import { relativeTime } from "@/lib/utils";

type Lost = "device" | "server" | null;

/** A fetch that never reached the server (no signal, or the Mac not answering). */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

/** When the newest data on screen was loaded, or null when nothing is. */
export function lastLoadedAt(queryClient: QueryClient): number | null {
  let newest = 0;
  for (const query of queryClient.getQueryCache().findAll({ type: "active" })) {
    if (query.state.data !== undefined) newest = Math.max(newest, query.state.dataUpdatedAt);
  }
  return newest > 0 ? newest : null;
}

/**
 * A line across the top when the connection drops: what is wrong, how old the
 * lists on screen are, and a way to try again. The lists stay on screen; when
 * the connection is back they refresh by themselves. Nothing is stored on the
 * device.
 */
export function ConnectionNotice() {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const [lost, setLostState] = useState<Lost>(() =>
    typeof navigator !== "undefined" && navigator.onLine === false ? "device" : null,
  );
  const lostRef = useRef<Lost>(lost);
  // Queries whose last fetch never reached the server. One of them loading
  // again is proof the connection is back; a query that never goes to the
  // network (say, one read from this device) proves nothing.
  const failedRef = useRef(new Set<string>());
  const setLost = useCallback((next: Lost) => {
    lostRef.current = next;
    setLostState(next);
  }, []);
  const [checking, setChecking] = useState(false);
  const [stillDown, setStillDown] = useState(false);
  const [, setTick] = useState(0);

  const recovered = useCallback(() => {
    failedRef.current.clear();
    if (!lostRef.current) return;
    setLost(null);
    setStillDown(false);
    void queryClient.refetchQueries({ type: "active", predicate: (query) => query.state.status === "error" });
    toasts?.pushToast({ id: "connection-back", title: "Back online", body: "Lists are up to date again.", tone: "success" });
  }, [queryClient, setLost, toasts]);

  useEffect(() => {
    const goOffline = () => setLost("device");
    const goOnline = () => recovered();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type === "error" && isNetworkFailure(event.action.error)) {
        failedRef.current.add(event.query.queryHash);
        if (!lostRef.current) setLost("server");
      } else if (event.action.type === "success" && failedRef.current.has(event.query.queryHash)) {
        recovered();
      }
    });
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      unsubscribe();
    };
  }, [queryClient, recovered, setLost]);

  // Keep "loaded 5m ago" honest while the notice is up.
  useEffect(() => {
    if (!lost) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [lost]);

  if (!lost) return null;

  const tryAgain = async () => {
    setChecking(true);
    try {
      await healthApi.get();
      recovered();
    } catch {
      setStillDown(true);
    } finally {
      setChecking(false);
    }
  };

  const loadedAt = lastLoadedAt(queryClient);
  const what = lost === "device" ? "You are offline." : "GSAM is not answering.";
  const age = loadedAt ? ` Showing what was loaded ${relativeTime(new Date(loadedAt))}.` : "";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-notice"
      className="flex items-center gap-3 border-b border-border bg-status-warning-soft px-4 py-2 text-sm text-status-warning-foreground"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        {what}
        {age}
        {stillDown ? " Still no connection." : ""}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={() => void tryAgain()} disabled={checking}>
        {checking ? "Checking" : "Try again"}
      </Button>
    </div>
  );
}
