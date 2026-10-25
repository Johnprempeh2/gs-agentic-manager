import { z } from "zod";
import { WEBSITE_ENTRY_STATUSES, WEBSITE_PAGE_MENUS, WEBSITE_PAGE_STATUSES } from "../types/website-module.js";

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Use the bare domain, e.g. www.example.com");

const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;
const OWNER_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The site's code repository: `owner/site-name` (copy `connect.repo`). A GitHub
 * address is stored as `owner/site-name`; any other http(s) address is kept as is.
 */
export const websiteRepoSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value) => {
    const github = GITHUB_URL_RE.exec(value);
    return github ? `${github[1]}/${github[2]}` : value;
  })
  .refine(
    (value) => OWNER_NAME_RE.test(value) || /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(value),
    "Use owner/site-name, for example acme/website",
  );

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

/** A preview address the Preview tab frames: https only, no credentials. */
export const websitePreviewUrlSchema = z
  .string()
  .trim()
  .max(500)
  .url("Enter a full address, starting https://")
  .refine((value) => {
    // The refinement runs even when `.url()` has already failed.
    const url = URL.canParse(value) ? new URL(value) : null;
    return !!url && url.protocol === "https:" && !url.username && !url.password;
  }, "Use an https address without a user name or password");

const websiteSiteFields = z
  .object({
    name: z.string().trim().min(1).max(120),
    domain: domainSchema,
    repoUrl: websiteRepoSchema.nullable().optional(),
    netlifySiteId: z.string().trim().min(1).max(120),
    /** A pasted token, stored in the company's secrets as this site's own secret; never returned. */
    netlifyToken: z.string().trim().min(10).max(500).optional(),
    /**
     * Use a company secret that already holds a Netlify token, for example the one agents use.
     * The site never rotates or deletes a secret it links this way. `null` unlinks it.
     */
    netlifyTokenSecretId: z.string().uuid().nullable().optional(),
    propertyId: z.string().uuid().nullable().optional(),
    editorOrigins: z.array(z.string().trim().url().max(300)).max(10).optional(),
    /** The dedicated editor host. The route checks rule C1.1 and that the caller may publish. */
    editorFrameOrigin: z.string().trim().min(1).max(300).nullable().optional(),
    /** Preview addresses (24 Oct 2026); null clears one back to its default. */
    livePreviewUrl: websitePreviewUrlSchema.nullable().optional(),
    devPreviewUrl: websitePreviewUrlSchema.nullable().optional(),
    checkPaths: z.array(websiteStaticPathSchema).min(1).max(20).optional(),
  })
  .strict();

function oneTokenSource(value: { netlifyToken?: string; netlifyTokenSecretId?: string | null }) {
  return !(value.netlifyToken && value.netlifyTokenSecretId !== undefined);
}
const ONE_TOKEN_SOURCE = { message: "Paste a token or choose a saved secret, not both", path: ["netlifyTokenSecretId"] };

export const createWebsiteSiteSchema = websiteSiteFields.refine(oneTokenSource, ONE_TOKEN_SOURCE);
export type CreateWebsiteSite = z.infer<typeof createWebsiteSiteSchema>;

export const updateWebsiteSiteSchema = websiteSiteFields
  .partial()
  .extend({ archived: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" })
  .refine(oneTokenSource, ONE_TOKEN_SOURCE);
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
    /** `false` restores an archived page at the top level. Archive with the archive route. */
    archived: z.literal(false).optional(),
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

/**
 * Click to change (GRE-2121, plan 3.4): the block a person picked in the
 * preview and what they want changed. The block reference is durable (page,
 * revision, block id and type, engine commit); `source` is only a hint.
 */
/** The editor widths a comment can be made at (GRE-2350). */
export const WEBSITE_COMMENT_WIDTHS = ["laptop", "tablet", "phone"] as const;
export type WebsiteCommentWidth = (typeof WEBSITE_COMMENT_WIDTHS)[number];

/**
 * Click to change (GRE-2121) and Ask an agent (GRE-2350). With a block, the
 * task is about that block; with no `blockId` and `blockType`, it is about the
 * whole page. `engine` and `source` come only from a preview pick.
 */
export const createWebsiteChangeRequestSchema = z
  .object({
    /** Client-made id for this confirm; the same id never makes a second task. */
    requestId: z.string().uuid(),
    pageRevisionId: z.string().uuid(),
    blockId: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/).optional(),
    blockType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/).optional(),
    blockLabel: z.string().trim().max(200).optional(),
    /** The editor width the person saw the page at. */
    width: z.enum(WEBSITE_COMMENT_WIDTHS).optional(),
    engine: z.object({ version: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict().optional(),
    source: z
      .object({
        file: z.string().regex(/^[A-Za-z0-9_./-]{1,300}$/).refine((file) => !file.startsWith("/") && !file.split("/").includes("..")),
        line: z.number().int().positive(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The change, in the person's own words. */
    request: z.string().trim().min(1).max(4000),
  })
  .strict()
  .refine((value) => (value.blockId === undefined) === (value.blockType === undefined), {
    message: "Send blockId and blockType together, or neither for the whole page.",
    path: ["blockType"],
  });
export type CreateWebsiteChangeRequest = z.infer<typeof createWebsiteChangeRequestSchema>;

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
    /** `false` restores an archived entry. Archive with the archive route. */
    archived: z.literal(false).optional(),
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
