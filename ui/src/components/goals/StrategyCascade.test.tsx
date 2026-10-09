// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { buildStrategyCascade, hasStrategyGoals } from "@/lib/goal-cascade";
import { makeGoal } from "@/lib/goal-journey.fixtures";
import { StrategyCascadeView } from "./StrategyCascade";

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
  makeGoal({ id: "plain", title: "Plain goal" }),
  makeGoal({ id: "gone", kind: "pillar", parentId: "c", title: "Dropped pillar", status: "cancelled" }),
];

describe("buildStrategyCascade", () => {
  it("splits the board layers and walks each pillar down, KPI before initiative", () => {
    const cascade = buildStrategyCascade(plan);
    expect(cascade.vision.map((g) => g.id)).toEqual(["v"]);
    expect(cascade.values.map((g) => g.id)).toEqual(["val"]);
    expect(cascade.csfs.map((g) => g.id)).toEqual(["c"]);
    expect(cascade.strategy.map(({ goal, depth }) => `${goal.id}:${depth}`)).toEqual(["p:0", "o:1", "k:2", "i:2"]);
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
    expect(html.match(/data-testid="cascade-board-goal"/g)).toHaveLength(3);
    expect(html.match(/data-testid="cascade-row"/g)).toHaveLength(4);
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
