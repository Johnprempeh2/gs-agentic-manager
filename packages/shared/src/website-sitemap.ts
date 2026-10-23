import { z } from "zod";
import { WEBSITE_PAGE_MENUS, type WebsitePage, type WebsitePageMenu } from "./types/website-module.js";
import { websitePagePathSchema } from "./validators/website-module.js";

// Sitemap section (GRE-2111). A sitemap option is a named draft of the site's
// structure: a flat list of nodes (pages) with parents, menus and board
// positions, plus named visitor journeys. Options never touch pages; approving
// one writes its tree into the site's pages.

export const WEBSITE_SITEMAP_OPTION_STATUSES = ["draft", "approved", "archived"] as const;
export type WebsiteSitemapOptionStatus = (typeof WEBSITE_SITEMAP_OPTION_STATUSES)[number];

export const WEBSITE_SITEMAP_MAX_NODES = 1000;

export interface WebsiteSitemapNode {
  /** Stable within the option; survives renames and moves. */
  id: string;
  title: string;
  /** The page's URL path, e.g. `/consultancy/deep-dive`. */
  path: string;
  parentId: string | null;
  /** Order among siblings. */
  order: number;
  menu: WebsitePageMenu;
  menuOrder: number | null;
  /** Footer column or header dropdown column, e.g. "Services". */
  menuColumn?: string | null;
  /** The site page this node became when an option was approved. */
  pageId?: string | null;
  template?: string | null;
  seoTitle?: string | null;
  noindex?: boolean;
  owner?: string | null;
  notes?: string | null;
  /** Board position; laid out automatically when missing. */
  x?: number | null;
  y?: number | null;
}

export interface WebsiteSitemapJourney {
  id: string;
  name: string;
  /** Node ids, in visiting order. */
  steps: string[];
}

export interface WebsiteSitemapTree {
  nodes: WebsiteSitemapNode[];
  journeys: WebsiteSitemapJourney[];
}

export interface WebsiteSitemapOption {
  id: string;
  companyId: string;
  siteId: string;
  name: string;
  description: string | null;
  tree: WebsiteSitemapTree;
  status: WebsiteSitemapOptionStatus;
  proposedByAgentId: string | null;
  createdByUserId: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  /** Approved, then edited: approve again to apply the changes to the site. */
  changedSinceApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebsiteSitemapApproveResult {
  option: WebsiteSitemapOption;
  pages: WebsitePage[];
  summary: { created: number; updated: number; archived: number };
}

const nodeIdSchema = z.string().trim().min(1).max(80);

export const websiteSitemapNodeSchema = z
  .object({
    id: nodeIdSchema,
    title: z.string().trim().min(1).max(200),
    path: websitePagePathSchema,
    parentId: nodeIdSchema.nullable(),
    order: z.number().int().min(0).max(100_000),
    menu: z.enum(WEBSITE_PAGE_MENUS),
    menuOrder: z.number().int().min(0).max(100_000).nullable(),
    menuColumn: z.string().trim().max(80).nullable().optional(),
    pageId: z.string().uuid().nullable().optional(),
    template: z.string().trim().max(80).nullable().optional(),
    seoTitle: z.string().trim().max(200).nullable().optional(),
    noindex: z.boolean().optional(),
    owner: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    x: z.number().finite().min(-100_000).max(100_000).nullable().optional(),
    y: z.number().finite().min(-100_000).max(100_000).nullable().optional(),
  })
  .strict();

export const websiteSitemapJourneySchema = z
  .object({
    id: nodeIdSchema,
    name: z.string().trim().min(1).max(120),
    steps: z.array(nodeIdSchema).max(50),
  })
  .strict();

/** Shape plus the rules a tree must keep: unique ids and paths, parents that exist, no cycles. */
export const websiteSitemapTreeSchema = z
  .object({
    nodes: z.array(websiteSitemapNodeSchema).max(WEBSITE_SITEMAP_MAX_NODES),
    journeys: z.array(websiteSitemapJourneySchema).max(50).default([]),
  })
  .strict()
  .superRefine((tree, ctx) => {
    for (const problem of sitemapTreeProblems(tree)) ctx.addIssue({ code: "custom", message: problem });
  });

/** Every rule a tree breaks, in plain words. Empty when the tree is sound. */
export function sitemapTreeProblems(tree: WebsiteSitemapTree): string[] {
  const problems: string[] = [];
  const byId = new Map<string, WebsiteSitemapNode>();
  const paths = new Set<string>();
  for (const node of tree.nodes) {
    if (byId.has(node.id)) problems.push(`Two pages share the id ${node.id}.`);
    byId.set(node.id, node);
    if (paths.has(node.path)) problems.push(`Two pages share the path ${node.path}.`);
    paths.add(node.path);
  }
  for (const node of tree.nodes) {
    if (node.parentId && !byId.has(node.parentId)) problems.push(`${node.title} sits under a page that is not in this sitemap.`);
    let cursor = node.parentId;
    for (let depth = 0; cursor; depth += 1) {
      if (cursor === node.id || depth > tree.nodes.length) {
        problems.push(`${node.title} sits under itself.`);
        break;
      }
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }
  for (const journey of tree.journeys) {
    for (const step of journey.steps) {
      if (!byId.has(step)) problems.push(`The journey ${journey.name} names a page that is not in this sitemap.`);
    }
  }
  return problems;
}

export const createWebsiteSitemapOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    tree: websiteSitemapTreeSchema,
  })
  .strict();
export type CreateWebsiteSitemapOption = z.infer<typeof createWebsiteSitemapOptionSchema>;

export const updateWebsiteSitemapOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    tree: websiteSitemapTreeSchema.optional(),
    /** The option's updatedAt the editor started from; a newer one is a conflict (409). */
    baseUpdatedAt: z.string().datetime().optional(),
  })
  .strict();
export type UpdateWebsiteSitemapOption = z.infer<typeof updateWebsiteSitemapOptionSchema>;

/** A nested page, as a sitemap is usually written by hand or exported from a board. */
export interface WebsiteSitemapImportPage {
  title: string;
  path: string;
  menu?: WebsitePageMenu;
  menuOrder?: number | null;
  menuColumn?: string | null;
  template?: string | null;
  seoTitle?: string | null;
  noindex?: boolean;
  owner?: string | null;
  notes?: string | null;
  children?: WebsiteSitemapImportPage[];
}

const importPageSchema: z.ZodType<WebsiteSitemapImportPage> = z.lazy(() =>
  z
    .object({
      title: z.string().trim().min(1).max(200),
      path: websitePagePathSchema,
      menu: z.enum(WEBSITE_PAGE_MENUS).optional(),
      menuOrder: z.number().int().min(0).max(100_000).nullable().optional(),
      menuColumn: z.string().trim().max(80).nullable().optional(),
      template: z.string().trim().max(80).nullable().optional(),
      seoTitle: z.string().trim().max(200).nullable().optional(),
      noindex: z.boolean().optional(),
      owner: z.string().trim().max(120).nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      children: z.array(importPageSchema).max(WEBSITE_SITEMAP_MAX_NODES).optional(),
    })
    .strict(),
);

/** Import an option from a nested JSON tree; journeys name pages by path. */
export const importWebsiteSitemapOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    pages: z.array(importPageSchema).min(1).max(WEBSITE_SITEMAP_MAX_NODES),
    journeys: z
      .array(z.object({ name: z.string().trim().min(1).max(120), paths: z.array(websitePagePathSchema).max(50) }).strict())
      .max(50)
      .optional(),
  })
  .strict();
export type ImportWebsiteSitemapOption = z.infer<typeof importWebsiteSitemapOptionSchema>;

/** Flatten a nested import into a tree. Node ids are `n1`, `n2`, ... in reading order. */
export function sitemapTreeFromImport(input: ImportWebsiteSitemapOption): WebsiteSitemapTree {
  const nodes: WebsiteSitemapNode[] = [];
  const idByPath = new Map<string, string>();
  const walk = (pages: WebsiteSitemapImportPage[], parentId: string | null) => {
    pages.forEach((page, index) => {
      const id = `n${nodes.length + 1}`;
      idByPath.set(page.path, id);
      nodes.push({
        id,
        title: page.title,
        path: page.path,
        parentId,
        order: index,
        menu: page.menu ?? "none",
        menuOrder: page.menuOrder ?? null,
        menuColumn: page.menuColumn ?? null,
        template: page.template ?? null,
        seoTitle: page.seoTitle ?? null,
        noindex: page.noindex ?? false,
        owner: page.owner ?? null,
        notes: page.notes ?? null,
      });
      walk(page.children ?? [], id);
    });
  };
  walk(input.pages, null);
  const journeys = (input.journeys ?? []).map((journey, index) => ({
    id: `j${index + 1}`,
    name: journey.name,
    steps: journey.paths.map((path) => idByPath.get(path) ?? `missing:${path}`),
  }));
  return { nodes, journeys };
}

/* ---- Compare ---- */

export type SitemapChange = "added" | "removed" | "moved" | "renamed";

export interface SitemapDiffEntry {
  key: string;
  /** Node in option A (left), if any. */
  a: WebsiteSitemapNode | null;
  /** Node in option B (right), if any. */
  b: WebsiteSitemapNode | null;
  changes: SitemapChange[];
}

/** Same page in two options: by site page first, then by path, then by node id. */
function matchKey(node: WebsiteSitemapNode, matched: (key: string) => boolean): string {
  if (node.pageId && matched(`page:${node.pageId}`)) return `page:${node.pageId}`;
  return `path:${node.path}`;
}

/** Added, removed, moved (different parent) and renamed (different title) pages between options A and B. */
export function diffSitemapTrees(a: WebsiteSitemapTree, b: WebsiteSitemapTree): SitemapDiffEntry[] {
  const aPages = new Set(a.nodes.flatMap((node) => (node.pageId ? [`page:${node.pageId}`] : [])));
  const bPages = new Set(b.nodes.flatMap((node) => (node.pageId ? [`page:${node.pageId}`] : [])));
  const both = (key: string) => aPages.has(key) && bPages.has(key);
  const aById = new Map(a.nodes.map((node) => [node.id, node]));
  const bById = new Map(b.nodes.map((node) => [node.id, node]));
  const keyOfA = new Map(a.nodes.map((node) => [node.id, matchKey(node, both)]));
  const keyOfB = new Map(b.nodes.map((node) => [node.id, matchKey(node, both)]));
  const parentKey = (node: WebsiteSitemapNode, keys: Map<string, string>, byId: Map<string, WebsiteSitemapNode>) =>
    node.parentId && byId.has(node.parentId) ? keys.get(node.parentId)! : null;

  const entries = new Map<string, SitemapDiffEntry>();
  for (const node of a.nodes) entries.set(keyOfA.get(node.id)!, { key: keyOfA.get(node.id)!, a: node, b: null, changes: [] });
  for (const node of b.nodes) {
    const key = keyOfB.get(node.id)!;
    const entry = entries.get(key) ?? { key, a: null, b: null, changes: [] };
    entry.b = node;
    entries.set(key, entry);
  }
  for (const entry of entries.values()) {
    if (!entry.a) entry.changes.push("added");
    else if (!entry.b) entry.changes.push("removed");
    else {
      if (parentKey(entry.a, keyOfA, aById) !== parentKey(entry.b, keyOfB, bById)) entry.changes.push("moved");
      if (entry.a.title !== entry.b.title) entry.changes.push("renamed");
    }
  }
  return [...entries.values()];
}

export const WEBSITE_SITEMAP_API_ROUTES = {
  /** GET → `WebsiteSitemapOption[]` (not archived; `?includeArchived=true`). POST `CreateWebsiteSitemapOption` → 201 (website:edit; agents propose). */
  options: "/companies/:companyId/website/sites/:siteId/sitemap/options",
  /** POST `ImportWebsiteSitemapOption` → 201 `WebsiteSitemapOption` (website:edit). */
  importOption: "/companies/:companyId/website/sites/:siteId/sitemap/options/import",
  /** GET → `WebsiteSitemapOption`. PUT `UpdateWebsiteSitemapOption` → `WebsiteSitemapOption` (website:edit; 409 on a stale baseUpdatedAt). */
  option: "/companies/:companyId/website/sites/:siteId/sitemap/options/:optionId",
  /** POST → `WebsiteSitemapApproveResult`. People with website:publish only: writes the tree into the site's pages. */
  approveOption: "/companies/:companyId/website/sites/:siteId/sitemap/options/:optionId/approve",
  /** POST → `WebsiteSitemapOption` (website:edit). Not the approved option. */
  archiveOption: "/companies/:companyId/website/sites/:siteId/sitemap/options/:optionId/archive",
  /** GET → `application/xml`: the sitemap.xml the approved, non-noindex pages make (preview; publishing is separate). */
  sitemapXml: "/companies/:companyId/website/sites/:siteId/sitemap.xml",
} as const;
