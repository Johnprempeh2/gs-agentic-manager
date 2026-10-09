import { z } from "zod";
import { GOAL_KINDS, GOAL_LEVELS, GOAL_STATUSES, KPI_DIRECTIONS, KPI_READING_SOURCES } from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form");

const thresholdPctSchema = z.number().finite().gt(0).max(1000);

const budgetCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  /** When left out, the server picks the level from the kind (plain goals: "task"). */
  level: z.enum(GOAL_LEVELS).optional(),
  kind: z.enum(GOAL_KINDS).optional().nullable(),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().guid().optional().nullable(),
  ownerAgentId: z.string().guid().optional().nullable(),
  /** A person owner (a company member's user id). Send this or ownerAgentId, not both. */
  ownerUserId: z.string().trim().min(1).max(200).optional().nullable(),
  targetDate: calendarDateSchema.optional().nullable(),
  doneWhen: z.string().optional().nullable(),
  /** A KPI may aim at zero (incidents) or below (net cash), so any finite number. */
  targetValue: z.number().finite().optional().nullable(),
  currentValue: z.number().finite().optional().nullable(),
  unit: z.string().max(64).optional().nullable(),
  baselineValue: z.number().finite().optional().nullable(),
  baselineDate: calendarDateSchema.optional().nullable(),
  kpiDirection: z.enum(KPI_DIRECTIONS).optional().nullable(),
  /** Percent off the planned path. The server checks red is not below amber. */
  amberThresholdPct: thresholdPctSchema.optional().nullable(),
  redThresholdPct: thresholdPctSchema.optional().nullable(),
  budgetPlannedCents: budgetCentsSchema.optional().nullable(),
  budgetSpentCents: budgetCentsSchema.optional().nullable(),
  budgetCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Expected a three-letter currency code, e.g. USD")
    .optional()
    .nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = objectWithoutDefaults(createGoalSchema).partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;

export const createGoalCheckInSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  progressPercent: z.number().int().min(0).max(100).optional().nullable(),
  blockers: z.array(z.string().trim().min(1).max(500)).max(20).optional().default([]),
});

export type CreateGoalCheckIn = z.infer<typeof createGoalCheckInSchema>;

export const createGoalKpiReadingSchema = z.object({
  value: z.number().finite(),
  readingDate: calendarDateSchema,
  note: z.string().trim().max(5_000).optional().nullable(),
  /** Defaults to owner_reported. Only agents may post agent_verified or system. */
  source: z.enum(KPI_READING_SOURCES).optional().default("owner_reported"),
});

export type CreateGoalKpiReading = z.infer<typeof createGoalKpiReadingSchema>;
