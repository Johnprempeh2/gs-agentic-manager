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
/**
 * Who may see a deliverable. Internal never leaves the team; client items may
 * reach the client portal once the case has an accepted NDA; public items may
 * reach it without one. Deliverables without a label are internal.
 */
export const deliverableConfidentialitySchema = z.enum(["internal", "client", "public"]);
export const DEFAULT_DELIVERABLE_CONFIDENTIALITY = "internal" as const;

/** A link deliverable points at a live site: https only, so the server never fetches plain http. */
export const deliverableUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https:\/\//i.test(value), "url must start with https://");

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
  confidentiality: deliverableConfidentialitySchema.optional(),
  /** Mark a link deliverable as password protected or unlisted. */
  restricted: z.boolean().optional(),
});

/**
 * POST /api/issues/:issueId/deliverables — register a new deliverable (or its
 * next version). Send exactly one of `attachmentId` (a stored file on the
 * issue) or `url` (a live https site, shown as a screenshot with "Open site").
 */
export const createDeliverableSchema = deliverableFieldsSchema.extend({
  attachmentId: z.string().guid().optional(),
  url: deliverableUrlSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.attachmentId === !value.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "Send exactly one of attachmentId or url" });
  }
});

/** PATCH /api/companies/:companyId/deliverables/:id — relabel every version of a deliverable. */
export const updateDeliverableSchema = z.object({
  confidentiality: deliverableConfidentialitySchema.optional(),
  restricted: z.boolean().optional(),
}).refine((value) => value.confidentiality !== undefined || value.restricted !== undefined, "Nothing to update");

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
  confidentiality: deliverableConfidentialitySchema.optional(),
  /** "broken": only link deliverables whose last check failed. */
  linkHealth: z.enum(["broken"]).optional(),
  from: optionalDate,
  to: optionalDate,
  sort: deliverableSortSchema.optional().default("newest"),
  limit: z.coerce.number().int().min(1).max(DELIVERABLES_MAX_LIMIT).optional().default(DELIVERABLES_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type CreateDeliverable = z.infer<typeof createDeliverableSchema>;
export type MarkDeliverable = z.infer<typeof markDeliverableSchema>;
export type UpdateDeliverable = z.infer<typeof updateDeliverableSchema>;
export type DeliverablesQuery = z.infer<typeof deliverablesQuerySchema>;

export const DELIVERABLE_COMMENT_QUOTE_MAX = 1_000;
export const DELIVERABLE_COMMENT_CONTEXT_MAX = 64;
export const DELIVERABLE_COMMENT_BODY_MAX = 4_000;
export const DELIVERABLE_COMMENT_PATH_MAX = 1_000;
export const DELIVERABLE_COMMENT_LABEL_MAX = 200;

const fraction = z.number().min(0).max(1);

export const deliverableCommentBoxSchema = z.object({
  x: fraction,
  y: fraction,
  width: fraction,
  height: fraction,
});

export const deliverableCommentLocatorSchema = z.object({
  // Only `tag:nth-of-type(n)` steps joined by " > ", so it is safe to show and query.
  path: z.string().trim().min(1).max(DELIVERABLE_COMMENT_PATH_MAX).regex(/^[a-zA-Z0-9:()> -]+$/),
  tag: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/i),
  label: z.string().trim().max(DELIVERABLE_COMMENT_LABEL_MAX).optional().nullable(),
  box: deliverableCommentBoxSchema.optional().nullable(),
});

/**
 * POST /api/companies/:companyId/deliverables/:id/comments — a draft note on a
 * passage (`anchorKind` "text", the default), an element or a region. Element
 * and region notes need a `locator`; a region also needs its `box`.
 */
export const createDeliverableCommentSchema = z.object({
  anchorKind: z.enum(["text", "element", "region"]).optional().default("text"),
  quote: z.string().trim().min(1).max(DELIVERABLE_COMMENT_QUOTE_MAX),
  prefix: z.string().max(DELIVERABLE_COMMENT_CONTEXT_MAX).optional().nullable(),
  suffix: z.string().max(DELIVERABLE_COMMENT_CONTEXT_MAX).optional().nullable(),
  textStart: z.number().int().min(0).optional().nullable(),
  locator: deliverableCommentLocatorSchema.optional().nullable(),
  body: z.string().trim().min(1).max(DELIVERABLE_COMMENT_BODY_MAX),
}).superRefine((value, ctx) => {
  if (value.anchorKind === "text") {
    if (value.locator) ctx.addIssue({ code: "custom", path: ["locator"], message: "A text comment has no locator" });
    return;
  }
  if (!value.locator) {
    ctx.addIssue({ code: "custom", path: ["locator"], message: "An element or region comment needs a locator" });
  } else if (value.anchorKind === "region" && !value.locator.box) {
    ctx.addIssue({ code: "custom", path: ["locator", "box"], message: "A region comment needs its box" });
  } else if (value.anchorKind === "element" && value.locator.box) {
    ctx.addIssue({ code: "custom", path: ["locator", "box"], message: "An element comment has no box" });
  }
});

/** PATCH /api/companies/:companyId/deliverables/:id/comments/:commentId — edit a draft's note. */
export const updateDeliverableCommentSchema = z.object({
  body: z.string().trim().min(1).max(DELIVERABLE_COMMENT_BODY_MAX),
});

export type CreateDeliverableComment = z.infer<typeof createDeliverableCommentSchema>;
/** The create body as a client sends it: `anchorKind` may be left out for text. */
export type CreateDeliverableCommentInput = z.input<typeof createDeliverableCommentSchema>;
export type UpdateDeliverableComment = z.infer<typeof updateDeliverableCommentSchema>;
