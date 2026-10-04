#!/usr/bin/env node
/**
 * check-locale-format.mjs
 *
 * Ratchet check for ad-hoc `toLocaleString(` / `toLocaleDateString(` /
 * `toLocaleTimeString(` calls in `ui/src`. Each one picks its own locale and
 * options, so dates and numbers look different from page to page. New code
 * should call the shared helpers in `ui/src/lib/utils.ts` instead
 * (`formatDate`, `formatDateTime`, `formatShortDate`, `relativeTime`,
 * `formatNumber`, `formatCents`). That file is where the helpers live, so it
 * is not counted.
 *
 * The check does not demand zero. It compares each file's count with the
 * saved baseline in `scripts/check-locale-format.baseline.json`:
 *
 *   - count went UP   → fail, naming the file and the helper to use.
 *   - count is SAME   → pass.
 *   - count went DOWN → pass; run `--update` to lower the saved count so the
 *                       file cannot creep back up.
 *
 * A file that is not in the baseline has a saved count of 0.
 * Test files (`*.test.*`) are not counted.
 *
 * Usage:
 *   node scripts/check-locale-format.mjs           # check (exit 1 on growth)
 *   node scripts/check-locale-format.mjs --update  # lower saved counts only
 *   node scripts/check-locale-format.mjs --init    # write the first baseline (refuses if one exists)
 *
 * `--update` never raises a saved count. Raising one means editing the
 * baseline by hand, which a reviewer sees in the diff.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
export const DEFAULT_SCAN_ROOT = resolve(REPO_ROOT, "ui/src");
export const DEFAULT_BASELINE_PATH = resolve(__dirname, "check-locale-format.baseline.json");

/** Repo-relative paths that hold the shared helpers; never counted. */
export const EXEMPT_FILES = new Set(["ui/src/lib/utils.ts"]);

export const LOCALE_CALL_RE = /\btoLocale(?:Date|Time)?String\s*\(/g;

export const HELPER_HINT =
  "Use a helper from ui/src/lib/utils.ts instead: formatDate, formatDateTime, formatShortDate or " +
  "relativeTime for dates; formatNumber or formatCents for numbers. If none fits, add one there.";

/** Number of ad-hoc locale-format calls in one file's source. */
export function countLocaleCalls(content) {
  return [...content.matchAll(LOCALE_CALL_RE)].length;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p);
  }
}

/** Current per-file counts. Keys are repo-relative POSIX paths. */
export function scan(scanRoot = DEFAULT_SCAN_ROOT, repoRoot = REPO_ROOT) {
  const files = [];
  walk(scanRoot, files);
  files.sort();
  const result = {};
  for (const file of files) {
    const key = relative(repoRoot, file).split("\\").join("/");
    if (EXEMPT_FILES.has(key)) continue;
    const n = countLocaleCalls(readFileSync(file, "utf8"));
    if (n > 0) result[key] = n;
  }
  return result;
}

/**
 * Compare current counts with the baseline.
 * Returns { increased: [{ file, before, after }], decreased: [{ file, before, after }] }.
 */
export function compare(baseline, current) {
  const increased = [];
  const decreased = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const before = baseline[file] ?? 0;
    const after = current[file] ?? 0;
    if (after > before) increased.push({ file, before, after });
    else if (after < before) decreased.push({ file, before, after });
  }
  return { increased, decreased };
}

/**
 * Lower-only baseline update: files whose count went down (or that are gone)
 * take their current count; files whose count went up keep the saved count.
 */
export function lowerBaseline(baseline, current) {
  const next = {};
  for (const [file, saved] of Object.entries(baseline)) {
    const now = current[file] ?? 0;
    if (now === 0) continue;
    next[file] = Math.min(now, saved);
  }
  return sortKeys(next);
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function readBaseline(path = DEFAULT_BASELINE_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeBaseline(baseline, path = DEFAULT_BASELINE_PATH) {
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
}

export function run({
  argv = process.argv.slice(2),
  scanRoot = DEFAULT_SCAN_ROOT,
  repoRoot = REPO_ROOT,
  baselinePath = DEFAULT_BASELINE_PATH,
  log = console.log,
} = {}) {
  const baseline = readBaseline(baselinePath);
  const current = scan(scanRoot, repoRoot);
  const { increased, decreased } = compare(baseline, current);

  if (argv.includes("--init")) {
    if (existsSync(baselinePath)) {
      log("check-locale-format: baseline already exists; use --update to lower it.");
      return 1;
    }
    writeBaseline(current, baselinePath);
    log(`check-locale-format: wrote baseline for ${Object.keys(current).length} file(s).`);
    return 0;
  }

  if (argv.includes("--update")) {
    writeBaseline(lowerBaseline(baseline, current), baselinePath);
    log(`check-locale-format: lowered ${decreased.length} file(s) in the baseline.`);
    if (increased.length > 0) {
      log(`  ${increased.length} file(s) went up and were NOT raised; the check still fails for them.`);
    }
    return 0;
  }

  log("check-locale-format summary");
  const now = Object.values(current).reduce((sum, n) => sum + n, 0);
  log(`  Ad-hoc toLocale*String calls now: ${now}`);
  log(`  Files with more than saved:       ${increased.length}`);
  log(`  Files with fewer than saved:      ${decreased.length}`);

  if (decreased.length > 0) {
    log("\nFewer ad-hoc toLocale*String calls (good). Lower the saved counts with:");
    log("  node scripts/check-locale-format.mjs --update");
    for (const d of decreased) log(`  ${d.file}: ${d.before} → ${d.after}`);
  }

  if (increased.length > 0) {
    log("\nMore ad-hoc toLocale*String calls than the saved count.");
    log(`${HELPER_HINT}\n`);
    for (const inc of increased) log(`  ${inc.file}: ${inc.before} → ${inc.after}`);
    return 1;
  }

  log("\nNo file has more ad-hoc toLocale*String calls than its saved count.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
