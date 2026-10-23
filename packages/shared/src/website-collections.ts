// Snapshot of greatstone-website#bb35ff3, next-proof/release-schema.
// Update both JSON files together when the engine changes fieldsVersion.
import manifest from "./website-collections-manifest-v1.json" with { type: "json" };
import schema from "./website-collections-v1.json" with { type: "json" };

export const websiteCollectionManifest = manifest;
export const websiteCollectionFieldSchema = schema;
export type WebsiteCollectionKey = keyof typeof manifest.collections;

export function websiteCollectionDefinition(key: string) {
  const collection = manifest.collections[key as WebsiteCollectionKey];
  if (!collection) return null;
  const definition = schema.$defs[collection.releaseKey as keyof typeof schema.$defs];
  return { ...collection, definition };
}
