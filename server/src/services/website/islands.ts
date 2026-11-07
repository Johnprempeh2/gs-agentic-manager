import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { websiteSite } from "@greatstone/db";
import { websitePreviewAddresses } from "@greatstone/shared";
import { logger } from "../../middleware/logger.js";
import fallbackManifest from "./islands-fallback.json" with { type: "json" };

/**
 * Website islands in live design (GRE-3786). Schema 2 website pages are HTML
 * with `<gs-island name="...">` tags; the real islands (forms, quote, account
 * entry, products, 3D stone, animation) run only on the site. The site's
 * `GET /_islands` gives the island list and `placeholderCss`, which turns each
 * tag into a labelled box the size of the real island. GSAM reads it from the
 * site, cached, and keeps a vendored copy for when the site cannot be reached
 * (`islands-fallback.json`, from greatstone-website `next-proof/islands.mjs`
 * `islandManifest()` at 3318717).
 *
 * The answer is untrusted: its CSS only ever goes into a `<style>` element as
 * text, with `<` escaped, and the island list only reaches agents as text.
 */

export const ISLAND_CONTRACT = 1;

const FETCH_TIMEOUT_MS = 5_000;
const LIMIT_BYTES = 256_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MISS_TTL_MS = 60_000;

const islandSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  label: z.string().max(80),
  placeholder: z.string().max(300),
  height: z.number().int().min(0).max(4000),
  inline: z.boolean(),
  attributes: z.record(
    z.string().regex(/^data-[a-z0-9-]{1,64}$/),
    z.union([z.object({ values: z.array(z.string().max(80)).max(50) }), z.object({ pattern: z.string().max(300) })]),
  ),
});

const manifestSchema = z.object({
  islandContract: z.number(),
  islands: z.array(islandSchema).max(100),
  placeholderCss: z.string().max(LIMIT_BYTES),
});

export type WebsiteIsland = z.infer<typeof islandSchema>;
export type IslandManifest = z.infer<typeof manifestSchema> & { source: "site" | "fallback" };

export const FALLBACK_ISLANDS: IslandManifest = { ...manifestSchema.parse(fallbackManifest), source: "fallback" };

/** True when the page places at least one island. */
export function hasIslands(html: string) {
  return /<gs-island\b/i.test(html);
}

/**
 * The placeholder CSS as a `<style>` element. `<` never appears inside it (CSS
 * reads `\3c ` the same in strings), so no `</style>` or comment in the payload
 * can end the element and start HTML.
 */
export function islandPlaceholderStyle(css: string) {
  const safe = css.replace(/\0/g, "").replace(/</g, "\\3c ");
  return `<style data-gs-islands>${safe}</style>`;
}

/**
 * The page with the placeholder CSS after the site stylesheet: straight after
 * the last stylesheet (a `<style>` or `<link rel=stylesheet>`), so it wins over
 * the site's rules for the same tag; failing that, at the end of `<head>`.
 */
export function withIslandPlaceholders(html: string, css: string) {
  if (!css.trim() || !hasIslands(html)) return html;
  const style = islandPlaceholderStyle(css);
  let at = -1;
  for (const m of html.matchAll(/<\/style\s*>|<link\b[^>]*\brel\s*=\s*["']?[^"'>]*stylesheet[^>]*>/gi)) {
    at = (m.index ?? 0) + m[0].length;
  }
  if (at < 0) {
    const head = /<\/head\s*>/i.exec(html);
    if (head) at = head.index;
  }
  if (at < 0) {
    const body = /<body\b[^>]*>/i.exec(html);
    if (body) at = body.index + body[0].length;
  }
  if (at < 0) return style + html;
  return html.slice(0, at) + style + html.slice(at);
}

/** The island list as agent instructions: the only names and data attributes a website page may use. */
export function islandsForAgents(manifest: Pick<IslandManifest, "islands">) {
  const lines = manifest.islands.map((island) => {
    const attrs = Object.entries(island.attributes).map(([attr, rule]) =>
      "values" in rule ? `${attr} (one of: ${rule.values.join(", ")})` : `${attr} (matching /${rule.pattern}/)`,
    );
    return `- ${island.name}: ${island.label}.${attrs.length ? ` Attributes: ${attrs.join("; ")}.` : " No attributes."}`;
  });
  return [
    'This is a website page. Its working parts are islands, placed with <gs-island name="..." data-...></gs-island>; live design shows each as a labelled placeholder because the real one runs only on the site.',
    "Keep every island tag unless John asks to remove it. Use only these island names and data attributes; the site drops anything else:",
    ...lines,
    "When John asks to change what an island looks like or does (a logo grid into a carousel), you own it: make the change in the website repo yourself on a branch with a pull request and a preview, and track it on a task assigned to you. Never hand it to another agent. Answer his pick straight away with an error reply saying you are doing it as a code change, so the page frees up for his next pick.",
  ].join("\n");
}

/** Read and check a `/_islands` answer. Null when it is not a valid contract 1 answer. */
export function parseIslandManifest(body: unknown): IslandManifest | null {
  const parsed = manifestSchema.safeParse(body);
  if (!parsed.success) return null;
  if (parsed.data.islandContract !== ISLAND_CONTRACT) return null;
  return { ...parsed.data, source: "site" };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const cache = new Map<string, { at: number; value: IslandManifest }>();

/** Test seam. */
export function resetIslandCache() {
  cache.clear();
}

/**
 * The site's island manifest, cached half an hour per address. Any failure, a
 * wrong contract number or a bad answer gives the vendored copy (and a warning).
 */
export async function loadIslandManifest(siteUrl: string | null, fetchImpl: FetchLike = fetch): Promise<IslandManifest> {
  if (!siteUrl) return FALLBACK_ISLANDS;
  let url: string;
  try {
    const base = new URL(siteUrl);
    if (!/^https?:$/.test(base.protocol)) return FALLBACK_ISLANDS;
    url = new URL("/_islands", base).toString();
  } catch {
    return FALLBACK_ISLANDS;
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.value.source === "site" ? CACHE_TTL_MS : CACHE_MISS_TTL_MS)) return hit.value;
  let value = FALLBACK_ISLANDS;
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "GSAM-Live-Design/1" },
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const text = await res.text();
    if (text.length > LIMIT_BYTES) throw new Error("answer too large");
    const body = JSON.parse(text) as { islandContract?: unknown };
    const manifest = parseIslandManifest(body);
    if (manifest) value = manifest;
    else if (body && typeof body === "object" && body.islandContract !== ISLAND_CONTRACT) {
      logger.warn({ url, islandContract: body.islandContract }, `Website islands: contract ${String(body.islandContract)} is not ${ISLAND_CONTRACT}; using the vendored copy. Update GSAM's island support.`);
    } else {
      logger.warn({ url }, "Website islands: the site's /_islands answer is not valid; using the vendored copy.");
    }
  } catch (error) {
    logger.warn({ url, err: error instanceof Error ? error.message : String(error) }, "Website islands: could not read the site's /_islands; using the vendored copy.");
  }
  cache.set(url, { at: Date.now(), value });
  return value;
}

/** The island manifest for a company: its first website that is not archived, or the vendored copy when it has none. */
export async function loadCompanyIslandManifest(db: Db, companyId: string, fetchImpl?: FetchLike) {
  const [site] = await db
    .select()
    .from(websiteSite)
    .where(and(eq(websiteSite.companyId, companyId), isNull(websiteSite.archivedAt)))
    .orderBy(asc(websiteSite.createdAt))
    .limit(1);
  return loadIslandManifest(site ? websitePreviewAddresses(site).live : null, fetchImpl);
}
