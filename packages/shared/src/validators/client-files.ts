import { z } from "zod";

export const CLIENT_FILES_MAX_QUERY_LENGTH = 200;

const title = z.string().trim().min(1).max(200);
const note = z.string().trim().max(1000).optional().nullable();
/** The journey stage to file the item under; omitted or null for the client as a whole. */
const stageId = z.string().guid().optional().nullable();

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
    stageId,
  }),
  z.object({
    kind: z.literal("document"),
    documentId: z.string().guid(),
    title: title.optional(),
    note,
    stageId,
  }),
  z.object({
    kind: z.literal("link"),
    url: httpUrl,
    title,
    note,
    stageId,
    sourceIssueId: z.string().guid().optional().nullable(),
  }),
]);

/**
 * POST /api/cases/:caseId/evidence/upload — the text fields that travel with
 * the multipart `file`. Empty strings from a form count as not given.
 */
export const uploadClientEvidenceFieldsSchema = z.object({
  title: z.preprocess((value) => (value === "" ? undefined : value), title.optional()),
  note: z.preprocess((value) => (value === "" ? undefined : value), note),
  stageId: z.preprocess((value) => (value === "" ? undefined : value), stageId),
});

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
export type UploadClientEvidenceFields = z.infer<typeof uploadClientEvidenceFieldsSchema>;
export type ClientFilesQuery = z.infer<typeof clientFilesQuerySchema>;
