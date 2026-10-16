import { z } from "zod";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_METRICS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
  DEFAULT_BUDGET_WARN_PERCENT,
  TOP_UP_APPROVAL_RULES,
} from "../constants.js";
import { AI_ACCESS_ROUTES } from "../ai-connections.js";

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(BUDGET_SCOPE_TYPES),
  scopeId: z.string().guid(),
  metric: z.enum(BUDGET_METRICS).optional().default("billed_cents"),
  windowKind: z.enum(BUDGET_WINDOW_KINDS).optional().default("calendar_month_utc"),
  amount: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(99).optional().default(DEFAULT_BUDGET_WARN_PERCENT),
  hardStopEnabled: z.boolean().optional().default(true),
  notifyEnabled: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
  effectiveFrom: z.string().datetime({ offset: true }).optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
  amount: z.number().int().nonnegative().optional(),
  decisionNote: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "raise_budget_and_resume" && typeof value.amount !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount is required when raising a budget",
      path: ["amount"],
    });
  }
});

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;

export const updateBudgetAuthoritySchema = z.object({
  ceilingCents: z.number().int().nonnegative().nullable(),
  approverUserIds: z.array(z.string().trim().min(1).max(200)).max(50),
  /** Who accepts a top-up, per AI route (GRE-1371). Absent: keep the current rules. */
  topUpApprovalByRoute: z.partialRecord(z.enum(AI_ACCESS_ROUTES), z.enum(TOP_UP_APPROVAL_RULES)).optional(),
  reason: z.string().trim().min(1).max(1000),
});

export type UpdateBudgetAuthority = z.infer<typeof updateBudgetAuthoritySchema>;
