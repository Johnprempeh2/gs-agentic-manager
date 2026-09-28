import { z } from "zod";
import { BILLING_TYPES, COST_STATUSES } from "../constants.js";

export const createCostEventSchema = z.object({
  agentId: z.string().guid(),
  issueId: z.string().guid().optional().nullable(),
  projectId: z.string().guid().optional().nullable(),
  goalId: z.string().guid().optional().nullable(),
  heartbeatRunId: z.string().guid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  costStatus: z.enum(COST_STATUSES).optional().default("reported"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;

export const createCompanySubscriptionSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  plan: z.string().trim().min(1).max(200),
  monthlyPriceCents: z.number().int().nonnegative().max(100_000_000),
});

export type CreateCompanySubscription = z.infer<typeof createCompanySubscriptionSchema>;

export const updateCompanySubscriptionSchema = createCompanySubscriptionSchema.partial();

export type UpdateCompanySubscription = z.infer<typeof updateCompanySubscriptionSchema>;
