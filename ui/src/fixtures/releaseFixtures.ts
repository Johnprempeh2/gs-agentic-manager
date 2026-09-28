import type { FlaggedRun, ReleaseProgress, ReleaseProgressState, ReleasesOverview, RestartReport } from "@/api/releases";

// Mock of GET /companies/:id/releases (GRE-121, PR #53) for tests and
// screenshots until the real route lands.

export const KEYSTONE_AGENT_ID = "003c68ec-ee61-4134-b748-01443997f802";

export function restartReportFixture(overrides: Partial<RestartReport> = {}): RestartReport {
  return {
    completedAt: "2026-09-28T10:03:00.000Z",
    resumedRunIds: ["a1b2c3d4-run-adopted", "e5f6a7b8-run-checkpoint"],
    adoptedRunIds: ["a1b2c3d4-run-adopted"],
    finishedWhileDownRunIds: ["e5f6a7b8-run-checkpoint"],
    lostRunIds: ["9c8d7e6f-run-lost"],
    ...overrides,
  };
}

export function flaggedRunFixture(overrides: Partial<FlaggedRun> = {}): FlaggedRun {
  return {
    runId: "4d5e6f70-flagged-run",
    agentId: "agent-ridge",
    agentName: "Ridge",
    issueIdentifier: "GRE-130",
    reason: "Mid database migration",
    flaggedAt: "2026-09-28T09:55:00.000Z",
    flaggedBy: "agent:agent-ridge",
    ...overrides,
  };
}

export function releasesOverviewFixture(overrides: Partial<ReleasesOverview> = {}): ReleasesOverview {
  return {
    live: {
      tag: "live-2026-09-21.1",
      title: "Run limits",
      date: "2026-09-21T16:04:00.000Z",
      commit: "c77a43cb3e1f",
      health: "healthy",
      releasedBy: "John",
      changelog: {
        features: ["Run limits in settings, with a usage-based recommendation"],
        fixes: ["Board no longer flickers when a run finishes"],
      },
    },
    next: {
      baseTag: "live-2026-09-21.1",
      commit: "4f2a9d18b0c7",
      proposedTitle: "Release from the app",
      titleEditedBy: `agent:${KEYSTONE_AGENT_ID}`,
      titleEditedAt: "2026-09-28T09:40:00.000Z",
      changelog: {
        features: ["Releases page with one-click release and rollback", "What's new in the sidebar"],
        fixes: ["Update live card works after the preview is stopped"],
      },
      changes: [
        { pr: 51, issue: "GRE-122", title: "Releases page and What's new in the sidebar", kind: "feature", commit: "a02f62f55dfa" },
        { pr: 53, issue: "GRE-121", title: "One-click release service", kind: "feature", commit: "7d1e0c2b9a44" },
        { pr: 50, issue: "GRE-118", title: "Update live card after preview stop", kind: "fix", commit: "3b6c9f0e1d22" },
      ],
      forkCi: { status: "passed", url: "https://github.com/Johnprempeh2/gs-agentic-manager/actions" },
    },
    flaggedRuns: [],
    history: [
      {
        tag: "live-2026-09-21.1",
        title: "Run limits",
        date: "2026-09-21T16:04:00.000Z",
        commit: "c77a43cb3e1f",
        releasedBy: "John",
        changelog: {
          features: ["Run limits in settings, with a usage-based recommendation"],
          fixes: ["Board no longer flickers when a run finishes"],
        },
        restartReport: restartReportFixture(),
      },
      {
        tag: "live-2026-09-14.1",
        title: "RAM management",
        date: "2026-09-14T11:20:00.000Z",
        commit: "7e8659848a21",
        releasedBy: "John",
        changelog: {
          features: ["Agents pause new runs when memory is low"],
          fixes: [],
        },
        restartReport: null,
      },
    ],
    progress: null,
    disabledReason: null,
    ...overrides,
  };
}

export function releaseProgressFixture(
  state: ReleaseProgressState,
  overrides: Partial<ReleaseProgress> = {},
): ReleaseProgress {
  return {
    id: "job-1",
    kind: "release",
    targetTag: "rc-2026-09-28.1",
    targetTitle: "Release from the app",
    state,
    waitingForFlaggedRuns: state === "holding" ? 1 : null,
    overridden: false,
    reason: state === "rolled_back" ? "Live did not answer its health check within 2 minutes." : null,
    restartReport: state === "healthy" ? restartReportFixture() : null,
    startedAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:01:00.000Z",
    startedBy: "John",
    ...overrides,
  };
}
