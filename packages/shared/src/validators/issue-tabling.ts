import { z } from "zod";

/** "Not now" (GRE-262): body for POST /api/issues/{id}/table. */
export const tableIssueSchema = z.object({
  /** Optional return date (ISO 8601 with offset). Omit or null: tabled until brought back. */
  returnAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export type TableIssue = z.infer<typeof tableIssueSchema>;
