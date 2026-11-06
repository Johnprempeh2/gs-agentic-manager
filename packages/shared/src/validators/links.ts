import { z } from "zod";
import { LINK_STATUSES, LINK_TYPES } from "../types/links.js";

export const LINKS_MAX_QUERY_LENGTH = 200;
export const LINKS_IMPORT_MAX_ROWS = 2000;

/**
 * One spelling per link, so the same site is not registered twice:
 * `https://Site.netlify.app` and `https://site.netlify.app/` are the same row.
 */
export function normalizeLinkUrl(value: string): string {
  return new URL(value.trim()).toString();
}

const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "url must start with http:// or https://")
  .transform(normalizeLinkUrl);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalGuid = z.string().guid().nullable().optional();
const deployedAt = z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional();

const linkFields = {
  title: z.string().trim().min(1).max(300),
  type: z.enum(LINK_TYPES).optional(),
  status: z.enum(LINK_STATUSES).optional(),
  clientCaseId: optionalGuid,
  clientName: optionalText(200),
  projectId: optionalGuid,
  projectName: optionalText(200),
  sourceIssueId: optionalGuid,
  notes: optionalText(4000),
  deployedAt,
};

/** POST /api/companies/:companyId/links. The same URL again updates that row. */
export const createLinkSchema = z.object({ url: linkUrl, ...linkFields }).strict();
export type CreateLink = z.infer<typeof createLinkSchema>;

export const updateLinkSchema = z
  .object({ ...linkFields, title: linkFields.title.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateLink = z.infer<typeof updateLinkSchema>;

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** GET /api/companies/:companyId/links */
export const linksQuerySchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(LINKS_MAX_QUERY_LENGTH).optional()),
  clientCaseId: z.preprocess(blankToUndefined, z.string().guid().optional()),
  projectId: z.preprocess(blankToUndefined, z.string().guid().optional()),
  type: z.preprocess(blankToUndefined, z.enum(LINK_TYPES).optional()),
  status: z.preprocess(blankToUndefined, z.enum(LINK_STATUSES).optional()),
  /** Archived links are hidden unless asked for by status or with this flag. */
  includeArchived: z.preprocess(
    (value) => (value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : blankToUndefined(value)),
    z.boolean().optional(),
  ),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type LinksQuery = z.infer<typeof linksQuerySchema>;

/**
 * POST /api/companies/:companyId/links/import. A CSV export of the Notion
 * "Netlify Link Register": a header row, then one link per row. Column names
 * are matched loosely (Name or Title, Client, Project, Type, Status, URL,
 * Deploy Date or Created, Notes).
 */
export const importLinksSchema = z.object({ csv: z.string().min(1).max(2_000_000) }).strict();
export type ImportLinks = z.infer<typeof importLinksSchema>;
