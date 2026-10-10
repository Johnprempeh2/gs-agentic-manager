import { z } from "zod";

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form");

/** A board member asks the KPI owner to explain a slippage (GRE-1135). */
export const createGoalWhyRequestSchema = z.object({
  question: z.string().trim().min(1).max(5_000),
});
export type CreateGoalWhyRequest = z.infer<typeof createGoalWhyRequestSchema>;

/** The owner's answer; it is logged on the KPI. */
export const answerGoalWhyRequestSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
});
export type AnswerGoalWhyRequest = z.infer<typeof answerGoalWhyRequestSchema>;

export const createStrategyBoardPackSchema = z
  .object({
    periodStart: calendarDateSchema,
    periodEnd: calendarDateSchema,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((value) => value.periodStart <= value.periodEnd, {
    message: "The period must start on or before its end",
    path: ["periodEnd"],
  });
export type CreateStrategyBoardPack = z.infer<typeof createStrategyBoardPackSchema>;

/** The full list of board members; anyone left out loses the right. At most one chair. */
export const setStrategyBoardMembersSchema = z
  .object({
    members: z
      .array(z.object({ userId: z.string().trim().min(1).max(200), chair: z.boolean().optional().default(false) }))
      .max(200),
  })
  .refine((value) => value.members.filter((member) => member.chair).length <= 1, {
    message: "The board has one chair",
    path: ["members"],
  })
  .refine((value) => new Set(value.members.map((member) => member.userId)).size === value.members.length, {
    message: "Each person is listed once",
    path: ["members"],
  });
export type SetStrategyBoardMembers = z.infer<typeof setStrategyBoardMembersSchema>;

/** Board email settings (GRE-1187). Leave a field out to keep it. */
export const updateStrategyBoardSettingsSchema = z
  .object({
    secretaryEndpointId: z.string().uuid().nullable().optional(),
    nextMeetingDate: calendarDateSchema.nullable().optional(),
    reminderLeadDays: z.number().int().min(0).max(60).optional(),
  })
  .strict();
export type UpdateStrategyBoardSettings = z.infer<typeof updateStrategyBoardSettingsSchema>;
