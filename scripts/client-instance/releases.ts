// Release tags and release folders for client instances (GRE-130).
// Clients follow the latest `stable-*` tag (GRE-124 "Trimmed build", GRE-127).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

// ---------------------------------------------------------------- which release folders are in use (GRE-833)

const STATE_FILE = "client-instance.json";

export type ReleaseMark = "runs" | "restore needs it";

export interface ReleaseUse {
  /** Folder name of the instance, beside the others in the instances folder. */
  instance: string;
  mark: ReleaseMark;
}

export interface ReleaseFolder {
  dir: string;
  /** Size in KiB from `du -sk`, or null when it cannot be read (or the folder is gone). */
  sizeKb: number | null;
  exists: boolean;
  /** Empty means `not used`: no instance runs from it and no restore needs it. */
  uses: ReleaseUse[];
}

const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : path.resolve(dir));

function sizeKb(dir: string): number | null {
  const du = spawnSync("du", ["-sk", dir], { encoding: "utf8" });
  const kb = du.status === 0 ? Number.parseInt(du.stdout, 10) : Number.NaN;
  return Number.isFinite(kb) ? kb : null;
}

/**
 * Each folder in `releasesDir`, and each folder an instance names outside it,
 * with the instances that use it: `runs` (release.dir) or `restore needs it`
 * (lastUpgrade.from.dir). Reads only; it writes and deletes nothing.
 */
export function releaseFolders(instancesDir: string, releasesDir: string, size: (dir: string) => number | null = sizeKb): ReleaseFolder[] {
  const folders = new Map<string, ReleaseFolder>();
  const folder = (dir: string) => {
    const key = real(dir);
    let found = folders.get(key);
    if (!found) {
      found = { dir: key, sizeKb: null, exists: existsSync(key), uses: [] };
      folders.set(key, found);
    }
    return found;
  };
  if (existsSync(releasesDir)) {
    for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) folder(path.join(releasesDir, entry.name));
    }
  }
  if (existsSync(instancesDir)) {
    for (const entry of readdirSync(instancesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(instancesDir, entry.name, STATE_FILE);
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const state = JSON.parse(readFileSync(file, "utf8")) as { release?: { dir?: unknown }; lastUpgrade?: { from?: { dir?: unknown } } };
      const uses: [unknown, ReleaseMark][] = [[state.release?.dir, "runs"], [state.lastUpgrade?.from?.dir, "restore needs it"]];
      for (const [dir, mark] of uses) {
        if (typeof dir === "string" && dir) folder(dir).uses.push({ instance: entry.name, mark });
      }
    }
  }
  const list = [...folders.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const f of list) f.sizeKb = f.exists ? size(f.dir) : null;
  return list;
}

function formatSize(kb: number | null): string {
  if (kb === null) return "size ?";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} KB`;
}

/** One line per folder: `<dir>  <size>  runs: a; restore needs it: b`, or `not used`. */
export function releaseFolderLines(folders: ReleaseFolder[]): string[] {
  return folders.map((f) => {
    const marks = (["runs", "restore needs it"] as const)
      .map((mark) => [mark, f.uses.filter((u) => u.mark === mark).map((u) => u.instance)] as const)
      .filter(([, names]) => names.length > 0)
      .map(([mark, names]) => `${mark}: ${names.join(", ")}`);
    const use = marks.length ? marks.join("; ") : "not used";
    return `${f.dir}  ${f.exists ? formatSize(f.sizeKb) : "GONE"}  ${use}`;
  });
}
