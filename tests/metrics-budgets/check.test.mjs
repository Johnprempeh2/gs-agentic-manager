import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkBudgets, evaluateBudget } from "./check.mjs";

const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "budgets.json"), "utf8"));

test("every budget records its baseline, margin and resulting limit", () => {
  for (const budget of config.budgets) {
    assert.ok(config.inputs[budget.input], `${budget.id} input`);
    assert.ok(["ci", "weekly"].includes(budget.group), `${budget.id} group`);
    assert.equal(typeof budget.baseline, "number", `${budget.id} baseline`);
    assert.ok(budget.margin, `${budget.id} margin is written down`);
    assert.ok((budget.max === undefined) !== (budget.min === undefined), `${budget.id} has exactly one limit`);
  }
  for (const number of ["R1", "R2", "S1", "S2"]) {
    assert.ok(config.budgets.some((budget) => budget.number === number), `${number} has a budget`);
  }
});

test("a value over the limit fails; at the limit passes", () => {
  const budget = { id: "b", number: "S2", path: "a.p95Ms", max: 100 };
  assert.equal(evaluateBudget(budget, { a: { p95Ms: 100 } }).status, "pass");
  assert.equal(evaluateBudget(budget, { a: { p95Ms: 101 } }).status, "fail");
  assert.equal(evaluateBudget({ ...budget, max: undefined, min: 0.5 }, { a: { p95Ms: 0.4 } }).status, "fail");
});

test("missing values, small samples and missing inputs fail closed", () => {
  const budget = { id: "b", number: "S1", path: "s1.p95Ms", samplesPath: "s1.n", minSamples: 10, max: 5 };
  assert.equal(evaluateBudget(budget, {}).status, "fail");
  assert.equal(evaluateBudget(budget, { s1: { p95Ms: 1, n: 9 } }).status, "fail");
  assert.equal(evaluateBudget(budget, { s1: { p95Ms: null, n: 10 } }).status, "fail");
  assert.equal(evaluateBudget({ ...budget, allowNull: true }, { s1: { p95Ms: null, n: 10 } }).status, "pass");
  const missing = checkBudgets({ inputs: { x: "does-not-exist.json" }, budgets: [{ ...budget, input: "x", group: "ci" }] }, { group: "ci" });
  assert.equal(missing.ok, false);
  assert.match(missing.results[0].reason, /missing input/);
  assert.equal(checkBudgets(config, { group: "no-such-group" }).ok, false, "selecting nothing is not a pass");
});

test("the committed CI budgets fail on a regressed S2 report and pass at baseline", () => {
  const regress = (file) => {
    const report = fixtureFor(file);
    if (file.includes("issue-detail")) report.s2.unthrottled.boardColdReady.p95Ms *= 3;
    return report;
  };
  const result = checkBudgets(config, { group: "ci", readReport: regress });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.filter((entry) => entry.status === "fail").map((entry) => entry.id), ["s2-board-cold-p95-unthrottled"]);
  const baseline = checkBudgets(config, { group: "ci", readReport: fixtureFor });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.results.filter((entry) => entry.status !== "pass")));
});

// A report holding exactly the committed baseline for every budget read from `file`.
function fixtureFor(file) {
  const report = {};
  for (const budget of config.budgets.filter((entry) => file.endsWith(config.inputs[entry.input]))) {
    const set = (dotted, value) => {
      const keys = dotted.split(".");
      const leaf = keys.pop();
      keys.reduce((node, key) => (node[key] ??= {}), report)[leaf] = value;
    };
    set(budget.path, budget.baseline);
    if (budget.samplesPath) set(budget.samplesPath, budget.minSamples);
  }
  return report;
}
