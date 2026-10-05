import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkBudgets, evaluateBudget, formatRow } from "./check.mjs";
import { summarize } from "./s2-check.mjs";

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
  const report = { measuredAt: new Date().toISOString() };
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

test("the committed R2 budgets judge the platform rate, not login refusals, and floor the unattended share", () => {
  const r2 = config.budgets.filter((budget) => budget.number === "R2");
  assert.deepEqual(r2.map((budget) => budget.path).sort(), ["r2.platformFailureRate", "r2.unattendedRecoveryShare"]);
  const report = (fields) => ({ measuredAt: new Date().toISOString(), r2: { platformFinished: 200, failuresWithIssue: 50, platformFailureRate: 0.03, unattendedRecoveryShare: 0.5, ...fields } });
  const failing = (fields) => checkBudgets(config, { group: "weekly", readReport: () => report(fields) })
    .results.filter((entry) => entry.number === "R2" && entry.status === "fail").map((entry) => entry.id);
  assert.deepEqual(failing({}), []);
  assert.deepEqual(failing({ failureRate: 0.2, loginRefusals: 30 }), [], "a login outage alone does not break R2");
  assert.deepEqual(failing({ platformFailureRate: 0.09 }), ["r2-platform-failure-rate"]);
  assert.deepEqual(failing({ unattendedRecoveryShare: 0.3 }), ["r2-unattended-recovery-share"]);
});

test("the committed S1-work budgets fail on a regressed weekly report and pass at baseline (GRE-75)", () => {
  const failing = (regress) => {
    const report = fixtureFor(config.inputs.lifecycle);
    regress(report);
    return checkBudgets(config, { group: "weekly", readReport: () => report })
      .results.filter((entry) => entry.status === "fail").map((entry) => entry.id);
  };
  assert.deepEqual(failing(() => {}), []);
  assert.deepEqual(failing((report) => { report.s1.work.medianMs *= 2; }), ["s1-work-median"]);
  assert.deepEqual(failing((report) => { report.s1.work.p95Ms *= 2; }), ["s1-work-p95"]);
  assert.deepEqual(failing((report) => { report.s1.work.sampleSize = 19; }), ["s1-work-median", "s1-work-p95"]);
});

test("a passing max budget at 2x baseline or more is marked PASS (watch)", () => {
  // R2 platform failure rate, week to 2026-10-04: 4.9% against a 1.88% baseline, under the 8% limit.
  const budget = { id: "r2", number: "R2", path: "r2.rate", baseline: 0.0188, max: 0.08 };
  const watched = evaluateBudget(budget, { r2: { rate: 0.049 } });
  assert.equal(watched.status, "pass");
  assert.equal(watched.watch, true);
  assert.match(formatRow(watched), /\| 0\.049 \| 0\.0188 \| 2\.61x \| 0\.08 \| - \| PASS \(watch\): /);
  assert.equal(evaluateBudget(budget, { r2: { rate: 0.0376 } }).watch, true, "exactly 2x is watched");
  const quiet = evaluateBudget(budget, { r2: { rate: 0.037 } });
  assert.equal(quiet.watch, undefined);
  assert.match(formatRow(quiet), /\| 1\.97x \| .* \| PASS: within budget \| unknown \|$/);
  assert.equal(evaluateBudget(budget, { r2: { rate: 0.09 } }).status, "fail", "over the limit still fails, not watch");
});

test("a passing min floor at 0.7x baseline or less is marked PASS (watch)", () => {
  const budget = { id: "share", number: "R2", path: "r2.share", baseline: 0.5, min: 0.3 };
  const watched = evaluateBudget(budget, { r2: { share: 0.35 } });
  assert.equal(watched.status, "pass");
  assert.equal(watched.watch, true);
  assert.match(formatRow(watched), /\| 0\.70x \| 0\.3 \| - \| PASS \(watch\): /);
  assert.equal(evaluateBudget(budget, { r2: { share: 0.36 } }).watch, undefined);
  assert.equal(evaluateBudget(budget, { r2: { share: 1.5 } }).watch, undefined, "a high value on a floor is not drift");
});

test("a budget with no baseline (or a zero baseline) shows - and is never watched", () => {
  const none = evaluateBudget({ id: "n", number: "S1", path: "v", max: 10 }, { v: 9 });
  assert.equal(none.watch, undefined);
  assert.match(formatRow(none), /^\| n \| S1 \| 9 \| - \| - \| 10 \| - \| PASS: within budget \| unknown \|$/);
  const zero = evaluateBudget({ id: "z", number: "R1", path: "v", baseline: 0, max: 2 }, { v: 1 });
  assert.equal(zero.watch, undefined);
  assert.match(formatRow(zero), /^\| z \| R1 \| 1 \| 0 \| - \| 2 \|/);
});

test("a watch row does not change the exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "metric-budgets-"));
  try {
    const run = (rate) => {
      writeFileSync(join(dir, "report.json"), JSON.stringify({ measuredAt: new Date().toISOString(), r2: { rate } }));
      writeFileSync(join(dir, "budgets.json"), JSON.stringify({
        reportMaxAgeHours: { weekly: 48 },
        inputs: { r: join(dir, "report.json") },
        budgets: [{ id: "r2", number: "R2", group: "weekly", input: "r", path: "r2.rate", baseline: 0.0188, max: 0.08 }],
      }));
      try {
        return { code: 0, out: execFileSync(process.execPath, [resolve(import.meta.dirname, "check.mjs"), "--group", "weekly", "--budgets", join(dir, "budgets.json")], { encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        return { code: error.status, out: error.stdout };
      }
    };
    const watched = run(0.049);
    assert.equal(watched.code, 0);
    assert.match(watched.out, /\| Budget \| # \| Value \| Baseline \| x baseline \| Limit \| Samples \| Result \|/);
    assert.match(watched.out, /PASS \(watch\)/);
    assert.equal(run(0.02).code, 0);
    assert.equal(run(0.09).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both committed budget files fail weekly reports after 2 days and ci / S2 reports after 6 hours (GRE-837)", () => {
  const host = JSON.parse(readFileSync(resolve(import.meta.dirname, "budgets.keystone-host.json"), "utf8"));
  for (const file of [config, host]) assert.deepEqual(file.reportMaxAgeHours, { weekly: 48, ci: 6 });
});

test("a fresh report passes; an old or undated report fails with its age and limit (GRE-837)", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const hoursAgo = (hours) => new Date(now - hours * 3600_000).toISOString();
  const check = (group, report, limits = { weekly: 48, ci: 6 }) => checkBudgets(
    { reportMaxAgeHours: limits, inputs: { r: "r.json" }, budgets: [{ id: "b", number: "R2", group, input: "r", path: "v", baseline: 1, max: 5 }] },
    { group, readReport: () => report, now },
  ).results[0];
  const fresh = check("weekly", { measuredAt: hoursAgo(47), v: 1 });
  assert.equal(fresh.status, "pass");
  assert.equal(fresh.reason, "within budget");
  const old = check("weekly", { measuredAt: hoursAgo(72), v: 1 });
  assert.equal(old.status, "fail");
  assert.equal(old.reason, "report is 72 h old (limit 48 h)");
  assert.match(formatRow(old), /\| FAIL: report is 72 h old \(limit 48 h\) \| 3d ago STALE \(max 2d\) \|$/);
  assert.equal(check("ci", { measuredAt: hoursAgo(5.9), v: 1 }).status, "pass");
  assert.equal(check("ci", { measuredAt: hoursAgo(7), v: 1 }).reason, "report is 7 h old (limit 6 h)");
  assert.equal(check("weekly", { measuredAt: hoursAgo(72), v: 9 }).reason, "report is 72 h old (limit 48 h); 9 > max 5", "both reasons show");
  const watched = check("weekly", { measuredAt: hoursAgo(72), v: 4 });
  assert.equal(watched.watch, undefined, "an old row is FAIL, not PASS (watch)");
  const undated = check("weekly", { v: 1 });
  assert.equal(undated.status, "fail");
  assert.equal(undated.reason, "report has no measuredAt");
  assert.match(formatRow(undated), /\| FAIL: report has no measuredAt \| unknown STALE \|$/);
  assert.equal(check("weekly", { measuredAt: "not a date", v: 1 }).reason, 'report measuredAt "not a date" is not a date');
  assert.equal(check("weekly", { measuredAt: hoursAgo(1), v: 1 }, {}).reason, "no reportMaxAgeHours for this group in the budget file", "a budget file without a limit fails closed");
});

test("the CLI exits 1 on an old or undated report and 0 on a fresh one (GRE-837)", () => {
  const dir = mkdtempSync(join(tmpdir(), "metric-budgets-"));
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
  try {
    const run = (group, report) => {
      writeFileSync(join(dir, "report.json"), JSON.stringify(report));
      writeFileSync(join(dir, "budgets.json"), JSON.stringify({
        reportMaxAgeHours: { weekly: 48, ci: 6 },
        inputs: { r: join(dir, "report.json") },
        budgets: [{ id: "b", number: "R2", group, input: "r", path: "v", baseline: 1, max: 5 }],
      }));
      try {
        return { code: 0, out: execFileSync(process.execPath, [resolve(import.meta.dirname, "check.mjs"), "--group", group, "--budgets", join(dir, "budgets.json")], { encoding: "utf8", stdio: "pipe" }) };
      } catch (error) {
        return { code: error.status, out: error.stdout };
      }
    };
    const fresh = run("weekly", { measuredAt: hoursAgo(5), v: 1 });
    assert.equal(fresh.code, 0);
    assert.match(fresh.out, /\| PASS: within budget \| 5h ago \|/);
    assert.doesNotMatch(fresh.out, /STALE/);
    const old = run("weekly", { measuredAt: hoursAgo(72), v: 1 });
    assert.equal(old.code, 1);
    assert.match(old.out, /\| FAIL: report is 72 h old \(limit 48 h\) \| 3d ago STALE \(max 2d\) \|/);
    assert.match(old.out, /^STALE: /m);
    assert.equal(run("ci", { measuredAt: hoursAgo(7), v: 1 }).code, 1);
    const undated = run("weekly", { v: 1 });
    assert.equal(undated.code, 1);
    assert.match(undated.out, /FAIL: report has no measuredAt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the S2 summary fails an old S2 report and names its age (GRE-837)", () => {
  const s2 = (measuredAt) => checkBudgets(
    { reportMaxAgeHours: { ci: 6 }, inputs: { s2: "m.json" }, budgets: [{ id: "s2-board-cold-p95-unthrottled", number: "S2", group: "ci", input: "s2", path: "v", baseline: 1, max: 5 }] },
    { group: "ci", readReport: () => ({ measuredAt, v: 1 }), now: Date.parse("2026-10-05T12:00:00Z") },
  );
  const fresh = summarize(s2("2026-10-05T10:00:00Z"));
  assert.match(fresh, /^S2 page-load check: PASS/);
  assert.match(fresh, /measured: 2026-10-05T10:00:00Z \(2h ago\)/);
  assert.doesNotMatch(fresh, /STALE/);
  const old = s2("2026-09-28T12:00:00Z");
  assert.equal(old.ok, false);
  assert.match(summarize(old), /^S2 page-load check: FAIL - over budget or not measured: board cold open p95/);
  assert.match(summarize(old), /OVER board cold open p95: 1 ms \(limit 5 ms; report is 168 h old \(limit 6 h\)\)/);
  assert.match(summarize(old), /\(7d ago STALE \(max 6h\)\)\n  STALE: /);
  assert.equal(s2(undefined).ok, false);
  assert.match(summarize(s2(undefined)), /report has no measuredAt/);
});
