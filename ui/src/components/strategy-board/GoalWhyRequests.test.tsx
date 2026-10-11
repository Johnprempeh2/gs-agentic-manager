// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StrategyBoardKpi } from "@greatstone/shared";
import { GoalWhyRequestsHeading } from "./GoalWhyRequests";

const GREEN_KPI: StrategyBoardKpi = {
  goalId: "k1",
  title: "Staff retention",
  unit: "%",
  areaId: null,
  areaTitle: null,
  objectiveId: null,
  objectiveTitle: null,
  owner: { type: "user", id: "u1", name: "Ama Mensah" },
  status: "green",
  reason: "on_track",
  gapPercent: 0,
  latestValue: 92,
  plannedValue: 90,
  targetValue: 95,
  targetDate: "2026-12-31",
  latestReadingDate: "2026-10-08",
  latestReadingSource: "agent_verified",
  readingAgeDays: 3,
  previousStatus: null,
  previousValue: null,
  changedSinceSnapshot: false,
  openWhyRequests: 0,
};

describe("GoalWhyRequestsHeading (GRE-1330)", () => {
  it("lets a board member ask why on a green KPI", () => {
    const html = renderToStaticMarkup(<GoalWhyRequestsHeading kpi={GREEN_KPI} mayAskWhy onAskWhy={() => {}} />);
    expect(html).toContain("Why? requests from the board");
    expect(html).toContain("Ask why");
    expect(html).not.toContain(`disabled=""`);
  });

  it("hides Ask why from people without the board right", () => {
    const html = renderToStaticMarkup(<GoalWhyRequestsHeading kpi={GREEN_KPI} mayAskWhy={false} onAskWhy={() => {}} />);
    expect(html).toContain("Why? requests from the board");
    expect(html).not.toContain("Ask why");
  });

  it("disables Ask why when the KPI has no owner to ask", () => {
    const html = renderToStaticMarkup(<GoalWhyRequestsHeading kpi={{ ...GREEN_KPI, owner: null }} mayAskWhy onAskWhy={() => {}} />);
    expect(html).toMatch(/disabled=""[^>]*title="This KPI has no owner to ask"/);
  });

  it("hides Ask why when the board does not list the KPI", () => {
    const html = renderToStaticMarkup(<GoalWhyRequestsHeading kpi={null} mayAskWhy onAskWhy={() => {}} />);
    expect(html).not.toContain("Ask why");
  });
});
