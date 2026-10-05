// Report for scripts/beta-switch-age.sh: how long each beta (experimental)
// switch has been in its current state, from the
// `instance.settings.experimental_updated` activity rows.
//
//   node scripts/beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>] [--tests] [--scorecard <file>] [--failed-runs <runs.json>]
//   node scripts/beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>] --earliest-on-since
//
// Reads the two files the shell script fetched and prints a table. Retired
// switches come from RETIRED_INSTANCE_FEATURE_KEYS in the shared feature
// catalog. `--tests` also reads the repo's tracked test files (read-only).
// `--scorecard` reads a saved copy of the beta scorecard (GRE-81) and lists
// catalog switches with no row and rows whose key left the catalog.
// `--failed-runs <runs.json>` lists the failed, interrupted and cancelled runs
// since each on switch's "on since" time, grouped by error code (GRE-794).
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
      const row = { key, state, onSince: "unknown", days: null, ruleMet: "unknown", sinceAt: null };
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
        // Exact time of the change (for --failed-runs); with an open start it
        // is the oldest logged row, not the real start.
        sinceAt: new Date(since).toISOString(),
        openStart,
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

/** Top-level keys of `export const INSTANCE_FEATURE_CATALOG ... = { ... };` in the catalog source. */
export function parseCatalogKeys(catalogSource) {
  const match = catalogSource.match(/INSTANCE_FEATURE_CATALOG\b[^=]*=\s*\{\n([\s\S]*?)\n\};/);
  if (!match) throw new Error("INSTANCE_FEATURE_CATALOG not found in the feature catalog");
  return [...match[1].matchAll(/^  (\w+): \{/gm)].map((m) => m[1]);
}

/**
 * Keys named in the switch column of the scorecard table: rows that start
 * with a row number, e.g. `| 1 | Environments (`enableEnvironments`) | ...`.
 */
export function parseScorecardKeys(scorecardText) {
  const keys = [];
  for (const line of scorecardText.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || cells[0] !== "" || !/^\d+$/.test(cells[1])) continue;
    for (const m of cells[2].matchAll(/`(\w+)`/g)) keys.push(m[1]);
  }
  return keys;
}

/** Catalog keys with no scorecard row (`noRow`) and scorecard keys not in the catalog (`gone`). */
export function scorecardGaps(catalogKeys, scorecardKeys) {
  const rows = new Set(scorecardKeys);
  const catalog = new Set(catalogKeys);
  return {
    noRow: [...catalog].filter((key) => !rows.has(key)).sort(),
    gone: [...rows].filter((key) => !catalog.has(key)).sort(),
  };
}

export function formatScorecardGaps({ noRow, gone }) {
  const list = (keys) => (keys.length === 0 ? "none" : keys.join(", "));
  return `scorecard: no row: ${list(noRow)}\nscorecard: gone: ${list(gone)}`;
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

export const FAILED_RUN_STATUSES = ["failed", "interrupted", "cancelled"];

/** Earliest "on since" time of the switches that are on, or null. */
export function earliestOnSince(rows) {
  const times = rows.filter((r) => r.state === "on" && r.sinceAt).map((r) => r.sinceAt).sort();
  return times[0] ?? null;
}

/**
 * `fetched` is `{ runs, complete }`: the run list pages the shell script
 * read, and false `complete` when paging stopped before the API ran out of
 * rows. For each on switch: failed, interrupted and cancelled runs created at
 * or after its "on since" time, grouped by error code. It does not decide
 * which runs are linked to the switch; Beacon does that on the scorecard.
 * `cutAt` is set when the history read does not reach "on since".
 */
export function failedRunsBySwitch(rows, { runs, complete }) {
  const wanted = runs.filter((run) => FAILED_RUN_STATUSES.includes(run?.status));
  const oldest = runs.map((run) => run.createdAt).filter(Boolean).sort()[0] ?? null;
  return rows
    .filter((r) => r.state === "on")
    .map((r) => {
      if (!r.sinceAt) return { key: r.key, onSince: r.onSince, unknown: true, groups: [], count: 0, cutAt: null };
      const since = Date.parse(r.sinceAt);
      const matched = wanted.filter((run) => Date.parse(run.createdAt) >= since);
      const byCode = new Map();
      for (const run of matched) {
        const code = run.errorCode || "(no code)";
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(run.id);
      }
      const groups = [...byCode]
        .map(([code, ids]) => ({ code, ids }))
        .sort((a, b) => b.ids.length - a.ids.length || a.code.localeCompare(b.code));
      let cutAt = null;
      // An open start began before the oldest activity row, so runs before it are not read.
      if (r.openStart) cutAt = r.sinceAt;
      else if (!complete && (oldest === null || Date.parse(oldest) > since)) cutAt = oldest ?? "now";
      return { key: r.key, onSince: r.onSince, unknown: false, groups, count: matched.length, cutAt };
    });
}

export function formatFailedRuns(items) {
  const lines = [`failed runs since on (${FAILED_RUN_STATUSES.join(", ")}), by error code:`];
  for (const item of items) {
    if (item.unknown) {
      lines.push(`${item.key} (on since unknown): not checked`);
      continue;
    }
    const cut = item.cutAt ? `; history cut at ${item.cutAt}` : "";
    lines.push(`${item.key} (on since ${item.onSince}): ${item.count === 0 ? "none" : `${item.count} runs`}${cut}`);
    for (const { code, ids } of item.groups) lines.push(`  ${code} (${ids.length}): ${ids.join(", ")}`);
  }
  return lines.join("\n");
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
    console.error("usage: beta-switch-age.mjs <settings.json> <activity.json> [--limit <n>] [--tests] [--scorecard <file>] [--failed-runs <runs.json>] [--earliest-on-since]");
    process.exit(2);
  }
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const activity = JSON.parse(readFileSync(activityPath, "utf8"));
  const truncated = activity.length >= limit;
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const catalogSource = readFileSync(`${repoRoot}/packages/shared/src/feature-catalog.ts`, "utf8");
  const retired = parseRetiredKeys(catalogSource);
  let rows = switchAges(settings, activity, { truncated, retired });
  if (rest.includes("--earliest-on-since")) {
    // Used by the shell script to pick the `since` of the run list fetch.
    process.stdout.write(earliestOnSince(rows) ?? "");
    return;
  }
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
  const scorecardIndex = rest.indexOf("--scorecard");
  if (scorecardIndex >= 0) {
    const scorecardKeys = parseScorecardKeys(readFileSync(rest[scorecardIndex + 1], "utf8"));
    console.log(`\n${formatScorecardGaps(scorecardGaps(parseCatalogKeys(catalogSource), scorecardKeys))}`);
  }
  const failedRunsIndex = rest.indexOf("--failed-runs");
  if (failedRunsIndex >= 0) {
    const fetched = JSON.parse(readFileSync(rest[failedRunsIndex + 1], "utf8"));
    console.log(`\n${formatFailedRuns(failedRunsBySwitch(rows, fetched))}`);
  }
  if (truncated) {
    console.log(`\nnote: the activity log returned its ${limit}-row limit; older changes are not shown.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
