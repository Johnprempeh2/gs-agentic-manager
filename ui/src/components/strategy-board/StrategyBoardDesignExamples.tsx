import type { StrategyBoardArea, StrategyBoardKpi } from "@greatstone/shared";
import { AssuranceBadge, AttentionQueue, ChangesSinceSnapshot, StrategyAtAGlance } from "./StrategyBoardViews";

const kpi = (overrides: Partial<StrategyBoardKpi>): StrategyBoardKpi => ({
  goalId: "kpi",
  title: "KPI",
  unit: null,
  areaId: null,
  areaTitle: null,
  objectiveId: null,
  objectiveTitle: null,
  owner: null,
  status: null,
  reason: "on_track",
  gapPercent: null,
  latestValue: null,
  plannedValue: null,
  targetValue: null,
  targetDate: null,
  latestReadingDate: null,
  latestReadingSource: null,
  readingAgeDays: null,
  previousStatus: null,
  previousValue: null,
  changedSinceSnapshot: false,
  openWhyRequests: 0,
  ...overrides,
});

const ATTENTION: StrategyBoardKpi[] = [
  kpi({
    goalId: "dg-nps",
    title: "Net promoter score",
    areaTitle: "Trusted brand",
    objectiveTitle: "Win back trust",
    owner: { type: "user", id: "u1", name: "Ama Mensah" },
    status: "red",
    reason: "behind_plan",
    gapPercent: 32,
    latestValue: 34,
    plannedValue: 50,
    latestReadingSource: "owner_reported",
    readingAgeDays: 41,
    previousStatus: "amber",
    changedSinceSnapshot: true,
    openWhyRequests: 1,
  }),
  kpi({
    goalId: "dg-hours",
    title: "Training hours per person",
    unit: "h",
    areaTitle: "Employer of choice",
    owner: { type: "agent", id: "a1", name: "Summit" },
    status: "amber",
    reason: "behind_plan",
    gapPercent: 8,
    latestValue: 11,
    plannedValue: 12,
    latestReadingSource: "agent_verified",
    readingAgeDays: 3,
  }),
];

const CHANGES: StrategyBoardKpi[] = [
  ATTENTION[0]!,
  kpi({ goalId: "dg-revenue", title: "Recurring revenue from new West African markets", status: "green", previousStatus: "amber", changedSinceSnapshot: true }),
  kpi({ goalId: "dg-new", title: "Staff retention", status: "amber", changedSinceSnapshot: true }),
];

const AREAS: StrategyBoardArea[] = [
  {
    goalId: "dg-brand",
    title: "Trusted brand",
    kind: "csf",
    rollup: { status: "red", red: 1, amber: 0, green: 1, noStatus: 0 },
    objectives: [
      { goalId: "dg-trust", title: "Win back trust", rollup: { status: "red", red: 1, amber: 0, green: 0, noStatus: 0 }, owner: null },
      { goalId: "dg-press", title: "Positive press coverage", rollup: { status: "green", red: 0, amber: 0, green: 1, noStatus: 0 }, owner: null },
    ],
  },
  {
    goalId: "dg-people",
    title: "Employer of choice",
    kind: "pillar",
    rollup: { status: "amber", red: 0, amber: 1, green: 0, noStatus: 1 },
    objectives: [
      { goalId: "dg-skills", title: "Grow skills", rollup: { status: "amber", red: 0, amber: 1, green: 0, noStatus: 0 }, owner: null },
      { goalId: "dg-hire", title: "Hire locally", rollup: { status: null, red: 0, amber: 0, green: 0, noStatus: 1 }, owner: null },
    ],
  },
];

/** Board control panel pieces (GRE-1135) with sample data for the design guide. */
export function StrategyBoardDesignExamples() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="font-mono text-xs font-semibold text-muted-foreground">AssuranceBadge</p>
        <p className="text-sm text-muted-foreground">
          How far to trust a KPI reading, kept apart from its RAG colour: agent-checked and fresh is strong, agent-checked
          but older is moderate, owner-reported, stale or missing is weak.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <AssuranceBadge kpi={{ latestReadingSource: "agent_verified", readingAgeDays: 2 }} />
          <AssuranceBadge kpi={{ latestReadingSource: "agent_verified", readingAgeDays: 30 }} />
          <AssuranceBadge kpi={{ latestReadingSource: "owner_reported", readingAgeDays: 5 }} />
        </div>
      </div>
      <div className="space-y-2">
        <p className="font-mono text-xs font-semibold text-muted-foreground">AttentionQueue</p>
        <p className="text-sm text-muted-foreground">Red then amber KPIs, biggest slippage first, with an Ask why action for board members.</p>
        <AttentionQueue kpis={ATTENTION} canAskWhy onAskWhy={() => {}} />
        <AttentionQueue kpis={[]} canAskWhy={false} onAskWhy={() => {}} />
      </div>
      <div className="space-y-2">
        <p className="font-mono text-xs font-semibold text-muted-foreground">StrategyAtAGlance</p>
        <p className="text-sm text-muted-foreground">Each pillar or CSF with its worst KPI status and a dot per objective.</p>
        <StrategyAtAGlance areas={AREAS} />
      </div>
      <div className="space-y-2">
        <p className="font-mono text-xs font-semibold text-muted-foreground">ChangesSinceSnapshot</p>
        <p className="text-sm text-muted-foreground">KPIs that changed colour since the last board pack. Old and new status stay on one line.</p>
        <ChangesSinceSnapshot kpis={CHANGES} hasSnapshot />
      </div>
    </div>
  );
}
