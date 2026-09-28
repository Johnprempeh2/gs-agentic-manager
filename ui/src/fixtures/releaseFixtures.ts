import type { ReleaseProgress, ReleaseProgressState, ReleasesOverview } from "@/api/releases";

// Mock of GET /companies/:id/releases (GRE-121) for tests and screenshots
// until the real route lands.

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
    candidate: {
      tag: "rc-2026-09-28.1",
      title: "Release from the app",
      date: "2026-09-28T09:30:00.000Z",
      commit: "4f2a9d18b0c7",
      changelog: {
        features: ["Releases page with one-click release and rollback", "What's new in the sidebar"],
        fixes: ["Update live card works after the preview is stopped"],
      },
      forkCi: { status: "passed", url: "https://github.com/Johnprempeh2/gs-agentic-manager/actions" },
      flintCheck: { status: "passed", summary: "Sandbox checks passed", issueIdentifier: "GRE-120" },
    },
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
      },
    ],
    progress: null,
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
    runsStillRunning: state === "holding" ? 3 : null,
    reason: state === "rolled_back" ? "Live did not answer its health check within 2 minutes." : null,
    startedAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:01:00.000Z",
    startedBy: "John",
    ...overrides,
  };
}
