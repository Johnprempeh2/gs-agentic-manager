import { api } from "./client";

// Release from the app (GRE-119). The shape is the one proposed to Keystone on
// GRE-121; the server owns every release decision, the UI only shows it.

export interface ReleaseChangelog {
  features: string[];
  fixes: string[];
}

export type ReleaseHealth = "healthy" | "unhealthy" | "unknown";
export type ReleaseCheckStatus = "passed" | "failed" | "pending" | "unknown";

export interface LiveRelease {
  tag: string;
  title: string;
  date: string;
  commit: string;
  health: ReleaseHealth;
  releasedBy: string | null;
  changelog: ReleaseChangelog;
}

export interface ReleaseCandidate {
  tag: string;
  title: string;
  date: string;
  commit: string;
  changelog: ReleaseChangelog;
  forkCi: { status: ReleaseCheckStatus; url: string | null };
  flintCheck: { status: ReleaseCheckStatus; summary: string | null; issueIdentifier: string | null };
}

export interface ReleaseHistoryEntry {
  tag: string;
  title: string;
  date: string;
  commit: string;
  releasedBy: string | null;
  changelog: ReleaseChangelog;
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
  targetTag: string;
  targetTitle: string;
  state: ReleaseProgressState;
  /** Runs still running while new runs are held. */
  runsStillRunning: number | null;
  /** Plain-words reason for rolled_back / failed. */
  reason: string | null;
  startedAt: string;
  updatedAt: string;
  startedBy: string | null;
}

export interface ReleasesOverview {
  live: LiveRelease | null;
  candidate: ReleaseCandidate | null;
  /** Newest first; includes the live release. */
  history: ReleaseHistoryEntry[];
  progress: ReleaseProgress | null;
}

export const releasesApi = {
  overview: (companyId: string) => api.get<ReleasesOverview>(`/companies/${companyId}/releases`),
  release: (companyId: string, tag: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/release`, { tag }),
  rollback: (companyId: string, tag: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/rollback`, { tag }),
  cancel: (companyId: string) =>
    api.post<{ progress: ReleaseProgress }>(`/companies/${companyId}/releases/cancel`, {}),
};
