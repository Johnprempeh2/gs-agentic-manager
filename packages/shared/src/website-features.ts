import { z } from "zod";
import type { WebsiteHomeActivity, WebsitePageStatus, WebsiteReleaseStatus } from "./types/website-module.js";
import { websitePagePathSchema } from "./validators/website-module.js";

// Website features (GRE-2325, plan of 24 Oct 2026). A feature is one big part
// of a site: its slice of the sitemap (route prefixes), its collections, an
// optional owner and lead agent, and an on/off switch. Off hides the feature's
// screens and never deletes data. A page belongs to the feature with the
// longest prefix that matches its path, so `/` catches what no other claims.

export const WEBSITE_FEATURE_ICONS = [
  "blocks",
  "globe",
  "shopping-bag",
  "key-round",
  "users",
  "telescope",
  "door-open",
  "radar",
  "file-text",
  "briefcase",
] as const;
export type WebsiteFeatureIcon = (typeof WEBSITE_FEATURE_ICONS)[number];

export interface WebsiteFeatureAdminScreen {
  name: string;
  /** The task that moves this screen into GSAM, for example `GRE-2326`. */
  issue: string | null;
}

export interface WebsiteFeature {
  id: string;
  companyId: string;
  siteId: string;
  key: string;
  name: string;
  purpose: string;
  icon: WebsiteFeatureIcon;
  ownerUserId: string | null;
  /** A name shown as a hint in Settings; never sets the owner on its own. */
  suggestedOwner: string | null;
  leadAgentId: string | null;
  projectId: string | null;
  routePrefixes: string[];
  collections: string[];
  /** Admin screens planned for this feature, each naming the task that moves it in. Placeholders until those tasks land. */
  adminScreens: WebsiteFeatureAdminScreen[];
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** `attention`: the last release that touched the feature failed or is pending. `unknown`: no traffic or release data yet. */
export type WebsiteFeatureHealthState = "ok" | "attention" | "unknown";

export interface WebsiteFeatureHealth {
  state: WebsiteFeatureHealthState;
  /** One plain sentence: why the dot has this colour. */
  reason: string;
}

export interface WebsiteFeatureRelease {
  id: string;
  number: number;
  status: WebsiteReleaseStatus;
  at: string;
}

/** A feature as its card on Website Home shows it. Counts are null when they cannot be known (no linked project). */
export interface WebsiteFeatureCard {
  feature: WebsiteFeature;
  ownerName: string | null;
  leadAgentName: string | null;
  pageCount: number;
  openTasks: number | null;
  /** Open tasks waiting on a person: assigned to a person, or with a question or approval card open. */
  needsPerson: number | null;
  lastRelease: WebsiteFeatureRelease | null;
  /** Page views in the latest Google Analytics pull, over the top pages in the feature's slice; null without a pull. */
  views: number | null;
  health: WebsiteFeatureHealth;
}

export interface WebsiteFeaturePageSummary {
  id: string;
  slug: string;
  title: string;
  status: WebsitePageStatus;
}

/** The feature page: its card, the pages in its slice and its recent changes. */
export interface WebsiteFeatureDetail extends WebsiteFeatureCard {
  pages: WebsiteFeaturePageSummary[];
  recentChanges: WebsiteHomeActivity[];
}

export const WEBSITE_FEATURES_API_ROUTES = {
  /** GET → `WebsiteFeature[]`, the site's registry in order (website:view). POST `CreateWebsiteFeature` → 201 `WebsiteFeature` (website:publish, people only). */
  features: "/companies/:companyId/website/sites/:siteId/features",
  /** GET → `WebsiteFeatureCard[]` for the Features section of Website Home (website:view). */
  featureCards: "/companies/:companyId/website/sites/:siteId/feature-cards",
  /** GET → `WebsiteFeatureDetail`. PATCH `UpdateWebsiteFeature` → `WebsiteFeature`. DELETE → 204, archives the registry row only (website:publish, people only). */
  feature: "/companies/:companyId/website/sites/:siteId/features/:featureId",
} as const;

const routePrefixSchema = websitePagePathSchema;
const adminScreenSchema = z
  .object({ name: z.string().trim().min(1).max(80), issue: z.string().trim().regex(/^[A-Z][A-Z0-9]*-\d+$/, "Use a task id like GRE-2326").nullable() })
  .strict();
const collectionKeySchema = z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/, "Use a collection key like product or public-person");

export const createWebsiteFeatureSchema = z
  .object({
    /** Leave out to make one from the name. */
    key: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/, "Use a key like shop or client-portal").optional(),
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().max(280).optional().default(""),
    icon: z.enum(WEBSITE_FEATURE_ICONS).optional().default("blocks"),
    ownerUserId: z.string().trim().min(1).nullable().optional(),
    suggestedOwner: z.string().trim().min(1).max(80).nullable().optional(),
    leadAgentId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    routePrefixes: z.array(routePrefixSchema).max(50).optional().default([]),
    collections: z.array(collectionKeySchema).max(30).optional().default([]),
    adminScreens: z.array(adminScreenSchema).max(20).optional().default([]),
    enabled: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateWebsiteFeature = z.input<typeof createWebsiteFeatureSchema>;

export const updateWebsiteFeatureSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().max(280),
    icon: z.enum(WEBSITE_FEATURE_ICONS),
    ownerUserId: z.string().trim().min(1).nullable(),
    suggestedOwner: z.string().trim().min(1).max(80).nullable(),
    leadAgentId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    routePrefixes: z.array(routePrefixSchema).max(50),
    collections: z.array(collectionKeySchema).max(30),
    adminScreens: z.array(adminScreenSchema).max(20),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();
export type UpdateWebsiteFeature = z.infer<typeof updateWebsiteFeatureSchema>;

/** True when `path` is `prefix` or below it. `/` holds every path. */
export function routePrefixMatches(prefix: string, path: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The feature a page belongs to: the longest matching prefix wins, so
 * `/account/orders` (Shop) beats `/account` (Client portal). Off features
 * still own their routes. Ties go to the earlier feature in `features`.
 */
export function websiteFeatureForPath<T extends Pick<WebsiteFeature, "routePrefixes">>(path: string, features: readonly T[]): T | null {
  let best: T | null = null;
  let bestLength = -1;
  for (const feature of features) {
    for (const prefix of feature.routePrefixes) {
      if (routePrefixMatches(prefix, path) && prefix.length > bestLength) {
        best = feature;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
