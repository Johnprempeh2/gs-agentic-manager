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
  restartReport: RestartReport | null;
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

export const releasesApi = {
  overview: (companyId: string) => api.get<ReleasesOverview>(`/companies/${companyId}/releases`),
  /** Cuts the next rc-* from origin/main and releases it. */
  /** `options.headers` carries the one-use `X-GSAM-Reauth` token in login mode. */
  releaseNow: (companyId: string, options?: RequestOptions) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/release`, {}, options),
  rollback: (companyId: string, tag: string, options?: RequestOptions) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/rollback`, { tag }, options),
  cancel: (companyId: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/cancel`, {}),
  override: (companyId: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/override`, {}),
  setFinishBeforeUpdate: (runId: string, enabled: boolean) =>
    api.post<{ runId: string; finishBeforeUpdate: boolean }>(`/heartbeat-runs/${runId}/finish-before-update`, {
      enabled,
    }),
};
