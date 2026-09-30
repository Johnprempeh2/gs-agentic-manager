import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { FINAL_RELEASE_STATES, releasesApi, type ReleasesOverview } from "@/api/releases";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { canBoardManageRuntime } from "@/lib/recovery-reconcile";
import { queryKeys } from "@/lib/queryKeys";

/** Poll interval while a release or rollback is in progress. */
export const RELEASE_PROGRESS_POLL_MS = 2_000;

/**
 * Releasing is John's decision (GRE-119): the page, its buttons and the sidebar
 * "What's new" only show for board users. Client editions hide Releases for
 * everyone (`instance.releases`, GRE-129). The server stays authoritative.
 */
export function useCanRelease(companyId: string | null | undefined): { canRelease: boolean; isLoading: boolean } {
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { hidden, loaded } = useHiddenSettings();
  return {
    canRelease: loaded && !hidden.has("instance.releases") && canBoardManageRuntime(companyId, boardAccess.data),
    isLoading: boardAccess.isLoading,
  };
}

/** Client editions only: "Version X" and the notes of the stable tag it runs (GRE-128). */
export function useClientVersion(companyId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.clientVersion(companyId ?? ""),
    queryFn: () => releasesApi.clientVersion(companyId!),
    enabled: enabled && !!companyId,
    retry: false,
    staleTime: Infinity,
  });
}

export function isReleaseInProgress(overview: ReleasesOverview | undefined): boolean {
  const progress = overview?.progress;
  return !!progress && !FINAL_RELEASE_STATES.has(progress.state);
}

export function useReleases(companyId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.releases(companyId ?? ""),
    queryFn: () => releasesApi.overview(companyId!),
    enabled: enabled && !!companyId,
    retry: false,
    // Poll only while a job runs. Live goes down while switching and
    // restarting, so a failed fetch keeps the last state and keeps polling.
    refetchInterval: (query) =>
      isReleaseInProgress(query.state.data as ReleasesOverview | undefined) ? RELEASE_PROGRESS_POLL_MS : false,
  });
}
