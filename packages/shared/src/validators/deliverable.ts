import { z } from "zod";

export const DELIVERABLES_DEFAULT_LIMIT = 60;
export const DELIVERABLES_MAX_LIMIT = 200;
export const DELIVERABLES_MAX_QUERY_LENGTH = 160;
export const DEFAULT_DELIVERABLE_BRAND = "Greatstone";

/**
 * Sandbox tokens for agent-made HTML. The server sends them in the
 * Content-Security-Policy of every HTML attachment response, and the UI puts
 * the same tokens on the iframes that preview deliverables, so the two cannot
 * drift: scripts run in an opaque origin with no forms, storage, or app access.
 */
export const HTML_ATTACHMENT_SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
] as const;

// No remote hosts: thumbnails render live, so a remote image or script would
// tell a third party who opened the page, when and from where (GRE-405).
export const HTML_ATTACHMENT_CSP = [
  `sandbox ${HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ")}`,
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const deliverableKindSchema = z.enum(["report", "brief", "plan", "deck", "other"]);
export const deliverableStatusSchema = z.enum(["draft", "final"]);
export const deliverableSortSchema = z.enum(["newest", "recently_opened", "title"]);

/** Lowercase slug used as the version key when the caller does not send one. */
export function deliverableKeyFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "deliverable";
}

const deliverableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "key must be lowercase letters, digits, dot, dash or underscore");

const deliverableFieldsSchema = z.object({
  key: deliverableKeySchema.optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(280).optional().nullable(),
  // Omitted fields carry over from the previous version; a first version
  // falls back to kind "report", the Greatstone brand and status "final".
  kind: deliverableKindSchema.optional(),
  brand: z.string().trim().min(1).max(80).optional(),
  status: deliverableStatusSchema.optional(),
});

/** POST /api/issues/:issueId/deliverables — register a new deliverable (or its next version). */
export const createDeliverableSchema = deliverableFieldsSchema.extend({
  attachmentId: z.string().guid(),
});

/**
 * POST /api/companies/:companyId/deliverables/mark — promote an artifact
 * shown on the Artifacts page. `artifactId` is the Artifacts list id
 * (`attachment:<uuid>` or `work_product:<uuid>`).
 */
export const markDeliverableSchema = deliverableFieldsSchema
  .extend({
    artifactId: z.string().regex(/^(attachment|work_product):[0-9a-f-]{36}$/i, "artifactId must be an attachment or work product artifact id"),
    title: z.string().trim().min(1).max(200).optional(),
  });

const optionalDate = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date")
  .optional();

export const deliverablesQuerySchema = z.object({
  q: z.string().trim().max(DELIVERABLES_MAX_QUERY_LENGTH).optional(),
  kind: deliverableKindSchema.optional(),
  projectId: z.string().guid().optional(),
  agentId: z.string().guid().optional(),
  brand: z.string().trim().min(1).max(80).optional(),
  from: optionalDate,
  to: optionalDate,
  sort: deliverableSortSchema.optional().default("newest"),
  limit: z.coerce.number().int().min(1).max(DELIVERABLES_MAX_LIMIT).optional().default(DELIVERABLES_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateDeliverable = z.infer<typeof createDeliverableSchema>;
export type MarkDeliverable = z.infer<typeof markDeliverableSchema>;
export type DeliverablesQuery = z.infer<typeof deliverablesQuerySchema>;

export const DELIVERABLE_COMMENT_QUOTE_MAX = 1_000;
export const DELIVERABLE_COMMENT_CONTEXT_MAX = 64;
export const DELIVERABLE_COMMENT_BODY_MAX = 4_000;

/** POST /api/companies/:companyId/deliverables/:id/comments — a draft note on a passage. */
export const createDeliverableCommentSchema = z.object({
  quote: z.string().trim().min(1).max(DELIVERABLE_COMMENT_QUOTE_MAX),
  prefix: z.string().max(DELIVERABLE_COMMENT_CONTEXT_MAX).optional().nullable(),
  suffix: z.string().max(DELIVERABLE_COMMENT_CONTEXT_MAX).optional().nullable(),
  textStart: z.number().int().min(0).optional().nullable(),
  body: z.string().trim().min(1).max(DELIVERABLE_COMMENT_BODY_MAX),
});

/** PATCH /api/companies/:companyId/deliverables/:id/comments/:commentId — edit a draft's note. */
export const updateDeliverableCommentSchema = z.object({
  body: z.string().trim().min(1).max(DELIVERABLE_COMMENT_BODY_MAX),
});

export type CreateDeliverableComment = z.infer<typeof createDeliverableCommentSchema>;
export type UpdateDeliverableComment = z.infer<typeof updateDeliverableCommentSchema>;
