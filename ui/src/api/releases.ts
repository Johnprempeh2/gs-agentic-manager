import { api, type RequestOptions } from "./client";

// Release from the app (GRE-119). The shape is the one in GRE-121 (PR #53);
// the server owns every release decision, the UI only shows it.

export interface ReleaseChangelog {
  features: string[];
  fixes: string[];
}

export type ReleaseHealth = "healthy" | "unhealthy" | "unknown";
export type ReleaseCheckStatus = "passed" | "failed" | "pending" | "unknown";

export interface LiveRelease {
  tag: string | null;
  title: string | null;
  date: string | null;
  commit: string;
  health: ReleaseHealth;
  releasedBy: string | null;
  changelog: ReleaseChangelog;
}

/** What hot-restart-report.json says about the runs across the switch. */
export interface RestartReport {
  completedAt: string;
  /** Runs that go on: adopted, or ended during the switch and resumed. */
  resumedRunIds: string[];
  /** Kept running through the restart. */
  adoptedRunIds: string[];
  /**
   * Kept running with no output capture: its result is lost when it ends.
   * Absent on reports from before GRE-250, where every adopted run counts.
   */
  adoptedWithoutCaptureRunIds?: string[];
  /** Ended during the switch; checkpointed runs continue as a retry. */
  finishedWhileDownRunIds: string[];
  /** Running before, unaccounted for after. Needs recovery. */
  lostRunIds: string[];
}

export interface ReleaseHistoryEntry {
  tag: string;
  title: string;
  date: string | null;
  commit: string;
  releasedBy: string | null;
  changelog: ReleaseChangelog;
  candidateTag?: string | null;
  /** The stable-* tag on this release's commit, once promoted to Stable (GRE-127). */
  stableTag?: string | null;
  restartReport: RestartReport | null;
  /** The release to this tag failed and live never ran it (GRE-239): no rollback or promote. */
  neverRan?: boolean;
}

/** What the next version would contain: main since the live release. */
export interface NextVersion {
  baseTag: string | null;
  commit: string;
  proposedTitle: string;
  /** "agent:<id>" or "user:<id>". */
  titleEditedBy: string | null;
  titleEditedAt: string | null;
  changelog: ReleaseChangelog;
  changes: Array<{ pr: number | null; issue: string | null; title: string; kind: "feature" | "fix"; commit: string }>;
  forkCi: { status: ReleaseCheckStatus; url: string | null };
}

export interface FlaggedRun {
  runId: string;
  agentId: string;
  agentName: string | null;
  issueIdentifier: string | null;
  reason: string | null;
  flaggedAt: string;
  /** "agent:<id>" or "user:<id>". */
  flaggedBy: string | null;
}

export type ReleaseProgressState =
  | "checking"
  | "holding"
  | "switching"
  | "restarting"
  | "healthy"
  | "rolled_back"
  | "failed"
  | "cancelled";

export const FINAL_RELEASE_STATES: ReadonlySet<ReleaseProgressState> = new Set([
  "healthy",
  "rolled_back",
  "failed",
  "cancelled",
]);

export interface ReleaseProgress {
  id: string;
  kind: "release" | "rollback";
  targetTag: string | null;
  targetTitle: string | null;
  state: ReleaseProgressState;
  /** Runs marked "finish before update" still running while new runs are held. */
  waitingForFlaggedRuns: number | null;
  /** Running ACP runs the release waits for (at most 5 min); a hot restart cannot keep them. */
  waitingForAcpRuns: number | null;
  /** The board chose "Release without waiting". */
  overridden: boolean;
  /** Plain-words reason for rolled_back / failed. */
  reason: string | null;
  restartReport: RestartReport | null;
  startedAt: string;
  updatedAt: string;
  startedBy: string | null;
}

export interface ReleasesOverview {
  live: LiveRelease | null;
  /** Newest first; includes the live release. */
  history: ReleaseHistoryEntry[];
  next: NextVersion | null;
  flaggedRuns: FlaggedRun[];
  progress: ReleaseProgress | null;
  /** Why release is off on this server, or null. */
  disabledReason: string | null;
}

// The release queue on the PC (scripts/greatstone-release-queue.mjs): test
// gate, preview, then release, one request at a time.
export type ReleaseQueueStatus = "queued" | "running" | "released" | "failed" | "cancelled" | "merged" | "skipped";
export type ReleaseQueueStep = "gate" | "candidate" | "preview" | "draining" | "releasing";

export interface ReleaseQueueItem {
  id: string;
  /** "main", an rc-* tag or a commit sha. */
  ref: string;
  title: string | null;
  /** "user:<id>", "agent:<id>" or "cli:<name>". */
  requestedBy: string | null;
  requestedAt: string;
  status: ReleaseQueueStatus;
  step: ReleaseQueueStep | null;
  detail: string | null;
  commit: string | null;
  tag: string | null;
  liveTag: string | null;
  reason: string | null;
  /** The command that moves live back, after a release. */
  rollback: string | null;
  backupFile: string | null;
  /** Released together with this request (main requests that waited side by side). */
  mergedInto: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReleaseQueueView {
  running: (ReleaseQueueItem & { logTail: string[] }) | null;
  queued: ReleaseQueueItem[];
  recent: ReleaseQueueItem[];
  /** The test gate on origin/main. */
  main: {
    commit: string;
    status: "testing" | "passed" | "failing" | "untested";
    startedAt: string | null;
    finishedAt: string | null;
    summary: string[];
  } | null;
  workerSeenAt: string | null;
}

/** The version a client install runs and the client notes of its stable-* tag (GRE-128). */
export interface ClientVersion {
  label: string | null;
  stableTag: string | null;
  /** The stable tag message; null when there is none to show. */
  notes: string | null;
}

export const releasesApi = {
  clientVersion: (companyId: string) => api.get<ClientVersion>(`/companies/${companyId}/version`),
  overview: (companyId: string) => api.get<ReleasesOverview>(`/companies/${companyId}/releases`),
  queue: (companyId: string) => api.get<ReleaseQueueView>(`/companies/${companyId}/releases/queue`),
  /** Adds a release request to the queue (default: main). In login mode it needs the "release" re-check. */
  enqueue: (companyId: string, body: { ref?: string; title?: string | null }, options?: RequestOptions) =>
    api.post<{ item: ReleaseQueueItem; queue: ReleaseQueueView }>(`/companies/${companyId}/releases/queue`, body, options),
  cancelQueued: (companyId: string, id: string) =>
    api.post<{ item: ReleaseQueueItem; queue: ReleaseQueueView }>(`/companies/${companyId}/releases/queue/${id}/cancel`, {}),
  /**
   * The older release endpoint, kept for compatibility: like `enqueue`, it adds
   * main (or `tag`) to the release queue and answers with the queue item. The
   * page uses `enqueue`. `options.headers` carries the `X-GSAM-Reauth` token.
   */
  releaseNow: (companyId: string, options?: RequestOptions) =>
    api.post<{ item: ReleaseQueueItem; queue: ReleaseQueueView }>(`/companies/${companyId}/releases/release`, {}, options),
  rollback: (companyId: string, tag: string, options?: RequestOptions) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/rollback`, { tag }, options),
  /** Tags a live-* release as stable-*; `notes` (the client notes) are the tag message. */
  promote: (companyId: string, liveTag: string, notes: string, options?: RequestOptions) =>
    api.post<{ stable: { tag: string; commit: string; liveTag: string } }>(
      `/companies/${companyId}/releases/promote`,
      { liveTag, notes },
      options,
    ),
  cancel: (companyId: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/cancel`, {}),
  override: (companyId: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/override`, {}),
  setFinishBeforeUpdate: (runId: string, enabled: boolean) =>
    api.post<{ runId: string; finishBeforeUpdate: boolean }>(`/heartbeat-runs/${runId}/finish-before-update`, {
      enabled,
    }),
};
