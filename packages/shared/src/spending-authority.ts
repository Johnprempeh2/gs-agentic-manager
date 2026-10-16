import { z } from "zod";
import { aiAccessRouteSchema } from "./ai-connections.js";

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
