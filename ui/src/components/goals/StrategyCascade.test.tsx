// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { buildStrategyCascade, hasStrategyGoals } from "@/lib/goal-cascade";
import { makeGoal } from "@/lib/goal-journey.fixtures";
import { CascadeStatus, StrategyCascadeView } from "./StrategyCascade";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
  useOptionalCompany: () => null,
}));

vi.mock("@/context/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: () => {} }),
}));

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const agentsById = new Map([["ag1", { id: "ag1", name: "Pillar agent", appearance: null }]]);
const usersById = new Map([["u1", { label: "Board chair", image: null }]]);

const at = (day: number) => new Date(2026, 8, day);

const plan = [
  makeGoal({ id: "v", kind: "vision", title: "Our vision", ownerUserId: "u1", createdAt: at(1) }),
  makeGoal({ id: "val", kind: "value", title: "Integrity", createdAt: at(1) }),
  makeGoal({ id: "c", kind: "csf", title: "Trusted brand", createdAt: at(1) }),
  makeGoal({ id: "p", kind: "pillar", parentId: "v", title: "Employer of choice", ownerAgentId: "ag1", createdAt: at(2) }),
  makeGoal({ id: "o", kind: "objective", parentId: "p", title: "Grow skills", ownerUserId: "u1", createdAt: at(3) }),
  makeGoal({ id: "i", kind: "initiative", parentId: "o", title: "Training plan", createdAt: at(4) }),
  makeGoal({ id: "k", kind: "kpi", parentId: "o", title: "Training hours", createdAt: at(5) }),
  makeGoal({ id: "co", kind: "objective", parentId: "c", title: "Win back trust", createdAt: at(2) }),
  makeGoal({ id: "ck", kind: "kpi", parentId: "c", title: "Net promoter score", createdAt: at(3) }),
  makeGoal({ id: "plain", title: "Plain goal" }),
  makeGoal({ id: "gone", kind: "pillar", parentId: "c", title: "Dropped pillar", status: "cancelled" }),
];

describe("buildStrategyCascade", () => {
  it("splits the board layers and walks each CSF, then each pillar, down", () => {
    const cascade = buildStrategyCascade(plan);
    expect(cascade.vision.map((g) => g.id)).toEqual(["v"]);
    expect(cascade.values.map((g) => g.id)).toEqual(["val"]);
    expect(cascade.csfs.map((g) => g.id)).toEqual(["c"]);
    expect(cascade.strategy.map(({ goal, depth }) => `${goal.id}:${depth}`)).toEqual([
      "c:0",
      "co:1",
      "ck:1",
      "p:0",
      "o:1",
      "k:2",
      "i:2",
    ]);
  });

  it("knows when there is no strategic plan yet", () => {
    expect(hasStrategyGoals([makeGoal({ id: "plain" })])).toBe(false);
    expect(hasStrategyGoals([makeGoal({ kind: "vision", status: "cancelled" })])).toBe(false);
    expect(hasStrategyGoals(plan)).toBe(true);
  });
});

describe("StrategyCascadeView", () => {
  it("shows each layer by kind with a person or agent owner", () => {
    const html = render(
      <StrategyCascadeView cascade={buildStrategyCascade(plan)} agentsById={agentsById} usersById={usersById} />,
    );
    expect(html).toContain("Strategic plan");
    expect(html.match(/data-testid="cascade-board-goal"/g)).toHaveLength(2);
    expect(html.match(/data-testid="cascade-row"/g)).toHaveLength(7);
    expect(html).toContain('data-kind="csf"');
    expect(html).toContain('data-kind="pillar"');
    expect(html).toContain('data-kind="kpi"');
    expect(html).toContain("Board chair");
    expect(html).toContain("Pillar agent");
    expect(html).toContain('data-owner="person"');
    expect(html).toContain('data-owner="agent"');
    expect(html).toContain("No owner");
    expect(html).not.toContain("Plain goal");
    expect(html).not.toContain("Dropped pillar");
  });
});

describe("CascadeStatus (GRE-1163)", () => {
  // The fixture has half its tasks done, which reads as healthy from task progress.
  it("shows the RAG status on a KPI row, not task progress", () => {
    const html = render(
      <CascadeStatus
        goal={makeGoal({
          kind: "kpi",
          kpiStatus: { status: "red" } as never,
          ragRollup: { status: "red", red: 1, amber: 0, green: 0, noStatus: 0 },
        })}
      />,
    );
    expect(html).toContain('data-rag="red"');
    expect(html).not.toContain("data-health");
  });

  it("shows No status on a KPI with no reading", () => {
    const html = render(<CascadeStatus goal={makeGoal({ kind: "kpi" })} />);
    expect(html).toContain('data-rag="none"');
    expect(html).not.toContain("data-health");
  });

  it("shows the worst KPI status on a goal above KPIs, with the counts", () => {
    const html = render(
      <CascadeStatus
        goal={makeGoal({
          kind: "objective",
          ragRollup: { status: "red", red: 1, amber: 0, green: 2, noStatus: 0 },
        })}
      />,
    );
    expect(html).toContain('data-rag="red"');
    expect(html).toContain("1 red, 2 green of 3 KPIs");
    expect(html).not.toContain("data-health");
  });

  it("falls back to task progress on a goal with no KPIs under it", () => {
    const html = render(<CascadeStatus goal={makeGoal({ kind: "initiative" })} />);
    expect(html).toContain("data-health");
    expect(html).not.toContain("data-rag");
  });
});
