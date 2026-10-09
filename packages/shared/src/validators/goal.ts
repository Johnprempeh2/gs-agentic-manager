import { z } from "zod";
import { GOAL_KINDS, GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form");

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
  targetValue: z.number().finite().positive().optional().nullable(),
  currentValue: z.number().finite().min(0).optional().nullable(),
  unit: z.string().max(64).optional().nullable(),
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
