import { z } from "zod";

export const CLIENT_FILES_MAX_QUERY_LENGTH = 200;

const title = z.string().trim().min(1).max(200);
const note = z.string().trim().max(1000).optional().nullable();

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "url must start with http:// or https://");

/** POST /api/cases/:caseId/evidence — add a task file, a task document or a link. */
export const createClientEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attachment"),
    attachmentId: z.string().guid(),
    title: title.optional(),
    note,
  }),
  z.object({
    kind: z.literal("document"),
    documentId: z.string().guid(),
    title: title.optional(),
    note,
  }),
  z.object({
    kind: z.literal("link"),
    url: httpUrl,
    title,
    note,
    sourceIssueId: z.string().guid().optional().nullable(),
  }),
]);

/** ?q= on the case routes: text search on the item name. */
export const clientFilesSearchSchema = z.object({
  q: z.string().trim().max(CLIENT_FILES_MAX_QUERY_LENGTH).optional(),
});

/** GET /api/companies/:companyId/client-files — by client (caseId) or project. */
export const clientFilesQuerySchema = clientFilesSearchSchema
  .extend({
    caseId: z.string().guid().optional(),
    projectId: z.string().guid().optional(),
  })
  .refine((value) => Boolean(value.caseId || value.projectId), {
    message: "Give caseId or projectId",
  });

export type CreateClientEvidence = z.infer<typeof createClientEvidenceSchema>;
export type ClientFilesQuery = z.infer<typeof clientFilesQuerySchema>;
