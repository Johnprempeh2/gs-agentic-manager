import { z } from "zod";
import { WEBSITE_ENTRY_STATUSES, WEBSITE_PAGE_MENUS, WEBSITE_PAGE_STATUSES } from "../types/website-module.js";

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Use the bare domain, e.g. www.example.com");

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), "Use an http or https address");

/** A URL path a visitor can open: `/` or `/a/b-c`. */
export const websiteStaticPathSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^\/([a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*)?$/, "Use a path like /consultancy/deep-dive (lower case, hyphens)");

const PATH_SEGMENT = "(?:[a-z0-9][a-z0-9-]*|:[a-zA-Z][a-zA-Z0-9_]*)";
const PAGE_PATH = new RegExp(`^/(${PATH_SEGMENT}(/${PATH_SEGMENT})*)?$`);

/** A page's path: a static path, or a pattern with `:param` segments such as `/portal/:client/overview`. */
export const websitePagePathSchema = z
  .string()
  .trim()
  .max(300)
  .regex(PAGE_PATH, "Use a path like /consultancy/deep-dive (lower case, hyphens) or /portal/:client/overview");

/**
 * A pattern path (`:param` segments) stands for many URLs, e.g. one per client.
 * Its page is private: never in sitemap.xml and never a menu link (GRE-2146).
 */
export function isPrivatePagePath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(":"));
}

const seoSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(500).optional(),
    canonical: z.string().trim().max(500).optional(),
    ogImageAssetId: z.string().uuid().optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

export const createWebsiteSiteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    domain: domainSchema,
    repoUrl: httpsUrl.nullable().optional(),
    netlifySiteId: z.string().trim().min(1).max(120),
    /** Stored in the company's secrets; never returned. */
    netlifyToken: z.string().trim().min(10).max(500).optional(),
    propertyId: z.string().uuid().nullable().optional(),
    editorOrigins: z.array(z.string().trim().url().max(300)).max(10).optional(),
    /** The dedicated editor host. The route checks rule C1.1 and that the caller may publish. */
    editorFrameOrigin: z.string().trim().min(1).max(300).nullable().optional(),
    checkPaths: z.array(websiteStaticPathSchema).min(1).max(20).optional(),
  })
  .strict();
export type CreateWebsiteSite = z.infer<typeof createWebsiteSiteSchema>;

export const updateWebsiteSiteSchema = createWebsiteSiteSchema
  .partial()
  .extend({ archived: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateWebsiteSite = z.infer<typeof updateWebsiteSiteSchema>;

const sitemapFields = {
  parentPageId: z.string().uuid().nullable().optional(),
  menu: z.enum(WEBSITE_PAGE_MENUS).optional(),
  menuOrder: z.number().int().min(0).max(10_000).nullable().optional(),
  navOrder: z.number().int().min(0).max(10_000).nullable().optional(),
};

export const createWebsitePageSchema = z
  .object({
    slug: websitePagePathSchema,
    title: z.string().trim().min(1).max(200),
    status: z.enum(["planned", "draft"]).optional(),
    seo: seoSchema.optional(),
    /** The page's Puck JSON. Defaults to an empty page. */
    content: z.unknown().optional(),
    ...sitemapFields,
  })
  .strict();
export type CreateWebsitePage = z.infer<typeof createWebsitePageSchema>;

export const updateWebsitePageSchema = z
  .object({
    slug: websitePagePathSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(WEBSITE_PAGE_STATUSES).exclude(["approved", "published"]).optional(),
    seo: seoSchema.optional(),
    ...sitemapFields,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateWebsitePage = z.infer<typeof updateWebsitePageSchema>;

export const saveWebsiteContentSchema = z
  .object({
    /** The revision the editor started from; a newer latest revision is a conflict. */
    baseRevisionId: z.string().uuid(),
    content: z.unknown().refine((value) => value !== undefined, "content is required"),
    changeSummary: z.string().trim().max(500).optional(),
    /** Sent by the editor frame host: the editor origin its session opened with (rule C2.4). */
    editorOrigin: z.string().trim().max(300).optional(),
  })
  .strict();
export type SaveWebsiteContent = z.infer<typeof saveWebsiteContentSchema>;

export const restoreWebsiteRevisionSchema = z
  .object({
    /** The latest revision the user saw; a newer one is a conflict and nothing is restored. */
    baseRevisionId: z.string().uuid(),
  })
  .strict();
export type RestoreWebsiteRevision = z.infer<typeof restoreWebsiteRevisionSchema>;

export const sendBackWebsiteContentSchema = z
  .object({
    /** What needs to change. Shown to the author. */
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type SendBackWebsiteContent = z.infer<typeof sendBackWebsiteContentSchema>;

const collectionSchema = z.string().trim().regex(/^[a-z][a-z0-9_-]{0,39}$/, "Use a lower-case collection key");

export const createWebsiteEntrySchema = z
  .object({
    collection: collectionSchema,
    entryKey: z.string().trim().min(1).max(200),
    orgId: z.string().trim().max(120).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).nullable().optional(),
    content: z.unknown().optional(),
  })
  .strict();
export type CreateWebsiteEntry = z.infer<typeof createWebsiteEntrySchema>;

export const updateWebsiteEntrySchema = z
  .object({
    entryKey: z.string().trim().min(1).max(200).optional(),
    orgId: z.string().trim().max(120).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100_000).nullable().optional(),
    status: z.enum(WEBSITE_ENTRY_STATUSES).exclude(["approved", "published"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateWebsiteEntry = z.infer<typeof updateWebsiteEntrySchema>;

/**
 * Retry and Rollback bodies (GRE-2108). A click that would start a rebuild
 * (one production deploy, about 15 credits) must say so with
 * `confirmRebuild: true`; a free verify or restore needs nothing.
 */
export const websiteReleaseActionSchema = z
  .object({
    confirmRebuild: z.boolean().optional(),
  })
  .strict();
export type WebsiteReleaseAction = z.infer<typeof websiteReleaseActionSchema>;
