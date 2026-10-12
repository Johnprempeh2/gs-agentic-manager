import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { tourDismissalsApi, type TourDismissal } from "@/api/tourDismissals";
import { ALL_TOURS, type TourDefinition } from "@/lib/feature-tours";
import { queryKeys } from "@/lib/queryKeys";

type TourRef = Pick<TourDefinition, "id" | "version">;

/** This browser's copy of "seen": the fallback when the server cannot be reached. */
export function tourSeenKey(tour: TourRef, userId: string) {
  return `gsam.tour.${tour.id}.v${tour.version}.${userId}`;
}
const migratedKey = (userId: string) => `gsam.tour.migrated.${userId}`;

/** true/false, or null when storage is blocked. */
function readFlag(key: string): boolean | null {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return null;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked; the server copy still counts.
  }
}

const matches = (tour: TourRef) => (row: TourDismissal) => row.tourKey === tour.id && row.tourVersion === tour.version;

/**
 * Which tours the signed-in person has finished or skipped, kept on the server so
 * it follows them to every device. Falls back to this browser's flags if the server
 * call fails, so a tour never nags on every visit. `isSeen` is undefined while loading.
 */
export function useTourSeen() {
  const queryClient = useQueryClient();
  const { data: session, isFetched: sessionFetched } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? "local";
  const key = queryKeys.tourDismissals(userId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => tourDismissalsApi.list(),
    enabled: sessionFetched,
    retry: false,
    staleTime: 60_000,
  });
  // Blocked storage counts as migrated: there is nothing to bring across.
  const migrated = readFlag(migratedKey(userId)) !== false;

  // One-off: copy the flags this browser kept before "seen" moved to the server.
  useEffect(() => {
    if (!query.isSuccess || migrated) return;
    const rows = query.data;
    const missing = ALL_TOURS.filter((tour) => readFlag(tourSeenKey(tour, userId)) === true && !rows.some(matches(tour)));
    let cancelled = false;
    Promise.all(missing.map((tour) => tourDismissalsApi.markSeen(tour.id, tour.version)))
      .then(() => {
        if (cancelled) return;
        queryClient.setQueryData<TourDismissal[]>(key, (old = []) => [
          ...old,
          ...missing.filter((tour) => !old.some(matches(tour)))
            .map((tour) => ({ tourKey: tour.id, tourVersion: tour.version, seenAt: new Date().toISOString() })),
        ]);
        writeFlag(migratedKey(userId), true);
      })
      .catch(() => { /* Try again on the next load; the local flags still count meanwhile. */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess, query.data, migrated, userId]);

  const isSeen = useCallback((tour: TourRef): boolean | undefined => {
    if (query.isError) return readFlag(tourSeenKey(tour, userId)) !== false;
    if (!query.isSuccess) return undefined;
    return query.data.some(matches(tour)) || (!migrated && readFlag(tourSeenKey(tour, userId)) === true);
  }, [query.isError, query.isSuccess, query.data, migrated, userId]);

  const markSeen = useCallback((tour: TourRef) => {
    writeFlag(tourSeenKey(tour, userId), true);
    queryClient.setQueryData<TourDismissal[]>(key, (old) =>
      !old || old.some(matches(tour)) ? old : [...old, { tourKey: tour.id, tourVersion: tour.version, seenAt: new Date().toISOString() }]);
    tourDismissalsApi.markSeen(tour.id, tour.version).catch(() => { /* The local flag covers it. */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, userId]);

  /** "Show all tutorials again": clears the server records and this browser's flags. */
  const resetAll = useCallback(async () => {
    await tourDismissalsApi.reset();
    for (const tour of ALL_TOURS) writeFlag(tourSeenKey(tour, userId), false);
    queryClient.setQueryData<TourDismissal[]>(key, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, userId]);

  return { isSeen, markSeen, resetAll, loading: !query.isSuccess && !query.isError };
}
