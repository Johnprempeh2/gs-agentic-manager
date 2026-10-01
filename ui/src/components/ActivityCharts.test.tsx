// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { DashboardRunActivityDay, HeartbeatRun } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDayLabel,
  IssueStatusChart,
  RunActivityChart,
  runChartSubtitle,
  SuccessRateChart,
  taskChartSubtitle,
} from "./ActivityCharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  flushSync(() => {
    root.render(ui);
  });
}

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    responsibleUserId: null,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-04-20T11:58:00.000Z"),
    finishedAt: new Date("2026-04-20T11:59:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date("2026-04-20T11:58:00.000Z"),
    updatedAt: new Date("2026-04-20T11:59:00.000Z"),
    ...overrides,
  };
}

describe("ActivityCharts", () => {
  it("labels days British style, day then short month", () => {
    expect(formatDayLabel("2026-10-01")).toBe("1 Oct");
    expect(formatDayLabel("2026-04-07")).toBe("7 Apr");
  });

  // Fake clock: today is 2026-04-20, so the window is 7 Apr to 20 Apr.
  function youngActivity(): DashboardRunActivityDay[] {
    return Array.from({ length: 14 }, (_, i) => {
      const date = `2026-04-${String(7 + i).padStart(2, "0")}`;
      const ran = i >= 10;
      return {
        date,
        succeeded: ran ? 3 : 0,
        failed: ran && i === 11 ? 5 : 0,
        recovered: 0,
        other: 0,
        total: ran ? (i === 11 ? 8 : 3) : 0,
        failedByErrorCode: {},
      };
    });
  }

  it("starts at the first run when history is shorter than the window, and says so", () => {
    const activity = youngActivity();
    expect(runChartSubtitle({ activity })).toBe("Since first run");
    expect(runChartSubtitle({ activity: activity.map((day) => ({ ...day, total: day.total || 1 })) })).toBe("Last 14 days");
    expect(runChartSubtitle({ activity: undefined })).toBe("Last 14 days");

    render(<RunActivityChart activity={activity} />);
    expect(container.querySelectorAll(".gs-bars > div")).toHaveLength(4);
    expect(container.textContent).toContain("17 Apr");
    expect(container.textContent).toContain("Today");
    expect(container.textContent).not.toContain("13 Apr");
  });

  it("draws success in brand emerald and failure-led days in the destructive red", () => {
    render(<SuccessRateChart activity={youngActivity()} />);
    const bars = Array.from(container.querySelectorAll<HTMLElement>(".gs-bar")).map((bar) => bar.style.backgroundColor);
    expect(bars).toEqual(["var(--brand-emerald)", "var(--destructive)", "var(--brand-emerald)", "var(--brand-emerald)"]);
  });

  it("trims task charts to the first task too", () => {
    const issues = [
      { status: "todo", createdAt: new Date("2026-04-18T09:00:00.000Z") },
      { status: "done", createdAt: new Date("2026-04-20T09:00:00.000Z") },
    ];
    expect(taskChartSubtitle(issues)).toBe("Since first task");
    expect(taskChartSubtitle([...issues, { status: "done", createdAt: new Date("2026-04-07T09:00:00.000Z") }])).toBe("Last 14 days");

    render(<IssueStatusChart issues={issues} />);
    expect(container.querySelectorAll(".gs-bars > div")).toHaveLength(3);
  });

  it("renders empty run charts when dashboard aggregate data is temporarily missing", () => {
    render(<RunActivityChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");

    render(<SuccessRateChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");
  });

  it("still aggregates raw agent runs for detail charts", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({ id: "run-failed", status: "failed", errorCode: "provider_quota" }),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("No runs yet");
    // Tooltip now carries the per-day breakdown (incl. failure error codes).
    const dayCell = container.querySelector("[title^='2026-04-20: 2 runs']");
    expect(dayCell).not.toBeNull();
    expect(dayCell?.getAttribute("title")).toContain("provider_quota: 1");
  });

  it("renders a distinct recovered segment and legend for recovered restart kills", () => {
    render(
      <RunActivityChart
        activity={[
          {
            date: "2026-04-20",
            succeeded: 3,
            failed: 1,
            recovered: 4,
            other: 0,
            total: 8,
            failedByErrorCode: { process_lost: 1 },
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Recovered");
    const dayCell = container.querySelector("[title*='recovered: 4']");
    expect(dayCell).not.toBeNull();
  });
});
