import type {
  BudgetIncidentResolutionAction,
  BudgetIncidentStatus,
  BudgetMetric,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
  PauseReason,
} from "../constants.js";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  pendingAmount: number | null;
  pendingEffectiveFrom: Date | null;
  pendingReason: string | null;
  pendingRequestedByUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: PauseReason | null;
  windowStart: Date;
  windowEnd: Date;
  /** A dated change not yet in force (GRE-1363). */
  pendingAmount?: number | null;
  pendingEffectiveFrom?: Date | null;
  /** Tasks whose queued work this scope's hard stop holds (GRE-1365). Absent = 0. */
  heldTaskCount?: number;
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: BudgetThresholdType;
  amountLimit: number;
  amountObserved: number;
  status: BudgetIncidentStatus;
  approvalId: string | null;
  approvalStatus: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
  /** Tasks held at a budget hard stop in this company (GRE-1365). Absent = 0. */
  heldTaskCount?: number;
}

export interface BudgetPolicyUpsertInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  metric?: BudgetMetric;
  windowKind?: BudgetWindowKind;
  amount: number;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
  /** ISO time the new amount takes effect; absent or past means now (GRE-1363). */
  effectiveFrom?: string | null;
  reason?: string | null;
}

/** Operator-set spending authority for one company (GRE-1363). */
export interface BudgetAuthority {
  companyId: string;
  /** No budget a non-operator sets or raises may exceed this. Null: no ceiling. */
  ceilingCents: number | null;
  /** Users who may resolve a budget override. Empty: any board user. */
  approverUserIds: string[];
  updatedByUserId: string | null;
  updatedAt: Date | null;
}

export interface BudgetIncidentResolutionInput {
  action: BudgetIncidentResolutionAction;
  amount?: number;
  decisionNote?: string | null;
}
