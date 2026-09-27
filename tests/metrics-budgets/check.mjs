// Compares saved metric reports against budgets.json and exits nonzero when a
// budget is broken, an input is missing, or a sample is too small to judge.
//
//   node tests/metrics-budgets/check.mjs --group ci|weekly [--input id=path ...] [--budgets file]
//
// Each budget is baseline plus a written margin; see budgets.json and README.md.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readPath(object, dotted) {
  return dotted.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

export function evaluateBudget(budget, report) {
  const value = readPath(report, budget.path);
  const samples = budget.samplesPath ? readPath(report, budget.samplesPath) : null;
  const base = { id: budget.id, number: budget.number, value: value ?? null, samples, limit: budget.max ?? budget.min };
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
  return { ...base, status: "pass", reason: "within budget" };
}

export function checkBudgets(config, { group, inputs = {}, root = process.cwd(), readReport } = {}) {
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
      ? evaluateBudget(budget, report)
      : { id: budget.id, number: budget.number, value: null, samples: null, limit: budget.max ?? budget.min, status: "fail", reason: `missing input ${file}` });
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
  console.log("| Budget | # | Value | Limit | Samples | Result |");
  console.log("|---|---|---:|---:|---:|---|");
  for (const r of results) console.log(`| ${r.id} | ${r.number} | ${r.value ?? "n/a"} | ${r.limit} | ${r.samples ?? "-"} | ${r.status.toUpperCase()}: ${r.reason} |`);
  if (!ok) console.error(results.length ? "Metric budget check FAILED." : "No budgets selected.");
  process.exitCode = ok ? 0 : 1;
}
