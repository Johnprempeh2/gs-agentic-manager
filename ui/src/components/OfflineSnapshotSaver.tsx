import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { clearSnapshots, saveSnapshot, snapshotPageFor } from "@/lib/offline-snapshot";

/** Wait for a page to settle before saving it, so one load writes once. */
const SAVE_DELAY_MS = 2000;

/**
 * Keeps the saved copy of the Inbox, Needed from you, client list and Today
 * current while one of them is open, and removes every saved copy once the
 * session is gone.
 */
export function OfflineSnapshotSaver() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const page = snapshotPageFor(location.pathname);

  useEffect(() => {
    if (!page) return;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        saveSnapshot(queryClient, page);
      }, SAVE_DELAY_MS);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") schedule();
    });
    schedule();
    // Leaving or reloading inside the wait would otherwise keep the copy from
    // before a change just saved (a pause, an archive), and it would come back.
    const saveNow = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      saveSnapshot(queryClient, page);
    };
    window.addEventListener("pagehide", saveNow);
    return () => {
      // Moving to another page saves nothing: its lists may already be gone.
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", saveNow);
      unsubscribe();
    };
  }, [page, queryClient]);

  // Signed out (here or elsewhere): the session comes back empty.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "success" &&
          event.query.queryKey[0] === queryKeys.auth.session[0] &&
          event.query.queryKey[1] === queryKeys.auth.session[1] &&
          event.action.data == null
        ) {
          clearSnapshots();
        }
      }),
    [queryClient],
  );

  return null;
}
