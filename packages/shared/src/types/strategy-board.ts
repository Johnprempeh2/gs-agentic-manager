import type { GoalKind, GoalWhyRequestStatus, KpiRagStatus, KpiReadingSource, StrategyBoardPackStatus } from "../constants.js";
import type { GoalRagRollup, KpiStatusReason } from "../goal-kpi-status.js";

/**
 * Board control panel (GRE-1135). Read by board members (company viewers with
 * the `strategy:board_member` right), owners and admins while the
 * `enableStrategyBoard` switch is on.
 */

/** Who owns a goal, with a name the board can read. */
export type StrategyBoardOwner =
  | { type: "user"; id: string; name: string | null }
  | { type: "agent"; id: string; name: string | null };

/** One KPI as the board sees it: performance and, separately, how far to trust it. */
export interface StrategyBoardKpi {
  goalId: string;
  title: string;
  unit: string | null;
  /** The pillar or CSF the KPI sits under; null when it is not under one. */
  areaId: string | null;
  areaTitle: string | null;
  /** The objective the KPI sits under, if any. */
  objectiveId: string | null;
  objectiveTitle: string | null;
  owner: StrategyBoardOwner | null;
  status: KpiRagStatus | null;
  reason: KpiStatusReason;
  /** Percent behind plan; 0 when on or ahead of plan. */
  gapPercent: number | null;
  latestValue: number | null;
  plannedValue: number | null;
  targetValue: number | null;
  /** The deadline, "YYYY-MM-DD". */
  targetDate: string | null;
  /** "YYYY-MM-DD" of the newest reading. */
  latestReadingDate: string | null;
  /** Source of the newest reading: owner-reported is weaker evidence than agent-checked. */
  latestReadingSource: KpiReadingSource | null;
  /** Days between the newest reading and today; null with no reading. */
  readingAgeDays: number | null;
  /** Status in the last board pack; null when there is no pack or the KPI was not in it. */
  previousStatus: KpiRagStatus | null;
  previousValue: number | null;
  /** True when the status differs from the last board pack (a new KPI counts as changed). */
  changedSinceSnapshot: boolean;
  openWhyRequests: number;
}

/**
 * A task under a plan objective whose due date has passed and which is not
 * done or cancelled (GRE-1188). The owner is the task's assignee.
 */
export interface StrategyBoardAction {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  /** "YYYY-MM-DD" */
  dueDate: string;
  daysOverdue: number;
  objectiveId: string;
  objectiveTitle: string;
  /** The pillar or CSF above the objective; null when it is not under one. */
  areaId: string | null;
  areaTitle: string | null;
  owner: StrategyBoardOwner | null;
}

/** A pillar or CSF with its objectives. */
export interface StrategyBoardArea {
  goalId: string;
  title: string;
  kind: GoalKind;
  rollup: GoalRagRollup;
  objectives: Array<{ goalId: string; title: string; rollup: GoalRagRollup; owner: StrategyBoardOwner | null }>;
}

export interface StrategyBoardSnapshotRef {
  packId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  createdAt: Date;
}

export interface StrategyBoardSummary {
  companyId: string;
  /** "YYYY-MM-DD" the statuses are judged on. */
  asOf: string;
  /** The last accepted board pack, which "changed since" compares against. Drafts never count. */
  lastSnapshot: StrategyBoardSnapshotRef | null;
  counts: { red: number; amber: number; green: number; noStatus: number };
  /** Red then amber KPIs, biggest slippage first. */
  attention: StrategyBoardKpi[];
  areas: StrategyBoardArea[];
  /** Overdue plan actions, grouped by objective then owner, most overdue first. */
  overdueActions: StrategyBoardAction[];
  /** KPIs whose status changed since the last board pack. Empty when there is no pack. */
  changes: StrategyBoardKpi[];
  /** Every KPI on the plan, for the board pack and the full list. */
  kpis: StrategyBoardKpi[];
  /** Red KPIs whose alert had no chair to go to (the spell opened before a chair was set). */
  unsentAlerts: number;
  /** True when the board has a chair to receive slippage alerts. */
  hasChair: boolean;
  viewer: StrategyBoardViewerRights;
}

/** What the signed-in person may do on the board page. */
export interface StrategyBoardViewerRights {
  isBoardMember: boolean;
  isChair: boolean;
  /** May send "Why?" requests and make board packs. */
  mayAskWhy: boolean;
  mayMakeBoardPack: boolean;
  /** May choose board members and the chair (company owners). */
  mayManageMembers: boolean;
}

export interface GoalWhyRequest {
  id: string;
  companyId: string;
  goalId: string;
  question: string;
  status: GoalWhyRequestStatus;
  askedByUserId: string;
  /** The owner when the request was sent. */
  ownerUserId: string | null;
  ownerAgentId: string | null;
  /** The task that asks the owner to answer. */
  ownerIssueId: string | null;
  answer: string | null;
  answeredByUserId: string | null;
  answeredByAgentId: string | null;
  answeredAt: Date | null;
  createdAt: Date;
}

/** One red spell of a KPI. A new alert is sent only when no spell is open. */
export interface GoalKpiAlert {
  id: string;
  companyId: string;
  goalId: string;
  /** The chair the alert went to; null when no chair was set. */
  recipientUserId: string | null;
  alertIssueId: string | null;
  gapPercent: number | null;
  latestValue: number | null;
  openedAt: Date;
  /** When the KPI left red; null while it is still red. */
  clearedAt: Date | null;
}

export interface StrategyBoardMember {
  userId: string;
  name: string | null;
  email: string | null;
  /** The company role; board members must be viewers. */
  role: string;
  isBoardMember: boolean;
  isChair: boolean;
}

/** Frozen content of a board pack: what the board saw, kept as it was. */
export interface StrategyBoardPackSnapshot {
  version: 1;
  companyName: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  asOf: string;
  counts: StrategyBoardSummary["counts"];
  areas: StrategyBoardArea[];
  kpis: StrategyBoardKpi[];
  /** Overdue plan actions on the day the pack was made. Absent in packs made before GRE-1188. */
  overdueActions?: StrategyBoardAction[];
  /** Readings dated inside the period, by KPI, newest first. */
  readings: Array<{
    goalId: string;
    value: number;
    readingDate: string;
    source: KpiReadingSource;
    note: string | null;
  }>;
  /** "Why?" requests asked or answered inside the period. */
  whyRequests: Array<{
    goalId: string;
    question: string;
    status: GoalWhyRequestStatus;
    answer: string | null;
    askedAt: string;
    answeredAt: string | null;
    ownerName: string | null;
  }>;
}

export interface StrategyBoardPack {
  id: string;
  companyId: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  /** "draft" when the board secretary agent made it; only an accepted pack is the meeting's pack. */
  status: StrategyBoardPackStatus;
  createdByUserId: string | null;
  /** The board secretary agent that made the draft. */
  createdByAgentId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  /** The pack as a Markdown document. */
  body: string;
  snapshot: StrategyBoardPackSnapshot;
}

export type StrategyBoardPackListItem = Omit<StrategyBoardPack, "body" | "snapshot">;
