import { z } from "zod";

const hour = z.number().int().min(0).max(23);

/** The longest pause on offer is "until Monday morning"; a week covers it. */
const MAX_PAUSE_MS = 8 * 24 * 60 * 60 * 1000;

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A partial update; quiet hours are set or cleared together. */
export const updateNotificationPreferencesSchema = z
  .object({
    decisions: z.boolean().optional(),
    assignedTasks: z.boolean().optional(),
    teamChat: z.boolean().optional(),
    finishedWork: z.boolean().optional(),
    dealsClosed: z.boolean().optional(),
    morningSummary: z.boolean().optional(),
    morningSummaryHour: hour.optional(),
    eveningSummary: z.boolean().optional(),
    eveningSummaryHour: hour.optional(),
    weeklyReport: z.boolean().optional(),
    quietHoursStart: hour.nullable().optional(),
    quietHoursEnd: hour.nullable().optional(),
    quietWeekends: z.boolean().optional(),
    timeZone: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone").optional(),
    /** Pause phone notifications until this time; null resumes them. */
    pausedUntil: z
      .string()
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) - Date.now() <= MAX_PAUSE_MS, "A pause can last up to a week")
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.quietHoursStart === undefined) === (value.quietHoursEnd === undefined)
      && (value.quietHoursStart === null) === (value.quietHoursEnd === null),
    { message: "Set both ends of quiet hours, or clear both" },
  )
  .refine(
    (value) => value.quietHoursStart == null || value.quietHoursStart !== value.quietHoursEnd,
    { message: "Quiet hours must start and end at different times" },
  );

export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>;
