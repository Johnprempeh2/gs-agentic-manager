import { z } from "zod";

/** "Not now" (GRE-262): body for POST /api/issues/{id}/table. */
export const tableIssueSchema = z.object({
  /** Optional return date (ISO 8601 with offset). Omit or null: tabled until brought back. */
  returnAt: z.string().datetime({ offset: true }).nullable().optional(),
  /**
   * "Waiting on someone outside" (Tidy desk): who the task waits on, free
   * text. Recorded as a comment on the task. Agents must send it, with a returnAt.
   */
  waitingOn: z.string().trim().min(1).max(500).optional(),
}).strict();

export type TableIssue = z.infer<typeof tableIssueSchema>;
