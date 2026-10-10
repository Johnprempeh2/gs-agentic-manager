// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StrategyBoardKpi } from "@greatstone/shared";
import { AttentionQueue, ChangesSinceSnapshot, changeText } from "./StrategyBoardViews";
import { boardLede } from "@/pages/StrategyBoard";

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
    expect(html).toContain("Was amber, now red");
    expect(html).toContain('data-assurance="strong"');
    expect(html).toContain('data-assurance="weak"');
    expect(html).toContain("18 days old");
    expect(html).toContain("Owner: Ama Mensah");
    expect(html).toContain("1 question waiting");
    expect(html.match(/Ask why/g)).toHaveLength(2);
    // No owner to ask: the button is there but disabled.
    expect(html).toMatch(/disabled=""[^>]*title="This KPI has no owner to ask"/);
  });

  it("hides Ask why from people without the board right", () => {
    const html = renderToStaticMarkup(<AttentionQueue kpis={[RETENTION]} canAskWhy={false} onAskWhy={() => {}} />);
    expect(html).not.toContain("Ask why");
  });

  it("says when nothing needs the board", () => {
    expect(renderToStaticMarkup(<AttentionQueue kpis={[]} canAskWhy onAskWhy={() => {}} />)).toContain("No board action is needed");
  });
});

describe("changes since the last board pack", () => {
  it("describes each change and the empty states", () => {
    expect(changeText(RETENTION)).toBe("Was amber, now red");
    expect(changeText(kpi({ goalId: "k3", title: "New", changedSinceSnapshot: true }))).toBe("New since the last pack, now red");
    expect(changeText(LAUNCH)).toBeNull();
    expect(renderToStaticMarkup(<ChangesSinceSnapshot kpis={[]} hasSnapshot={false} />)).toContain("Make the first board pack");
    expect(renderToStaticMarkup(<ChangesSinceSnapshot kpis={[]} hasSnapshot />)).toContain("No KPI changed colour");
  });
});

describe("boardLede", () => {
  it("counts on course, watch and off course, and weak evidence", () => {
    expect(boardLede({ red: 1, amber: 1, green: 2, noStatus: 1 }, [RETENTION, LAUNCH])).toBe(
      "On course 2 · Watch 1 · Off course 1 · 1 with no status · 1 on weak evidence",
    );
  });
});
