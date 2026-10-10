import { describe, expect, it } from "vitest";
import { computeKpiStatus, rollUpKpiStatus, type KpiStatus } from "./goal-kpi-status.js";
import {
  boardEvidenceTrust,
  buildStrategyBoardAreas,
  buildStrategyBoardKpis,
  countStrategyBoardKpis,
  kpiAlertAction,
  rankStrategyBoardAttention,
  renderStrategyBoardBrief,
  renderStrategyBoardPackMarkdown,
  type StrategyBoardGoal,
} from "./strategy-board.js";
import type { StrategyBoardPackSnapshot } from "./types/strategy-board.js";

const TODAY = "2026-10-10";

function goal(values: Partial<StrategyBoardGoal> & Pick<StrategyBoardGoal, "id" | "title">): StrategyBoardGoal {
  return {
    parentId: null,
    kind: null,
    status: "active",
    unit: null,
    targetValue: null,
    targetDate: null,
    ownerUserId: null,
    ownerAgentId: null,
    ...values,
  };
}

/** A small plan: one CSF with an objective and three KPIs (red, amber, green), and a second CSF with no reading. */
const GOALS: StrategyBoardGoal[] = [
  goal({ id: "vision", title: "Lead the region", kind: "vision" }),
  goal({ id: "csf-people", title: "Employer of choice", kind: "csf" }),
  goal({ id: "obj-retain", title: "Keep our people", kind: "objective", parentId: "csf-people", ownerUserId: "u-coo" }),
  goal({ id: "kpi-retention", title: "Staff retention", kind: "kpi", parentId: "obj-retain", unit: "%", targetValue: 90, targetDate: "2026-12-31", ownerUserId: "u-coo" }),
  goal({ id: "kpi-hiring", title: "Roles filled", kind: "kpi", parentId: "obj-retain", targetValue: 40, targetDate: "2026-12-31", ownerAgentId: "a-hr" }),
  goal({ id: "kpi-training", title: "Training hours", kind: "kpi", parentId: "csf-people", targetValue: 100, targetDate: "2026-12-31", ownerUserId: "u-coo" }),
  goal({ id: "csf-market", title: "Market expansion", kind: "csf" }),
  goal({ id: "kpi-launch", title: "Countries live", kind: "kpi", parentId: "csf-market", targetValue: 3, targetDate: "2027-06-30" }),
  goal({ id: "kpi-old", title: "Old KPI", kind: "kpi", parentId: "csf-market", status: "cancelled", targetValue: 1, targetDate: "2026-12-31" }),
  goal({ id: "kpi-draft", title: "Peer share (draft)", kind: "kpi", parentId: "csf-market", status: "draft" }),
];

function status(values: Partial<KpiStatus>): KpiStatus {
  return { status: null, reason: "no_reading", plannedValue: null, gapPercent: null, latestValue: null, latestDate: null, ...values };
}

const STATUS = new Map<string, KpiStatus>([
  ["kpi-retention", status({ status: "red", reason: "behind_plan", gapPercent: 35, latestValue: 70, plannedValue: 84, latestDate: "2026-10-08" })],
  ["kpi-hiring", status({ status: "amber", reason: "behind_plan", gapPercent: 12, latestValue: 30, plannedValue: 33, latestDate: "2026-09-20" })],
  ["kpi-training", status({ status: "green", reason: "on_track", gapPercent: 0, latestValue: 80, plannedValue: 78, latestDate: "2026-10-01" })],
  ["kpi-launch", status({})],
]);

const NAMES = {
  users: new Map([["u-coo", "Ama Mensah"]]),
  agents: new Map([["a-hr", "HR evidence agent"]]),
};

function boardKpis(snapshotById: Map<string, { status: "red" | "amber" | "green" | null; latestValue: number | null }> | null) {
  return buildStrategyBoardKpis({
    goals: GOALS,
    statusById: STATUS,
    latestReadingById: new Map([
      ["kpi-retention", { readingDate: "2026-10-08", source: "agent_verified" as const }],
      ["kpi-hiring", { readingDate: "2026-09-20", source: "owner_reported" as const }],
      ["kpi-training", { readingDate: "2026-10-01", source: "system" as const }],
    ]),
    snapshotById,
    openWhyById: new Map([["kpi-retention", 1]]),
    ownerNames: NAMES,
    today: TODAY,
  });
}

describe("strategy board KPIs", () => {
  it("places each KPI under its area and objective, with owner, source and age, and leaves cancelled and draft KPIs out", () => {
    const kpis = boardKpis(null);
    expect(kpis.map((kpi) => kpi.goalId)).toEqual(["kpi-retention", "kpi-hiring", "kpi-training", "kpi-launch"]);
    expect(kpis[0]).toMatchObject({
      areaId: "csf-people",
      objectiveId: "obj-retain",
      owner: { type: "user", id: "u-coo", name: "Ama Mensah" },
      latestReadingSource: "agent_verified",
      readingAgeDays: 2,
      openWhyRequests: 1,
      changedSinceSnapshot: false,
    });
    expect(kpis[1].owner).toEqual({ type: "agent", id: "a-hr", name: "HR evidence agent" });
    expect(kpis[2]).toMatchObject({ areaId: "csf-people", objectiveId: null });
    expect(kpis[3]).toMatchObject({ status: null, readingAgeDays: null, owner: null });
    expect(countStrategyBoardKpis(kpis)).toEqual({ red: 1, amber: 1, green: 1, noStatus: 1 });
  });

  it("marks what changed since the last board pack; a KPI not in the pack counts as changed", () => {
    const kpis = boardKpis(new Map([
      ["kpi-retention", { status: "amber", latestValue: 80 }],
      ["kpi-hiring", { status: "amber", latestValue: 31 }],
      ["kpi-training", { status: "green", latestValue: 70 }],
    ]));
    const changed = kpis.filter((kpi) => kpi.changedSinceSnapshot).map((kpi) => kpi.goalId);
    expect(changed).toEqual(["kpi-retention", "kpi-launch"]);
    expect(kpis[0]).toMatchObject({ previousStatus: "amber", previousValue: 80 });
  });

  it("ranks the attention queue red first, then by the biggest slippage", () => {
    const kpis = boardKpis(null);
    const extraRed = { ...kpis[0], goalId: "kpi-x", title: "Cash", gapPercent: 50 };
    const ranked = rankStrategyBoardAttention([kpis[1], kpis[0], kpis[2], extraRed]);
    expect(ranked.map((kpi) => kpi.goalId)).toEqual(["kpi-x", "kpi-retention", "kpi-hiring"]);
  });

  it("builds areas with objectives and their roll-up", () => {
    const rollup = rollUpKpiStatus(GOALS, new Map([...STATUS].map(([id, s]) => [id, s.status])));
    const areas = buildStrategyBoardAreas(GOALS, rollup, NAMES);
    expect(areas.map((area) => [area.goalId, area.rollup.status])).toEqual([
      ["csf-people", "red"],
      ["csf-market", null],
    ]);
    expect(areas[0].objectives).toEqual([
      expect.objectContaining({ goalId: "obj-retain", owner: { type: "user", id: "u-coo", name: "Ama Mensah" } }),
    ]);
    expect(areas[0].objectives[0].rollup).toMatchObject({ status: "red", red: 1, amber: 1 });
  });
});

describe("kpiAlertAction: no repeat alert for the same red state", () => {
  it("opens one alert when a KPI turns red, then stays quiet while it stays red", () => {
    expect(kpiAlertAction("red", false)).toBe("open");
    expect(kpiAlertAction("red", true)).toBe("none");
  });

  it("closes the red spell when the KPI recovers, so a later red alerts again", () => {
    expect(kpiAlertAction("amber", true)).toBe("clear");
    expect(kpiAlertAction("green", true)).toBe("clear");
    expect(kpiAlertAction(null, true)).toBe("clear");
    expect(kpiAlertAction("amber", false)).toBe("none");
    expect(kpiAlertAction("red", false)).toBe("open");
  });

  it("agrees with the KPI maths: a reading far behind plan is red", () => {
    const plan = { baselineValue: 100, baselineDate: "2026-01-01", targetValue: 200, targetDate: "2026-12-31", kpiDirection: null, amberThresholdPct: null, redThresholdPct: null, createdAt: "2026-01-01" };
    const red = computeKpiStatus(plan, { value: 110, readingDate: "2026-07-01" }, null, TODAY);
    expect(kpiAlertAction(red.status, false)).toBe("open");
  });
});

describe("renderStrategyBoardPackMarkdown (board pack from fixture data)", () => {
  const kpis = boardKpis(null);
  const rollup = rollUpKpiStatus(GOALS, new Map([...STATUS].map(([id, s]) => [id, s.status])));
  const pack: StrategyBoardPackSnapshot = {
    version: 1,
    companyName: "Example Bank",
    title: "Q3 2026 board pack",
    periodStart: "2026-07-01",
    periodEnd: "2026-09-30",
    asOf: TODAY,
    counts: countStrategyBoardKpis(kpis),
    areas: buildStrategyBoardAreas(GOALS, rollup, NAMES),
    kpis,
    readings: [
      { goalId: "kpi-hiring", value: 30, readingDate: "2026-09-20", source: "owner_reported", note: "From the HR | sheet" },
      { goalId: "kpi-retention", value: 70, readingDate: "2026-09-15", source: "agent_verified", note: null },
    ],
    whyRequests: [
      {
        goalId: "kpi-retention",
        question: "Why did retention fall?",
        status: "answered",
        answer: "Two teams left after the merger.\nWe start stay interviews in October.",
        askedAt: "2026-09-16T08:00:00.000Z",
        answeredAt: "2026-09-18T10:00:00.000Z",
        ownerName: "Ama Mensah",
      },
      { goalId: "kpi-hiring", question: "When will hiring catch up?", status: "open", answer: null, askedAt: "2026-09-25T08:00:00.000Z", answeredAt: null, ownerName: "HR evidence agent" },
    ],
  };
  const markdown = renderStrategyBoardPackMarkdown(pack);

  it("has the title, period and KPI counts", () => {
    expect(markdown).toContain("# Q3 2026 board pack");
    expect(markdown).toContain("Example Bank · 2026-07-01 to 2026-09-30 · status as of 2026-10-10");
    expect(markdown).toContain("**KPIs:** 1 red, 1 amber, 1 green, 1 with no status.");
  });

  it("shows status by area with objectives", () => {
    expect(markdown).toContain("| Employer of choice (Critical success factor) | Red | 1 red, 1 amber, 1 green |");
    expect(markdown).toContain("| ↳ Keep our people | Red | Ama Mensah |");
    expect(markdown).toContain("| Market expansion (Critical success factor) | No status | 0 red, 0 amber, 0 green |");
  });

  it("lists slippages biggest first with source and owner", () => {
    const red = markdown.indexOf("| Staff retention | Red | 35% | 70 % | 84 % | Agent verified (2 days old) | Ama Mensah |");
    const amber = markdown.indexOf("| Roles filled | Amber | 12% | 30 | 33 | Owner reported (20 days old) | HR evidence agent |");
    expect(red).toBeGreaterThan(0);
    expect(amber).toBeGreaterThan(red);
    expect(markdown).not.toContain("| Training hours | Green");
  });

  it("includes owner explanations and open requests", () => {
    expect(markdown).toContain("**Staff retention** — asked 2026-09-16: Why did retention fall?");
    expect(markdown).toContain("> Two teams left after the merger.\n> We start stay interviews in October.");
    expect(markdown).toContain("— Ama Mensah, 2026-09-18");
    expect(markdown).toContain("_No answer yet from HR evidence agent._");
  });

  it("separates verified from self-reported readings and escapes table pipes", () => {
    expect(markdown).toContain("2 readings: 1 checked by an agent or taken from a system, 1 reported by the owner.");
    expect(markdown).toContain("| Roles filled | 2026-09-20 | 30 | Owner reported | From the HR \\| sheet |");
    expect(markdown).toContain("| Staff retention | 2026-09-15 | 70 % | Agent verified |  |");
  });

  it("says when a section is empty", () => {
    const empty = renderStrategyBoardPackMarkdown({ ...pack, areas: [], kpis: [], readings: [], whyRequests: [], counts: { red: 0, amber: 0, green: 0, noStatus: 0 } });
    expect(empty).toContain("No pillars or critical success factors on the plan.");
    expect(empty).toContain("No KPI is red or amber.");
    expect(empty).toContain("No \"Why?\" requests in this period.");
    expect(empty).toContain("No readings dated in this period.");
  });
});

describe("renderStrategyBoardBrief (what the board agent answers from, GRE-1186)", () => {
  const brief = renderStrategyBoardBrief({
    companyName: "Pilot Co",
    issuePrefix: "PIL",
    asOf: TODAY,
    kpis: boardKpis(null),
    actions: [{ identifier: "PIL-12", title: "Run exit interviews", status: "in_progress", goalId: "kpi-retention", assigneeName: "HR evidence agent" }],
    checkIns: [{ goalId: "kpi-hiring", body: "Two offers out,\nboth due back Friday.", progressPercent: 60, date: "2026-10-07", authorName: "Ama Mensah" }],
    whyRequests: [{ goalId: "kpi-retention", question: "Why is retention down?", status: "answered", answer: "Two leavers in Q3.", askedAt: "2026-10-02" }],
  });

  it("gives every KPI with a reading its value, source and age", () => {
    expect(brief).toContain('KPI "Staff retention" [id kpi-retention] under Employer of choice > Keep our people: Red, 35% behind plan; latest 70 % on 2026-10-08 (source: agent-checked; age: 2 days old)');
    expect(brief).toContain('KPI "Roles filled" [id kpi-hiring]');
    expect(brief).toContain("latest 30 on 2026-09-20 (source: owner-reported; age: 20 days old)");
    expect(brief).toContain("(source: system; age: 9 days old)");
  });

  it("says when a KPI has no reading, and gives the owner, due date and open why requests", () => {
    expect(brief).toContain('KPI "Countries live" [id kpi-launch] under Market expansion: No status; no reading yet (source: no reading; age: no reading)');
    expect(brief).toContain("target 90 % due 2026-12-31; owner Ama Mensah; 1 open \"Why?\" request.");
    expect(brief).toContain("owner HR evidence agent");
  });

  it("cites tasks, check-ins and why answers against their KPI", () => {
    expect(brief).toContain('Task PIL-12 "Run exit interviews": in_progress; assignee HR evidence agent; for KPI "Staff retention".');
    expect(brief).toContain('2026-10-07 by Ama Mensah on KPI "Roles filled" (60% done): Two offers out, both due back Friday.');
    expect(brief).toContain('On KPI "Staff retention", asked 2026-10-02: Why is retention down? → answer: Two leavers in Q3.');
  });

  it("names trust in the board's words", () => {
    expect(boardEvidenceTrust("owner_reported")).toBe("owner-reported");
    expect(boardEvidenceTrust("agent_verified")).toBe("agent-checked");
    expect(boardEvidenceTrust("system")).toBe("system");
    expect(boardEvidenceTrust(null)).toBe("no reading");
  });
});
