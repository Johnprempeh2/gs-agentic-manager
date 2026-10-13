import type {
  AiBriefingSections,
  DailyPulseSections,
  IntelligenceBoard,
  IntelligenceBoardEntry,
  IntelligenceBoardMovement,
  IntelligenceEffort,
  IntelligenceRecommendationKind,
  IntelligenceRecommendationStatus,
  IntelligenceReportKind,
  IntelligenceReportStatus,
} from "../validators/intelligence.js";

// Intelligence page API (behind `enableIntelligence`; off = 403 not_entitled).

interface IntelligenceReportBase {
  id: string;
  companyId: string;
  reportDate: string;
  status: IntelligenceReportStatus;
  headline: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IntelligenceReport =
  | (IntelligenceReportBase & { kind: "daily_pulse"; sections: DailyPulseSections })
  | (IntelligenceReportBase & { kind: "ai_briefing"; sections: AiBriefingSections });

/** Archive row: no sections. */
export interface IntelligenceReportSummary {
  id: string;
  reportDate: string;
  kind: IntelligenceReportKind;
  status: IntelligenceReportStatus;
  headline: string | null;
  updatedAt: string;
}

export type IntelligenceBoardRow = IntelligenceBoardEntry & { movement: IntelligenceBoardMovement };

export interface IntelligenceBoardView {
  board: IntelligenceBoard;
  snapshotDate: string;
  /** The snapshot the movement is measured against, or null when there is none. */
  comparedTo: string | null;
  entries: IntelligenceBoardRow[];
}

export interface IntelligenceBoards {
  boards: IntelligenceBoardView[];
}

export interface IntelligenceBoardSnapshot {
  id: string;
  companyId: string;
  board: IntelligenceBoard;
  snapshotDate: string;
  entries: IntelligenceBoardEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceRecommendation {
  id: string;
  companyId: string;
  kind: IntelligenceRecommendationKind;
  title: string;
  why: string;
  effort: IntelligenceEffort;
  status: IntelligenceRecommendationStatus;
  sourceUrl: string | null;
  reportDate: string | null;
  issueId: string | null;
  /** The linked task's identifier (GRE-123) once a task exists. */
  issueIdentifier: string | null;
  createdByAgentId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
