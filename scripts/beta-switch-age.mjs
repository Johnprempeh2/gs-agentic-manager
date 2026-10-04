// Report for scripts/beta-switch-age.sh: how long each beta (experimental)
// switch has been in its current state, from the
// `instance.settings.experimental_updated` activity rows.
//
//   node scripts/beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>] [--tests]
//
// Reads the two files the shell script fetched and prints a table. Retired
// switches come from RETIRED_INSTANCE_FEATURE_KEYS in the shared feature
// catalog. `--tests` also reads the repo's tracked test files (read-only).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RULE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One row per switch in `settings`.
 * `activity` is the activity list as the API returns it (any order).
 * `truncated` means the API hit its row limit, so older changes may be missing.
 */
export function switchAges(settings, activity, { now = Date.now(), truncated = false, retired = [] } = {}) {
  const events = activity
    .filter((row) => row?.action === "instance.settings.experimental_updated")
    .map((row) => ({
      at: new Date(row.createdAt).getTime(),
      changedKeys: Array.isArray(row.details?.changedKeys) ? row.details.changedKeys : [],
      state: row.details?.experimental ?? {},
    }))
    .filter((event) => Number.isFinite(event.at))
    .sort((a, b) => a.at - b.at);

  return Object.keys(settings)
    .filter((key) => key !== "managedKeys")
    .sort()
    .map((key) => {
      const value = settings[key];
      const state = typeof value === "boolean" ? (value ? "on" : "off") : JSON.stringify(value);
      const changes = events.filter((event) => event.changedKeys.includes(key));
      const row = { key, state, onSince: "unknown", days: null, ruleMet: "unknown" };
      // A retired switch always reads off and cannot graduate.
      if (retired.includes(key)) return { ...row, state: "retired", onSince: "-", ruleMet: "n/a" };
      if (typeof value !== "boolean") return { ...row, ruleMet: "n/a" };
      // The last logged value must match the current one; if not, the change
      // happened without a log row and we do not guess.
      if (changes.length === 0 || changes.at(-1).state[key] !== value) return row;
      // Start of the trailing run of changes that left the switch in its
      // current state (re-saving the same value does not reset the clock).
      let start = changes.length - 1;
      while (start > 0 && changes[start - 1].state[key] === value) start -= 1;
      const since = changes[start].at;
      const days = Math.floor((now - since) / DAY_MS);
      // With a cut-off history the run may have started before the oldest row.
      const openStart = truncated && start === 0;
      const onSince = openStart ? `before ${isoDay(since)}` : isoDay(since);
      if (!value) return { ...row, onSince: "-", days: null, ruleMet: "no" };
      const met = days >= RULE_DAYS;
      return {
        ...row,
        onSince,
        days: openStart ? `${days}+` : days,
        ruleMet: met ? "yes" : openStart ? "unknown" : "no",
      };
    });
}

/** Keys listed in `export const RETIRED_INSTANCE_FEATURE_KEYS = [...]` of the catalog source. */
export function parseRetiredKeys(catalogSource) {
  const match = catalogSource.match(/RETIRED_INSTANCE_FEATURE_KEYS\s*=\s*\[([^\]]*)\]/);
  if (!match) throw new Error("RETIRED_INSTANCE_FEATURE_KEYS not found in the feature catalog");
  return [...match[1].matchAll(/["'](\w+)["']/g)].map((m) => m[1]);
}

export const isTestFile = (path) => /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * For each key, the number of test files that name it (as a whole word).
 * A file that names every key is a list of all switches (the settings page
 * and service tests), not a test of any one switch, so it is not counted.
 * `files` is `[{ path, text }]`.
 */
export function testFileCounts(keys, files) {
  const patterns = keys.map((key) => [key, new RegExp(`\\b${key}\\b`)]);
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  const listFiles = [];
  for (const { path, text } of files) {
    const named = patterns.filter(([, re]) => re.test(text)).map(([key]) => key);
    if (keys.length > 1 && named.length === keys.length) {
      listFiles.push(path);
      continue;
    }
    for (const key of named) counts[key] += 1;
  }
  return { counts, listFiles };
}

function readTestFiles(repoRoot) {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(isTestFile);
  const files = [];
  for (const path of paths) {
    try {
      files.push({ path, text: readFileSync(`${repoRoot}/${path}`, "utf8") });
    } catch {
      // Deleted in the working tree but still tracked: skip.
    }
  }
  return files;
}

export function formatTable(rows) {
  const withTests = rows.some((r) => r.testFiles !== undefined);
  const header = ["switch", "state", "on since", "days on", "2-week rule met", ...(withTests ? ["test files"] : [])];
  const body = rows.map((r) => [
    r.key,
    r.state,
    r.onSince,
    r.days === null ? "-" : String(r.days),
    r.ruleMet,
    ...(withTests ? [String(r.testFiles ?? "-")] : []),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

function main(argv) {
  const [settingsPath, activityPath, ...rest] = argv;
  if (!settingsPath || !activityPath) {
    console.error("usage: beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>] [--tests]");
    process.exit(2);
  }
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const truncated = activity.length >= limit;
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const retired = parseRetiredKeys(readFileSync(`${repoRoot}/packages/shared/src/feature-catalog.ts`, "utf8"));
  let rows = switchAges(settings, activity, { truncated, retired });
  let listFiles = [];
  if (rest.includes("--tests")) {
    const tests = testFileCounts(rows.map((r) => r.key), readTestFiles(repoRoot));
    rows = rows.map((r) => ({ ...r, testFiles: tests.counts[r.key] }));
    listFiles = tests.listFiles;
  }
  console.log(formatTable(rows));
  if (listFiles.length > 0) {
    console.log(`\nnot counted (name every switch): ${listFiles.join(", ")}`);
  }
  if (truncated) {
    console.log(`\nnote: the activity log returned its ${limit}-row limit; older changes are not shown.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
