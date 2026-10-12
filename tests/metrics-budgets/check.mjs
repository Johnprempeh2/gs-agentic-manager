// Compares saved metric reports against budgets.json and exits nonzero when a
// budget is broken, an input is missing, or a sample is too small to judge.
//
//   node tests/metrics-budgets/check.mjs --group ci|weekly [--input id=path ...] [--budgets file]
//
// Each budget is baseline plus a written margin; see budgets.json and README.md.
// A passing value at WATCH_MAX_RATIO x baseline or more (WATCH_MIN_RATIO x or
// less for a `min` floor) is marked PASS (watch). The exit code does not change.
// The Measured column shows each report's `measuredAt` age. A row fails when its
// report is older than `reportMaxAgeHours[group]` in the budget file, or has no
// readable `measuredAt` (GRE-837), so a skipped collect step cannot pass on an
// old file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WATCH_MAX_RATIO = 2;
export const WATCH_MIN_RATIO = 0.7;
const HOUR_MS = 3600_000;

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

// Age of a report's `measuredAt` at `now`, and why it is too old to judge, if it is.
export function measuredInfo(measuredAt, maxAgeHours, now = Date.now()) {
  const at = typeof measuredAt === "string" ? Date.parse(measuredAt) : NaN;
  if (Number.isNaN(at)) {
    const reason = measuredAt === undefined || measuredAt === null ? "report has no measuredAt" : `report measuredAt ${JSON.stringify(measuredAt)} is not a date`;
    return { measuredAt: null, ageMs: null, stale: true, staleReason: reason };
  }
  const ageMs = now - at;
  if (typeof maxAgeHours !== "number") return { measuredAt, ageMs, stale: true, staleReason: "no reportMaxAgeHours for this group in the budget file" };
  const staleMaxMs = maxAgeHours * HOUR_MS;
  const stale = ageMs > staleMaxMs;
  return { measuredAt, ageMs, stale, staleMaxMs, ...(stale && { staleReason: `report is ${Math.floor(ageMs / HOUR_MS)} h old (limit ${maxAgeHours} h)` }) };
}

// A row whose report is too old (or undated) fails, whatever its value.
function withAge(result, measured) {
  if (!measured.stale) return { ...result, ...measured };
  const reason = result.status === "pass" ? measured.staleReason : `${measured.staleReason}; ${result.reason}`;
  return { ...result, ...measured, status: "fail", watch: undefined, reason };
}

export function formatMeasured(r) {
  if (r.ageMs === null || r.ageMs === undefined) return r.stale ? "unknown STALE" : "unknown";
  const age = `${formatAge(r.ageMs)} ago`;
  if (!r.stale) return age;
  return r.staleMaxMs === undefined ? `${age} STALE` : `${age} STALE (max ${formatAge(r.staleMaxMs)})`;
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
    results.push(report
      ? withAge(evaluateBudget(budget, report), measuredInfo(report.measuredAt, config.reportMaxAgeHours?.[budget.group], now))
      : { id: budget.id, number: budget.number, value: null, samples: null, limit: budget.max ?? budget.min, baseline: budget.baseline ?? null, ratio: null, status: "fail", reason: `missing input ${file}`, measuredAt: null, ageMs: null, stale: false });
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
  if (results.some((r) => r.stale)) console.log("STALE: at least one report is too old or undated; collect it again, then rerun this check.");
  if (!ok) console.error(results.length ? "Metric budget check FAILED." : "No budgets selected.");
  process.exitCode = ok ? 0 : 1;
}
