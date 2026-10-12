#!/usr/bin/env node
/**
 * check-named-colors.mjs
 *
 * Ratchet check for named Tailwind palette colour classes (`bg-amber-100`,
 * `text-red-600`, `dark:border-zinc-800/50`, ...) in `ui/src`. These name a
 * literal colour, not a semantic role, so new code should use the tokens in
 * `ui/src/index.css` instead (DESIGN.md rule 2).
 *
 * There are thousands of these today, so the check does not demand zero.
 * It compares each file's count with the saved baseline in
 * `scripts/check-named-colors.baseline.json`:
 *
 *   - count went UP   → fail, naming the file and the classes that grew.
 *   - count is SAME   → pass.
 *   - count went DOWN → pass; run `--update` to lower the saved count so the
 *                       file cannot creep back up.
 *
 * A file that is not in the baseline has a saved count of 0.
 * Test files (`*.test.*`) are not counted.
 *
 * Usage:
 *   node scripts/check-named-colors.mjs           # check (exit 1 on growth)
 *   node scripts/check-named-colors.mjs --update  # lower saved counts only
 *   node scripts/check-named-colors.mjs --init    # write the first baseline (refuses if one exists)
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
export const DEFAULT_BASELINE_PATH = resolve(__dirname, "check-named-colors.baseline.json");

const PALETTE = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime",
  "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
].join("|");

const UTILITY = [
  "bg", "text", "border(?:-[xytrblse])?", "ring", "ring-offset", "outline", "divide", "fill",
  "stroke", "from", "via", "to", "decoration", "accent", "caret", "placeholder", "shadow",
].join("|");

// Not glued to a longer identifier on either side; variant prefixes such as
// `dark:` or `hover:` end in `:`, so the utility after them still matches.
export const NAMED_COLOR_RE = new RegExp(
  `(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})-(?:50|[1-9]00|950)(?:/\\d+)?(?![\\w-])`,
  "g",
);

/** Map of class → count for one file's source. */
export function countNamedColors(content) {
  const counts = {};
  for (const [cls] of content.matchAll(NAMED_COLOR_RE)) {
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
}

function total(classCounts) {
  return Object.values(classCounts ?? {}).reduce((sum, n) => sum + n, 0);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p);
  }
}

/** Current per-file, per-class counts. Keys are repo-relative POSIX paths. */
export function scan(scanRoot = DEFAULT_SCAN_ROOT, repoRoot = REPO_ROOT) {
  const files = [];
  walk(scanRoot, files);
  files.sort();
  const result = {};
  for (const file of files) {
    const counts = countNamedColors(readFileSync(file, "utf8"));
    if (total(counts) === 0) continue;
    result[relative(repoRoot, file).split("\\").join("/")] = sortKeys(counts);
  }
  return result;
}

/**
 * Compare current counts with the baseline.
 * Returns { increased: [{ file, before, after, grown: [{ cls, before, after }] }],
 *           decreased: [{ file, before, after }] }.
 */
export function compare(baseline, current) {
  const increased = [];
  const decreased = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const before = total(baseline[file]);
    const after = total(current[file]);
    if (after > before) {
      const grown = [];
      for (const [cls, n] of Object.entries(current[file])) {
        const was = baseline[file]?.[cls] ?? 0;
        if (n > was) grown.push({ cls, before: was, after: n });
      }
      increased.push({ file, before, after, grown });
    } else if (after < before) {
      decreased.push({ file, before, after });
    }
  }
  return { increased, decreased };
}

/**
 * Lower-only baseline update: files whose total went down (or that are gone)
 * take their current counts; files whose total went up keep the saved counts.
 */
export function lowerBaseline(baseline, current) {
  const next = {};
  for (const [file, saved] of Object.entries(baseline)) {
    const now = current[file];
    if (!now) continue;
    next[file] = total(now) < total(saved) ? now : saved;
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
      log("check-named-colors: baseline already exists; use --update to lower it.");
      return 1;
    }
    writeBaseline(current, baselinePath);
    log(`check-named-colors: wrote baseline for ${Object.keys(current).length} file(s).`);
    return 0;
  }

  if (argv.includes("--update")) {
    writeBaseline(lowerBaseline(baseline, current), baselinePath);
    log(`check-named-colors: lowered ${decreased.length} file(s) in the baseline.`);
    if (increased.length > 0) {
      log(`  ${increased.length} file(s) went up and were NOT raised; the check still fails for them.`);
    }
    return 0;
  }

  log("check-named-colors summary");
  const now = Object.values(current).reduce((sum, c) => sum + total(c), 0);
  log(`  Named colour classes now:   ${now}`);
  log(`  Files with more than saved: ${increased.length}`);
  log(`  Files with fewer than saved: ${decreased.length}`);

  if (decreased.length > 0) {
    log("\nFewer named colour classes (good). Lower the saved counts with:");
    log("  node scripts/check-named-colors.mjs --update");
    for (const d of decreased) log(`  ${d.file}: ${d.before} → ${d.after}`);
  }

  if (increased.length > 0) {
    log("\nMore named colour classes than the saved count. Use a token from ui/src/index.css instead:\n");
    for (const inc of increased) {
      log(`  ${inc.file}: ${inc.before} → ${inc.after}`);
      for (const g of inc.grown) log(`    ${g.cls} (${g.before} → ${g.after})`);
    }
    return 1;
  }

  log("\nNo file has more named colour classes than its saved count.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
