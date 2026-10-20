// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StrategyBoardAction, StrategyBoardKpi } from "@greatstone/shared";
import {
  AttentionQueue,
  ChangesSinceSnapshot,
  OverdueActions,
  WhyAnswersSinceMeeting,
  changeText,
  overdueText,
  valueChangeText,
} from "./StrategyBoardViews";
import { boardLede, unsentAlertText } from "@/pages/StrategyBoard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

function kpi(values: Partial<StrategyBoardKpi> & Pick<StrategyBoardKpi, "goalId" | "title">): StrategyBoardKpi {
  return {
    unit: null,
    areaId: "csf",
    areaTitle: "Employer of choice",
    objectiveId: null,
    objectiveTitle: null,
    owner: { type: "user", id: "u1", name: "Ama Mensah" },
    status: "red",
    reason: "behind_plan",
    gapPercent: 30,
    latestValue: 70,
    plannedValue: 84,
    targetValue: 90,
    targetDate: "2026-12-31",
    latestReadingDate: "2026-10-08",
    latestReadingSource: "agent_verified",
    readingAgeDays: 2,
    previousStatus: null,
    previousValue: null,
    changedSinceSnapshot: false,
    openWhyRequests: 0,
    ...values,
  };
}

const RETENTION = kpi({ goalId: "k1", title: "Staff retention", unit: "%", previousStatus: "amber", changedSinceSnapshot: true, openWhyRequests: 1 });
const LAUNCH = kpi({
  goalId: "k2", title: "Countries live", status: "amber", gapPercent: 12, latestValue: 1, plannedValue: 1.4,
  latestReadingSource: "owner_reported", readingAgeDays: 18, owner: null,
});

describe("AttentionQueue", () => {
  it("lists slippages in the order given, with performance and evidence shown apart", () => {
    const html = renderToStaticMarkup(<AttentionQueue kpis={[RETENTION, LAUNCH]} canAskWhy onAskWhy={() => {}} />);
    expect(html.indexOf("Staff retention")).toBeLessThan(html.indexOf("Countries live"));
    expect(html).toContain("30% behind plan: 70 % against 84 %");
    expect(html).toContain("Was watch, now off course");
    expect(html).toContain('data-assurance="strong"');
    expect(html).toContain('data-assurance="weak"');
    expect(html).toContain("18 days old");
    expect(html).toContain("Owner: Ama Mensah");
    expect(html).toContain("1 question waiting");
    expect(html.match(/Ask why/g)).toHaveLength(2);
    // No owner to ask: the button is there but disabled.
    expect(html).toMatch(/disabled=""[^>]*title="This KPI has no owner to ask"/);
  });

  it("shows a KPI with no status as not measured, with the reason (GRE-1325)", () => {
    const unmeasured = kpi({
      goalId: "k3", title: "Brand trust", status: null, reason: "no_plan", gapPercent: null, latestValue: null,
      plannedValue: null, targetValue: null, latestReadingSource: null, readingAgeDays: null, notMeasuredReason: "No target",
    });
    const html = renderToStaticMarkup(<AttentionQueue kpis={[RETENTION, unmeasured]} canAskWhy onAskWhy={() => {}} />);
    expect(html).toContain("Not measured: No target");
    expect(html).not.toContain("0% behind plan: n/a");
  });

  it("hides Ask why from people without the board right", () => {
    const html = renderToStaticMarkup(<AttentionQueue kpis={[RETENTION]} canAskWhy={false} onAskWhy={() => {}} />);
    expect(html).not.toContain("Ask why");
  });

  it("puts on course KPIs on stale evidence in their own group, with a trend", () => {
    const stale = kpi({
      goalId: "k4", title: "Training hours", status: "green", gapPercent: 0, readingAgeDays: 45,
      trend: [{ readingDate: "2026-08-01", value: 60 }, { readingDate: "2026-09-01", value: 70 }],
    });
    const html = renderToStaticMarkup(<AttentionQueue kpis={[RETENTION, stale]} canAskWhy onAskWhy={() => {}} />);
    expect(html).toContain("On course, but on weak evidence");
    expect(html.indexOf("Staff retention")).toBeLessThan(html.indexOf("On course, but on weak evidence"));
    expect(html.indexOf("On course, but on weak evidence")).toBeLessThan(html.indexOf("Training hours"));
    expect(html).toContain('aria-label="Last 2 readings: 60, 70"');
    // Only stale greens: no slippage, but the group still shows.
    const onlyStale = renderToStaticMarkup(<AttentionQueue kpis={[stale]} canAskWhy onAskWhy={() => {}} />);
    expect(onlyStale).toContain("No board action is needed");
    expect(onlyStale).toContain("On course, but on weak evidence");
  });

  it("says when nothing needs the board", () => {
    expect(renderToStaticMarkup(<AttentionQueue kpis={[]} canAskWhy onAskWhy={() => {}} />)).toContain("No board action is needed");
  });
});

describe("changes since the last board pack", () => {
  it("describes each change and the empty states", () => {
    expect(changeText(RETENTION)).toBe("Was watch, now off course");
    expect(changeText(kpi({ goalId: "k3", title: "New", changedSinceSnapshot: true }))).toBe("New since the last pack, now off course");
    expect(changeText(LAUNCH)).toBeNull();
    expect(renderToStaticMarkup(<ChangesSinceSnapshot kpis={[]} hasSnapshot={false} />)).toContain("Make the first board pack");
    expect(renderToStaticMarkup(<ChangesSinceSnapshot kpis={[]} hasSnapshot />)).toContain("No KPI changed status");
  });

  it("says what the number was and is now, not only the colour", () => {
    expect(valueChangeText({ previousValue: 80, latestValue: 70, unit: "%" })).toBe("Was 80 %, now 70 %");
    expect(valueChangeText({ previousValue: null, latestValue: 70, unit: null })).toBe("Now 70");
    expect(valueChangeText({ previousValue: 80, latestValue: null, unit: null })).toBeNull();
    const trend = [{ readingDate: "2026-09-01", value: 80 }, { readingDate: "2026-10-08", value: 70 }];
    const html = renderToStaticMarkup(<ChangesSinceSnapshot kpis={[{ ...RETENTION, previousValue: 80, trend }]} hasSnapshot />);
    expect(html).toContain("Was 80 %, now 70 %");
    expect(html).toContain('data-testid="kpi-sparkline"');
  });
});

describe("answers since the last meeting", () => {
  const item = { kpiTitle: "Staff retention", ownerName: "Ama Mensah", question: "Why?", askedAt: "2026-09-20T00:00:00Z" };
  it("lists answers with KPI, owner, answer and link, and open requests with their age", () => {
    const html = renderToStaticMarkup(
      <WhyAnswersSinceMeeting
        hasSnapshot
        answered={[{ ...item, id: "a1", goalId: "k1", answer: "Two leavers in Q3.", answeredAt: "2026-09-21T00:00:00Z", ageDays: 20 }]}
        open={[{ ...item, id: "o1", goalId: "k2", kpiTitle: "Roles filled", ownerName: null, answer: null, answeredAt: null, ageDays: 6 }]}
      />,
    );
    expect(html).toContain('href="/goals/k1"');
    expect(html).toContain("Two leavers in Q3.");
    expect(html).toContain("Ama Mensah");
    expect(html).toContain("Still waiting for an answer");
    expect(html).toContain("The owner · asked 6 days ago");
  });

  it("says when nothing came in since the last pack", () => {
    expect(renderToStaticMarkup(<WhyAnswersSinceMeeting hasSnapshot answered={[]} open={[]} />)).toContain("since the last board pack");
  });
});

describe("boardLede", () => {
  it("counts on course, watch and off course, and weak evidence", () => {
    expect(boardLede({ red: 1, amber: 1, green: 2, noStatus: 1 }, [RETENTION, LAUNCH])).toBe(
      "On course 2 · Watch 1 · Off course 1 · 1 with no status · 1 on weak evidence",
    );
  });
});

describe("unsentAlertText", () => {
  it("tells owners to choose a chair, and says old spells stay unsent once a chair is set", () => {
    expect(unsentAlertText(2, false, true)).toBe("2 KPIs are off course and the board has no chair, so no alert was sent. Choose a chair below.");
    expect(unsentAlertText(1, false, false)).toBe("1 KPI is off course and the board has no chair, so no alert was sent. Ask a company owner to choose a chair.");
    expect(unsentAlertText(2, true, true)).toBe("2 KPIs went off course before the board had a chair, so no alert was sent for them. New off course KPIs alert the chair.");
  });
});

function action(values: Partial<StrategyBoardAction> & Pick<StrategyBoardAction, "issueId" | "title">): StrategyBoardAction {
  return {
    identifier: null,
    status: "todo",
    dueDate: "2026-10-05",
    daysOverdue: 5,
    objectiveId: "obj-retain",
    objectiveTitle: "Keep our people",
    areaId: "csf",
    areaTitle: "Employer of choice",
    owner: { type: "user", id: "u1", name: "Ama Mensah" },
    ...values,
  };
}

describe("overdue actions (GRE-1188)", () => {
  it("groups overdue actions under their objective with owner, due date and days overdue", () => {
    const html = renderToStaticMarkup(
      <OverdueActions
        actions={[
          action({ issueId: "i1", identifier: "GRE-2", title: "Run stay interviews" }),
          action({ issueId: "i2", title: "Publish the hiring plan", daysOverdue: 1, dueDate: "2026-10-09", owner: { type: "agent", id: "a1", name: "HR agent" } }),
          action({ issueId: "i3", title: "Open the Accra branch", objectiveId: "obj-grow", objectiveTitle: "Grow the network", areaTitle: null, owner: null }),
        ]}
      />,
    );
    expect(html.match(/data-testid="overdue-group"/g)).toHaveLength(2);
    expect(html.match(/data-testid="overdue-row"/g)).toHaveLength(3);
    expect(html).toContain('href="/goals/obj-retain"');
    expect(html).toContain('href="/issues/GRE-2"');
    expect(html).toContain('href="/issues/i2"');
    expect(html).toContain("Ama Mensah");
    expect(html).toContain("Due 2026-10-05");
    expect(html).toContain("5 days overdue");
    expect(html).toContain("1 day overdue");
    expect(html).toContain("No owner");
    expect(html.indexOf("Keep our people")).toBeLessThan(html.indexOf("Grow the network"));
  });

  it("says when no action is overdue", () => {
    expect(renderToStaticMarkup(<OverdueActions actions={[]} />)).toContain("No plan action is past its due date.");
    expect(overdueText(2)).toBe("2 days overdue");
  });
});
