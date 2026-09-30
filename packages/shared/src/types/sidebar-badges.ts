export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** The one Decisions count (GRE-263), from the same build as the Decisions feed. Board users only. */
  decisions?: number;
}
