import { z } from "zod";

// Portal documents on a connected website (GRE-4083, GRE-4079 step 2b): the client portal's engagement packs, NDAs,
// terms and the rest, written through the signed admin bridge (contracts/gs-bridge-v1, "Portal documents", GRE-4081).
// Drafting is open to any actor with website:edit: create, edit a draft, submit it for approval, return it to draft.
// Approve and publish, and withdraw, are a person's click (website:publish): GSAM refuses an agent with 403
// website_publish_agent_refused and a board API key with 403 website_portal_people_only, before any call to the site.
// The site refuses again: approve and publish only for a registered portal approver, withdraw only for a person.
// Reads stay on `data/portal-documents`.

export const WEBSITE_PORTAL_DOCUMENT_KINDS = [
  "engagement_pack", "nda", "gita", "terms", "pre_read", "north_star", "investigation_plan", "gdxp",
] as const;
export type WebsitePortalDocumentKind = (typeof WEBSITE_PORTAL_DOCUMENT_KINDS)[number];
export const WEBSITE_PORTAL_DOCUMENT_ACTIONS = ["none", "accept", "agree_in_principle"] as const;
export type WebsitePortalDocumentAction = (typeof WEBSITE_PORTAL_DOCUMENT_ACTIONS)[number];
export type WebsitePortalDocumentStatus = "draft" | "pending_approval" | "published" | "withdrawn" | "superseded";

/** The site takes up to 1 MB on these routes (other bridge writes stay at 64 KiB). */
export const WEBSITE_PORTAL_DOCUMENT_MAX_BODY_BYTES = 1024 * 1024;

export const WEBSITE_PORTAL_DOCUMENT_API_ROUTES = {
  /** POST `WebsitePortalDocumentCreateInput` → 201 `{ item }` (website:edit; agents may). A draft. */
  create: "/companies/:companyId/website/sites/:siteId/portal-documents",
  /** PATCH `WebsitePortalDocumentEditInput` → `{ item }` (website:edit; agents may). Drafts only. */
  edit: "/companies/:companyId/website/sites/:siteId/portal-documents/:documentId",
  /** POST `{ expectedRowVersion }` → `{ item }` (website:edit; agents may). Draft to pending_approval; the site freezes the content. */
  submit: "/companies/:companyId/website/sites/:siteId/portal-documents/:documentId/submit",
  /** POST `{ expectedRowVersion }` → `{ item }` (website:edit; agents may). Pending_approval back to draft. */
  returnToDraft: "/companies/:companyId/website/sites/:siteId/portal-documents/:documentId/return-to-draft",
  /**
   * POST `{ expectedContentSha256, gsamApprovalRef? }` → `{ item, approvalId }` (website:publish, a signed-in person
   * only). The site also needs the person to be a registered portal approver (403 website_bridge_denied).
   */
  approveAndPublish: "/companies/:companyId/website/sites/:siteId/portal-documents/:documentId/approve-and-publish",
  /** POST `{ expectedRowVersion }` → `{ item }` (website:publish, a signed-in person only). Published to withdrawn. */
  withdraw: "/companies/:companyId/website/sites/:siteId/portal-documents/:documentId/withdraw",
} as const;

const rowVersion = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The site's limits and HTML rules (greatstone-website, lib/shared/portal-mcp.mjs `checkDocumentFields`), checked here
// too: the site answers a bad field with a bare 400, so GSAM says which field and why first.
export const WEBSITE_PORTAL_DOCUMENT_LIMITS = {
  title: 200, summary: 2000, sections: 60, sectionTitle: 200, html: 100_000, demos: 20, label: 120, note: 500, confirmation: 1000,
} as const;
const L = WEBSITE_PORTAL_DOCUMENT_LIMITS;
const SECTION_TAGS = new Set(["P", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "A", "BR", "BLOCKQUOTE", "CODE", "PRE", "SPAN", "HR"]);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g;
const ATTR_RE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SAFE_HREF = /^(https:\/\/[^\s"'<>\\]+|mailto:[^\s"'<>\\]+)$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

/** Problems with one section's html, as the site words them; empty when it is fine. */
export function websitePortalSectionHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  if (/<!|<\?/.test(html)) problems.push("comments, doctype and processing instructions are not allowed");
  for (const m of html.matchAll(TAG_RE)) {
    const [, closing, name, rest] = m as unknown as [string, string, string, string];
    const tag = name.toUpperCase();
    if (!SECTION_TAGS.has(tag)) { problems.push(`<${name.toLowerCase()}> is not allowed`); continue; }
    if (closing) { if (rest.trim()) problems.push(`</${name.toLowerCase()}> cannot have attributes`); continue; }
    for (const a of rest.replace(/\/\s*$/, "").matchAll(ATTR_RE)) {
      const attr = a[1]!.toLowerCase();
      const value = a[2] ?? a[3] ?? a[4];
      if (attr === "href" && tag === "A") {
        if (!SAFE_HREF.test(value || "")) problems.push("links must start with https:// or mailto:");
      } else if (attr === "class") {
        if (!/^[a-z0-9 _-]*$/i.test(value || "")) problems.push("class may hold only letters, digits, - and _");
      } else {
        problems.push(`the ${attr} attribute is not allowed`);
      }
    }
  }
  if (html.replace(TAG_RE, "").includes("<")) problems.push("write a literal < as &lt;");
  return [...new Set(problems)];
}

const sectionHtml = z.string().max(L.html).superRefine((html, ctx) => {
  for (const message of websitePortalSectionHtmlProblems(html)) ctx.addIssue({ code: "custom", message });
});

/** The document's sections: only the site's tags and links. Anything else is refused, never rewritten. */
export const websitePortalDocumentBodySchema = z.object({
  sections: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/i, "1 to 64 letters, digits, - or _"),
    title: z.string().max(L.sectionTitle).refine((t) => t.trim().length > 0, "cannot be empty"),
    html: sectionHtml,
  }).strict()).max(L.sections).superRefine((sections, ctx) => {
    const ids = new Set<string>();
    sections.forEach((section, i) => {
      if (ids.has(section.id)) ctx.addIssue({ code: "custom", message: `id ${section.id} is used twice`, path: [i, "id"] });
      ids.add(section.id);
    });
  }),
}).strict();

export const websitePortalDocumentDemosSchema = z.array(z.object({
  label: z.string().max(L.label).refine((t) => t.trim().length > 0, "cannot be empty"),
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// link"),
  note: z.string().max(L.note).nullable().optional(),
  afterSection: z.string().max(64).nullable().optional(),
}).strict()).max(L.demos);

const editableFields = {
  title: z.string().max(L.title).refine((t) => t.trim().length > 0, "cannot be empty"),
  summary: z.string().max(L.summary).nullable(),
  body: websitePortalDocumentBodySchema.nullable(),
  demos: websitePortalDocumentDemosSchema.nullable(),
  /** A document with an action needs confirmationText before it is submitted. */
  action: z.enum(WEBSITE_PORTAL_DOCUMENT_ACTIONS).nullable(),
  confirmationText: z.string().max(L.confirmation).nullable(),
  signatoryEmail: z.union([z.literal(""), z.string().max(320).regex(EMAIL_RE, "must be an email address")]).nullable(),
};

export const websitePortalDocumentCreateSchema = z.object({
  /** A client of the site (website_data_list customers). */
  customerId: z.string().uuid(),
  kind: z.enum(WEBSITE_PORTAL_DOCUMENT_KINDS),
  /** Starts the next version of this client's document in that series; publishing it supersedes the one before. */
  series: z.string().uuid().optional(),
  title: editableFields.title,
  summary: editableFields.summary.optional(),
  body: editableFields.body.optional(),
  demos: editableFields.demos.optional(),
  action: editableFields.action.optional(),
  confirmationText: editableFields.confirmationText.optional(),
  signatoryEmail: editableFields.signatoryEmail.optional(),
}).strict();
export type WebsitePortalDocumentCreateInput = z.infer<typeof websitePortalDocumentCreateSchema>;

export const websitePortalDocumentEditSchema = z.object({
  expectedRowVersion: rowVersion,
  title: editableFields.title.optional(),
  summary: editableFields.summary.optional(),
  body: editableFields.body.optional(),
  demos: editableFields.demos.optional(),
  action: editableFields.action.optional(),
  confirmationText: editableFields.confirmationText.optional(),
  signatoryEmail: editableFields.signatoryEmail.optional(),
}).strict().refine((input) => Object.keys(input).length > 1, { message: "change at least one field", path: ["title"] });
export type WebsitePortalDocumentEditInput = z.infer<typeof websitePortalDocumentEditSchema>;

/** Submit, return to draft and withdraw: the row version as last read. */
export const websitePortalDocumentStepSchema = z.object({ expectedRowVersion: rowVersion }).strict();
export type WebsitePortalDocumentStepInput = z.infer<typeof websitePortalDocumentStepSchema>;

export const websitePortalDocumentApproveSchema = z.object({
  /** The fingerprint the site froze at submit (the document's content_sha256). */
  expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/, "64 lower-case hex characters"),
  gsamApprovalRef: z.string().min(1).max(200).optional(),
}).strict();
export type WebsitePortalDocumentApproveInput = z.infer<typeof websitePortalDocumentApproveSchema>;

export type WebsitePortalDocumentStep = "submit" | "return-to-draft" | "approve-and-publish" | "withdraw";

/** The document as the site returns it: no PDF path and no website user id. */
export interface WebsitePortalDocument {
  id: string;
  customer_id: string;
  kind: WebsitePortalDocumentKind;
  series: string | null;
  version: number;
  title: string;
  summary: string | null;
  body: unknown;
  demos: unknown;
  pdf_sha256: string | null;
  has_pdf: boolean;
  action: WebsitePortalDocumentAction;
  confirmation_text: string | null;
  signatory_email: string | null;
  status: WebsitePortalDocumentStatus;
  content_sha256: string | null;
  approval_id: string | null;
  created_by_kind: "agent" | "staff";
  created_run_id: string | null;
  published_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface WebsitePortalDocumentAnswer {
  item: WebsitePortalDocument;
  /** Approve and publish only. */
  approvalId?: string;
}
