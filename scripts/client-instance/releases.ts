// Release tags and release folders for client instances (GRE-130).
// Clients follow the latest `stable-*` tag (GRE-124 "Trimmed build", GRE-127).

import path from "node:path";

/** `stable-YYYY-MM-DD.N`, as made by "Promote to Stable" (GRE-127). */
const STABLE_TAG = /^stable-(\d{4})-(\d{2})-(\d{2})\.([1-9]\d*)$/;

export function isStableTag(tag: string): boolean {
  const match = STABLE_TAG.exec(tag);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(`${year}-${month}-${day}`);
}

/** Each tag gets its own clone: `<releases>/<tag>`. The tag is checked first, so it cannot leave the folder. */
export function releaseDirFor(releasesDir: string, tag: string): string {
  if (!isStableTag(tag)) throw new Error(`"${tag}" is not a stable-* tag`);
  return path.join(releasesDir, tag);
}

/** Default releases folder: next to the instance folders (doc/CLIENT-INSTANCES.md, "Where the code runs"). */
export function defaultReleasesDir(root: string): string {
  return path.join(path.dirname(root), "releases");
}

/** The one tag to name a release folder by: a stable tag first, then a live tag, then any tag. */
export function pickReleaseTag(tags: string[]): string | null {
  const clean = tags.map((t) => t.trim()).filter(Boolean).sort();
  return (
    clean.filter(isStableTag).at(-1) ??
    clean.filter((t) => t.startsWith("live-")).at(-1) ??
    clean.at(-1) ??
    null
  );
}
