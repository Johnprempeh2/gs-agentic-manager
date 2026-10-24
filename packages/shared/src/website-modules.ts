import { z } from "zod";
import type { WebsiteHomeActivity, WebsitePageStatus, WebsiteReleaseStatus } from "./types/website-module.js";
import { websitePagePathSchema } from "./validators/website-module.js";

// Website modules (GRE-2325, plan of 24 Oct 2026). A module is one big part
// of a site: its slice of the sitemap (route prefixes), its collections, an
// optional owner and lead agent, and an on/off switch. Off hides the module's
// screens and never deletes data. A page belongs to the module with the
// longest prefix that matches its path, so `/` catches what no other claims.

export const WEBSITE_MODULE_ICONS = [
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
export type WebsiteModuleIcon = (typeof WEBSITE_MODULE_ICONS)[number];

export interface WebsiteModule {
  id: string;
  companyId: string;
  siteId: string;
  key: string;
  name: string;
  purpose: string;
  icon: WebsiteModuleIcon;
  ownerUserId: string | null;
  leadAgentId: string | null;
  projectId: string | null;
  routePrefixes: string[];
  collections: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** `attention`: the last release that touched the module failed or is pending. `unknown`: no traffic or release data yet. */
export type WebsiteModuleHealthState = "ok" | "attention" | "unknown";

export interface WebsiteModuleHealth {
  state: WebsiteModuleHealthState;
  /** One plain sentence: why the dot has this colour. */
  reason: string;
}

export interface WebsiteModuleRelease {
  id: string;
  number: number;
  status: WebsiteReleaseStatus;
  at: string;
}

/** A module as its card on Website Home shows it. Counts are null when they cannot be known (no linked project). */
export interface WebsiteModuleCard {
  module: WebsiteModule;
  ownerName: string | null;
  leadAgentName: string | null;
  pageCount: number;
  openTasks: number | null;
  /** Open tasks waiting on a person: assigned to a person, or with a question or approval card open. */
  needsPerson: number | null;
  lastRelease: WebsiteModuleRelease | null;
  /** Page views in the latest Google Analytics pull, over the top pages in the module's slice; null without a pull. */
  views: number | null;
  health: WebsiteModuleHealth;
}

export interface WebsiteModulePageSummary {
  id: string;
  slug: string;
  title: string;
  status: WebsitePageStatus;
}

/** The module page: its card, the pages in its slice and its recent changes. */
export interface WebsiteModuleDetail extends WebsiteModuleCard {
  pages: WebsiteModulePageSummary[];
  recentChanges: WebsiteHomeActivity[];
}

export const WEBSITE_MODULES_API_ROUTES = {
  /** GET → `WebsiteModule[]`, the site's registry in order (website:view). POST `CreateWebsiteModule` → 201 `WebsiteModule` (website:publish, people only). */
  modules: "/companies/:companyId/website/sites/:siteId/modules",
  /** GET → `WebsiteModuleCard[]` for the Modules section of Website Home (website:view). */
  moduleCards: "/companies/:companyId/website/sites/:siteId/module-cards",
  /** POST → `WebsiteModule[]`: adds the starting modules the site does not have yet (website:publish, people only). */
  moduleSeed: "/companies/:companyId/website/sites/:siteId/modules/starting-set",
  /** GET → `WebsiteModuleDetail`. PATCH `UpdateWebsiteModule` → `WebsiteModule`. DELETE → 204, archives the registry row only (website:publish, people only). */
  module: "/companies/:companyId/website/sites/:siteId/modules/:moduleId",
} as const;

const routePrefixSchema = websitePagePathSchema;
const collectionKeySchema = z.string().trim().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/, "Use a collection key like product or public-person");

export const createWebsiteModuleSchema = z
  .object({
    key: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/, "Use a key like shop or client-portal"),
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().max(280).optional().default(""),
    icon: z.enum(WEBSITE_MODULE_ICONS).optional().default("blocks"),
    ownerUserId: z.string().trim().min(1).nullable().optional(),
    leadAgentId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    routePrefixes: z.array(routePrefixSchema).max(50).optional().default([]),
    collections: z.array(collectionKeySchema).max(30).optional().default([]),
    enabled: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type CreateWebsiteModule = z.input<typeof createWebsiteModuleSchema>;

export const updateWebsiteModuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().max(280),
    icon: z.enum(WEBSITE_MODULE_ICONS),
    ownerUserId: z.string().trim().min(1).nullable(),
    leadAgentId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    routePrefixes: z.array(routePrefixSchema).max(50),
    collections: z.array(collectionKeySchema).max(30),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();
export type UpdateWebsiteModule = z.infer<typeof updateWebsiteModuleSchema>;

/** True when `path` is `prefix` or below it. `/` holds every path. */
export function routePrefixMatches(prefix: string, path: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The module a page belongs to: the longest matching prefix wins, so
 * `/account/orders` (Shop) beats `/account` (Client portal). Off modules
 * still own their routes. Ties go to the earlier module in `modules`.
 */
export function websiteModuleForPath<T extends Pick<WebsiteModule, "routePrefixes">>(path: string, modules: readonly T[]): T | null {
  let best: T | null = null;
  let bestLength = -1;
  for (const module of modules) {
    for (const prefix of module.routePrefixes) {
      if (routePrefixMatches(prefix, path) && prefix.length > bestLength) {
        best = module;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

export interface WebsiteStartingModule {
  key: string;
  name: string;
  purpose: string;
  icon: WebsiteModuleIcon;
  routePrefixes: string[];
  collections: string[];
  /** Who John named as the natural owner. A hint in Settings; never set on its own. */
  suggestedOwner?: string;
}

/**
 * Greatstone's six starting modules. Route prefixes come from the accepted
 * sitemap (GRE-2081 plan revision 10, 23 Oct 2026), not from guesses: the
 * shop lives under `/dev-tools`, and `/org` became `/account/organisation`.
 */
export const GREATSTONE_STARTING_MODULES: readonly WebsiteStartingModule[] = [
  {
    key: "public-site",
    name: "Public site",
    purpose: "The home page and the content pages a visitor reads: consultancy, proof, insights, about, support and legal.",
    icon: "globe",
    routePrefixes: ["/", "/consultancy", "/proof", "/insights", "/about", "/support", "/search", "/privacy", "/cookies", "/terms", "/refunds"],
    collections: ["public-person", "redirect"],
  },
  {
    key: "shop",
    name: "Shop and licences",
    purpose: "Developer tools: brands, products, trials, basket and checkout, and a customer's orders, quotes and licences.",
    icon: "shopping-bag",
    routePrefixes: ["/dev-tools", "/account/orders", "/account/quotes", "/account/licences"],
    collections: ["product", "category", "vendor"],
  },
  {
    key: "client-portal",
    name: "Client portal",
    purpose: "Client sign-in, My account and the organisation hub, and each client's private portal.",
    icon: "key-round",
    routePrefixes: ["/account", "/portal"],
    collections: [],
  },
  {
    key: "deep-dive",
    name: "Deep Dive portal",
    purpose: "The paid Deep Dive: its public page, and the client's discovery, progress and blueprint in the portal.",
    icon: "telescope",
    routePrefixes: ["/consultancy/deep-dive", "/portal/:client/deep-dive", "/portal/:client/discovery", "/portal/:client/blueprint"],
    collections: [],
    suggestedOwner: "Ben",
  },
  {
    key: "front-door",
    name: "Front door and enquiries",
    purpose: "How a visitor starts a conversation: Begin the Conversation, Executive Discovery and the newsletter.",
    icon: "door-open",
    routePrefixes: ["/contact", "/consultancy/executive-discovery", "/newsletter"],
    collections: ["form"],
  },
  {
    key: "intelligence-hub",
    name: "Intelligence hub",
    purpose: "AI Market Intelligence: the briefings and market signals Greatstone offers leaders.",
    icon: "radar",
    routePrefixes: ["/consultancy/ai-market-intelligence"],
    collections: [],
  },
];

export interface WebsiteModuleAdminScreen {
  name: string;
  /** The phase task that moves this screen into GSAM. */
  issue: string;
}

/** The admin screens each starting module gets in later phases (GRE-2321). Placeholders until those tasks land. */
export const WEBSITE_MODULE_ADMIN_SCREENS: Record<string, WebsiteModuleAdminScreen[]> = {
  "public-site": [
    { name: "Pages and editor", issue: "GRE-2321" },
    { name: "Team and redirects", issue: "GRE-2321" },
  ],
  shop: [
    { name: "Catalogue", issue: "GRE-2326" },
    { name: "Vendors and pricing rules", issue: "GRE-2326" },
    { name: "Orders, quotes and invoices", issue: "GRE-2326" },
    { name: "Licences", issue: "GRE-2326" },
  ],
  "client-portal": [
    { name: "Accounts and organisations", issue: "GRE-2323" },
    { name: "Portal documents and acceptances", issue: "GRE-2327" },
  ],
  "deep-dive": [
    { name: "Deep Dive workspace", issue: "GRE-2327" },
    { name: "Portal publishing", issue: "GRE-2327" },
  ],
  "front-door": [
    { name: "Enquiries", issue: "GRE-2324" },
    { name: "Forms", issue: "GRE-2324" },
  ],
  "intelligence-hub": [{ name: "Briefings", issue: "GRE-2321" }],
};
