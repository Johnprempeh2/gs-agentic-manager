// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { GoalCheckIn, GoalMilestone } from "@greatstone/shared";
import { buildScoreboard } from "@/lib/goal-journey";
import { makeGoal } from "@/lib/goal-journey.fixtures";
import { GoalScoreboardView, GoalsEmptyState } from "./GoalScoreboard";
import { GoalJourneyMap } from "./GoalJourneyMap";
import { GoalCheckIns } from "./GoalCheckIns";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null }),
  useOptionalCompany: () => null,
}));

vi.mock("@/context/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: () => {} }),
}));

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const agentsById = new Map([["ag1", { id: "ag1", name: "Everest", appearance: null }]]);

function milestone(id: string, status: GoalMilestone["status"]): GoalMilestone {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status,
    goalId: "g1",
    assigneeAgentId: null,
    createdAt: new Date(2026, 8, 1),
    completedAt: null,
  };
}

function checkIn(id: string, body: string, progressPercent: number | null): GoalCheckIn {
  return {
    id,
    companyId: "c1",
    goalId: "g1",
    authorAgentId: "ag1",
    authorUserId: null,
    body,
    progressPercent,
    blockers: [],
    createdAt: new Date(2026, 8, 28),
  };
}

describe("GoalScoreboardView", () => {
  it("shows one card per top-level goal with owner, number, what is left, main blocker and sub-goals", () => {
    const entries = buildScoreboard([
      makeGoal({
        id: "g1",
        title: "Launch the portal",
        ownerAgentId: "ag1",
        progress: { percent: 62, source: "issues", done: 10, open: 6, blocked: 0, total: 16 },
        blockers: [{ kind: "check_in", text: "Waiting on DNS", checkInId: "k" }],
      }),
      makeGoal({ id: "g2", parentId: "g1", title: "Write the docs" }),
    ]);
    const html = render(<GoalScoreboardView entries={entries} agentsById={agentsById} />);

    expect(html.match(/data-testid="goal-score-card"/g)).toHaveLength(1);
    expect(html).toContain("Launch the portal");
    expect(html).toContain("Everest");
    expect(html).toContain("62");
    expect(html).toContain("6 of 16 tasks left");
    expect(html).toContain("Waiting on DNS");
    expect(html).toContain('data-health="at_risk"');
    expect(html).toContain('data-testid="goal-sub-tile"');
    expect(html).toContain("Write the docs");
    expect(html).toContain("No check-ins yet");
  });

  it("has a 'No goals yet' empty state", () => {
    const html = render(<GoalsEmptyState onNewGoal={() => {}} />);
    expect(html).toContain("No goals yet");
    expect(html).toContain("New goal");
  });
});

describe("GoalJourneyMap", () => {
  it("draws every stop state and the goal flag", () => {
    const html = render(
      <GoalJourneyMap
        milestones={[milestone("1", "done"), milestone("2", "in_progress"), milestone("3", "blocked"), milestone("4", "todo")]}
        agentsById={agentsById}
      />,
    );
    for (const kind of ["done", "here", "blocked", "ahead"]) {
      expect(html).toContain(`data-stop-kind="${kind}"`);
    }
    expect(html).toContain("we are here");
    expect(html).toContain('aria-label="Goal reached"');
    expect(html).toContain("goal-route-draw");
    // Desktop (wave left to right) and phone (top to bottom) routes are both rendered; CSS shows one.
    expect(html).toContain('data-orientation="horizontal"');
    expect(html).toContain('data-orientation="vertical"');
  });

  it("has an empty state when no tasks are linked", () => {
    const html = render(<GoalJourneyMap milestones={[]} agentsById={agentsById} />);
    expect(html).toContain('data-testid="journey-empty"');
    expect(html).not.toContain('data-testid="goal-journey-map"');
  });
});

describe("GoalCheckIns", () => {
  it("shows the newest check-in as the recap and older ones as history", () => {
    const html = render(
      <GoalCheckIns
        checkIns={[checkIn("new", "Portal is live for 3 clients.", 62), checkIn("old", "Started the build.", 20)]}
        agentsById={agentsById}
        ownerName="Everest"
      />,
    );
    expect(html).toContain('data-testid="goal-recap"');
    expect(html).toContain("Portal is live for 3 clients.");
    expect(html).toContain('data-testid="check-in-history"');
    expect(html).toContain("Started the build.");
  });

  it("has a 'No check-ins yet' empty state naming the owner", () => {
    const html = render(<GoalCheckIns checkIns={[]} agentsById={agentsById} ownerName="Everest" />);
    expect(html).toContain('data-testid="check-ins-empty"');
    expect(html).toContain("No check-ins yet");
    expect(html).toContain("Everest writes the first check-in");
  });
});
