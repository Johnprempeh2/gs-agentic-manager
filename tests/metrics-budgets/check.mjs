// Compares saved metric reports against budgets.json and exits nonzero when a
// budget is broken, an input is missing, or a sample is too small to judge.
//
//   node tests/metrics-budgets/check.mjs --group ci|weekly [--input id=path ...] [--budgets file]
//
// Each budget is baseline plus a written margin; see budgets.json and README.md.
// A passing value at WATCH_MAX_RATIO x baseline or more (WATCH_MIN_RATIO x or
// less for a `min` floor) is marked PASS (watch). The exit code does not change.
// The Measured column shows each report's `measuredAt` age; a report older than
// STALE_MAX_MS for its group is marked STALE. The exit code does not change.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WATCH_MAX_RATIO = 2;
export const WATCH_MIN_RATIO = 0.7;
const HOUR_MS = 3600_000;
export const STALE_MAX_MS = { weekly: 48 * HOUR_MS, ci: 6 * HOUR_MS };

export function readPath(object, dotted) {
  return dotted.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

export function evaluateBudget(budget, report) {
  const value = readPath(report, budget.path);
  const samples = budget.samplesPath ? readPath(report, budget.samplesPath) : null;
  const baseline = typeof budget.baseline === "number" ? budget.baseline : null;
  const ratio = baseline && typeof value === "number" ? value / baseline : null;
  const base = { id: budget.id, number: budget.number, value: value ?? null, samples, limit: budget.max ?? budget.min, baseline, ratio };
  if (value === undefined) return { ...base, status: "fail", reason: `no value at ${budget.path}` };
  if (budget.minSamples && !(samples >= budget.minSamples)) {
    return { ...base, status: "fail", reason: `sample size ${samples ?? "missing"} below ${budget.minSamples}` };
  }
  if (value === null) {
    return budget.allowNull
      ? { ...base, status: "pass", reason: "no data in window (allowed)" }
      : { ...base, status: "fail", reason: "value is null" };
  }
  if (budget.max !== undefined && value > budget.max) return { ...base, status: "fail", reason: `${value} > max ${budget.max}` };
  if (budget.min !== undefined && value < budget.min) return { ...base, status: "fail", reason: `${value} < min ${budget.min}` };
  const drifted = ratio !== null && (budget.max !== undefined ? ratio >= WATCH_MAX_RATIO : ratio <= WATCH_MIN_RATIO);
  if (drifted) return { ...base, status: "pass", watch: true, reason: `within budget, ${formatRatio(ratio)} baseline` };
  return { ...base, status: "pass", reason: "within budget" };
}

export function formatRatio(ratio) {
  return ratio === null || ratio === undefined ? "-" : `${ratio.toFixed(2)}x`;
}

export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// Age of a report's `measuredAt` at `now`, and whether it is past the group's limit.
export function measuredInfo(measuredAt, group, now = Date.now()) {
  const at = typeof measuredAt === "string" ? Date.parse(measuredAt) : NaN;
  if (Number.isNaN(at)) return { measuredAt: null, ageMs: null, stale: false };
  const ageMs = now - at;
  const maxMs = STALE_MAX_MS[group];
  return { measuredAt, ageMs, stale: maxMs !== undefined && ageMs > maxMs, staleMaxMs: maxMs };
}

export function formatMeasured(r) {
  if (r.ageMs === null || r.ageMs === undefined) return "unknown";
  const age = `${formatAge(r.ageMs)} ago`;
  return r.stale ? `${age} STALE (max ${formatAge(r.staleMaxMs)})` : age;
}

export function formatRow(r) {
  const result = r.watch ? "PASS (watch)" : r.status.toUpperCase();
  return `| ${r.id} | ${r.number} | ${r.value ?? "n/a"} | ${r.baseline ?? "-"} | ${formatRatio(r.ratio)} | ${r.limit} | ${r.samples ?? "-"} | ${result}: ${r.reason} | ${formatMeasured(r)} |`;
}

export function checkBudgets(config, { group, inputs = {}, root = process.cwd(), readReport, now = Date.now() } = {}) {
  const load = readReport ?? ((file) => JSON.parse(readFileSync(file, "utf8")));
  const reports = new Map();
  const results = [];
  for (const budget of config.budgets.filter((entry) => !group || entry.group === group)) {
    const file = resolve(root, inputs[budget.input] ?? config.inputs[budget.input]);
    if (!reports.has(file)) {
      reports.set(file, readReport || existsSync(file) ? load(file) : null);
    }
    const report = reports.get(file);
    const measured = measuredInfo(report?.measuredAt, budget.group, now);
    results.push(report
      ? { ...evaluateBudget(budget, report), ...measured }
      : { id: budget.id, number: budget.number, value: null, samples: null, limit: budget.max ?? budget.min, baseline: budget.baseline ?? null, ratio: null, status: "fail", reason: `missing input ${file}`, ...measured });
  }
  return { ok: results.length > 0 && results.every((result) => result.status === "pass"), results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const values = (name) => argv.flatMap((arg, index) => (arg === `--${name}` ? [argv[index + 1]] : []));
  const root = resolve(import.meta.dirname, "../..");
  const config = JSON.parse(readFileSync(resolve(root, values("budgets")[0] ?? "tests/metrics-budgets/budgets.json"), "utf8"));
  const inputs = Object.fromEntries(values("input").map((pair) => pair.split("=")));
  const { ok, results } = checkBudgets(config, { group: values("group")[0], inputs, root });
  console.log("| Budget | # | Value | Baseline | x baseline | Limit | Samples | Result | Measured |");
  console.log("|---|---|---:|---:|---:|---:|---:|---|---|");
  for (const r of results) console.log(formatRow(r));
  if (results.some((r) => r.stale)) console.log("STALE: at least one report is older than its group limit; collect again before trusting this result.");
  if (!ok) console.error(results.length ? "Metric budget check FAILED." : "No budgets selected.");
  process.exitCode = ok ? 0 : 1;
}
