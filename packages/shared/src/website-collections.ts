// Snapshot of greatstone-website#bb35ff3, next-proof/release-schema.
// Update both JSON files together when the engine changes fieldsVersion.
import manifest from "./website-collections-manifest-v1.json" with { type: "json" };
import schema from "./website-collections-v1.json" with { type: "json" };
import type { WebsiteEntrySummary } from "./types/website-module.js";

export const websiteCollectionManifest = manifest;
export const websiteCollectionFieldSchema = schema;
export type WebsiteCollectionKey = keyof typeof manifest.collections;

export function websiteCollectionDefinition(key: string) {
  const collection = manifest.collections[key as WebsiteCollectionKey];
  if (!collection) return null;
  const definition = schema.$defs[collection.releaseKey as keyof typeof schema.$defs];
  return { ...collection, definition };
}

const DESCRIPTION_CUT = 300;

/**
 * What an entry is, from its own content: a catalogue entry keeps its fields under `data`, the rest at the top.
 * Null when the content holds no name, so a list falls back to the entry key. Nothing is made up.
 */
export function websiteEntrySummary(content: unknown): WebsiteEntrySummary | null {
  const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const top = record(content);
  const data = Object.keys(record(top.data)).length ? record(top.data) : top;
  const name = text(data.name) ?? text(data.title);
  if (!name) return null;
  const description = text(data.description);
  return {
    name,
    slug: text(data.slug),
    short_description: text(data.short_description) ?? text(data.role) ?? text(data.intro),
    description: description && description.length > DESCRIPTION_CUT ? description.slice(0, DESCRIPTION_CUT) : description,
    from_price_minor: typeof data.from_price_minor === "number" ? data.from_price_minor : null,
    from_price_currency: text(data.from_price_currency),
    vendor: text(record(data.vendor).name),
    category: text(record(data.category).name),
    variants: (Array.isArray(data.variants) ? data.variants : []).map((variant) => ({ sku: text(record(variant).sku), name: text(record(variant).name) })),
  };
}
