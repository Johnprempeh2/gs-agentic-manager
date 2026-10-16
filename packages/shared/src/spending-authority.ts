import { z } from "zod";
import { aiAccessRouteSchema } from "./ai-connections.js";
import type { TopUpApprovalRule } from "./constants.js";

/**
 * Spending authority (GRE-1363). The hosting operator (instance admin) sets a
 * budget ceiling and the named override approvers for each company; the client
 * board works inside them. Values are settings, never constants here.
 */

/** 403 when a non-operator sets or raises a budget above the operator ceiling. */
export const BUDGET_ABOVE_OPERATOR_CEILING_ERROR_CODE = "budget_above_operator_ceiling";
/** 403 when a non-operator would remove or weaken the company cap under a ceiling. */
export const BUDGET_CAP_OPERATOR_MANAGED_ERROR_CODE = "budget_cap_operator_managed";
/** 403 when someone outside the named approvers resolves a budget override. */
export const BUDGET_APPROVER_REQUIRED_ERROR_CODE = "budget_approver_required";
/** 403 when someone other than the operator decides an AI route change. */
export const OPERATOR_APPROVAL_REQUIRED_ERROR_CODE = "operator_approval_required";

/** Approval a client board user opens to change the AI route; only the operator decides it. */
export const AI_ROUTE_CHANGE_APPROVAL_TYPE = "ai_route_change";

export const requestAiRouteChangeSchema = z.object({
  /** Null clears the route: each agent keeps its own harness and connection. */
  route: aiAccessRouteSchema.nullable(),
  reason: z.string().trim().min(1).max(1000),
});

export type RequestAiRouteChange = z.infer<typeof requestAiRouteChangeSchema>;

/**
 * Budget top-ups and pre-authorised extra ceilings (GRE-1371, B3 on GRE-1357).
 * Both are rows of one ledger. A top-up adds its amount to one calendar month
 * (UTC): to the AI allowance and to the company's monthly cap. A
 * pre-authorised ceiling lets the operator side accept top-ups for one month
 * in advance, up to its amount. Amounts are API-equivalent US cents, the unit
 * of budgets and the allowance. No amount is set in code.
 */
export const BUDGET_TOP_UP_APPROVAL_TYPE = "budget_top_up";

/** 403 when the requester is neither the operator side nor a company owner or admin. */
export const TOP_UP_REQUESTER_NOT_ALLOWED_ERROR_CODE = "top_up_requester_not_allowed";
/** 403 when someone outside the awaited side decides a top-up. */
export const TOP_UP_APPROVER_REQUIRED_ERROR_CODE = "top_up_approver_required";

export const BUDGET_TOP_UP_KINDS = ["top_up", "pre_authorisation"] as const;
export type BudgetTopUpKind = (typeof BUDGET_TOP_UP_KINDS)[number];

/** `pending` waits on one side's approval; `applied` is in force; `rejected` never was. */
export const BUDGET_TOP_UP_STATUSES = ["pending", "applied", "rejected"] as const;
export type BudgetTopUpStatus = (typeof BUDGET_TOP_UP_STATUSES)[number];

export const TOP_UP_APPROVAL_SIDES = ["operator", "client"] as const;
export type TopUpApprovalSide = (typeof TOP_UP_APPROVAL_SIDES)[number];

/** First day of a calendar month (UTC), `YYYY-MM-01`. */
const monthStartSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, "Use the first day of a month, YYYY-MM-01");

export const requestBudgetTopUpSchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  /** Reference of the invoice line that bills it, when already known. */
  invoiceReference: z.string().trim().min(1).max(200).optional().nullable(),
});
export type RequestBudgetTopUp = z.infer<typeof requestBudgetTopUpSchema>;

export const recordBudgetPreAuthorisationSchema = z.object({
  amountCents: z.number().int().positive(),
  /** The month it covers. Absent: the current month. A past month is refused. */
  windowStart: monthStartSchema.optional().nullable(),
  reason: z.string().trim().min(1).max(1000),
  invoiceReference: z.string().trim().min(1).max(200).optional().nullable(),
});
export type RecordBudgetPreAuthorisation = z.infer<typeof recordBudgetPreAuthorisationSchema>;

export const attachBudgetTopUpInvoiceSchema = z.object({
  invoiceReference: z.string().trim().min(1).max(200),
});
export type AttachBudgetTopUpInvoice = z.infer<typeof attachBudgetTopUpInvoiceSchema>;

export interface BudgetTopUpApproval {
  side: TopUpApprovalSide;
  userId: string;
  at: string;
}

/** One ledger row: a top-up or a pre-authorised extra ceiling. */
export interface BudgetTopUp {
  id: string;
  companyId: string;
  kind: BudgetTopUpKind;
  status: BudgetTopUpStatus;
  amountCents: number;
  /** The calendar month (UTC) it counts in, `YYYY-MM-01`. */
  windowStart: string;
  /** When it took effect; null while pending or rejected. */
  effectiveFrom: string | null;
  reason: string;
  requestedByUserId: string | null;
  /** Who accepted it last; for a pre-authorised top-up, who pre-authorised it. */
  approvedByUserId: string | null;
  approvals: BudgetTopUpApproval[];
  /** The rule the top-up was decided under. */
  approvalRule: TopUpApprovalRule | null;
  awaitingSide: TopUpApprovalSide | null;
  /** The pre-authorised ceiling that accepted the operator side, if any. */
  preAuthorisationId: string | null;
  approvalId: string | null;
  invoiceReference: string | null;
  financeEventId: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The top-ups of one month and how much pre-authorised headroom is left. */
export interface BudgetTopUpWindow {
  companyId: string;
  windowStart: string;
  /** Sum of applied top-ups in the month. */
  topUpTotalCents: number;
  preAuthorisedCents: number;
  /** Pre-authorised cents not yet used by a top-up. */
  preAuthorisedRemainingCents: number;
  /** The rule for the current AI route. */
  approvalRule: TopUpApprovalRule;
  entries: BudgetTopUp[];
}
