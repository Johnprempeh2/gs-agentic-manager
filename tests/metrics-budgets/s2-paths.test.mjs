import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchS2Path, s2CheckNeeded } from "./s2-paths.mjs";
import { s2Budgets, summarize } from "./s2-check.mjs";
import { checkBudgets } from "./check.mjs";

test("UI and issue/board API changes need the S2 check", () => {
  for (const file of [
    "ui/src/pages/IssueDetail.tsx",
    "ui/src/components/IssuesList.tsx",
    "ui/index.html",
    "ui/vite.config.ts",
    "ui/package.json",
    "server/src/routes/issues.ts",
    "server/src/routes/issue-tree-control.ts",
    "server/src/routes/issues-checkout-wakeup.ts",
    "server/src/services/issues.ts",
    "tests/perf/issue-detail/issue-detail.perf.spec.ts",
    "tests/metrics-budgets/budgets.json",
    "./ui/src/App.tsx",
  ]) {
    assert.ok(matchS2Path(file), `${file} should need the check`);
  }
});

test("unrelated, test-only and doc-only changes do not", () => {
  for (const file of [
    "server/src/routes/agents.ts",
    "server/src/routes/board-chat.ts",
    "server/src/services/issue-liveness.ts",
    "server/src/routes/issues/nested.ts",
    "ui/src/pages/IssueDetail.test.tsx",
    "ui/src/components/Board.stories.tsx",
    "ui/src/__tests__/board.ts",
    "ui/README.md",
    "doc/GREATSTONE-WAY-OF-WORKING.md",
    "packages/shared/src/index.ts",
    "tests/perf/task-chat/scrollback.spec.ts",
    "tests/metrics-budgets/README.md",
    "notui/src/x.ts",
    "",
  ]) {
    assert.equal(matchS2Path(file), null, `${file} should not need the check`);
  }
});

test("a PR answer is yes when any one file matches, and lists why", () => {
  const yes = s2CheckNeeded(["doc/a.md", "ui/src/pages/Issues.tsx", "server/src/routes/agents.ts", ""]);
  assert.equal(yes.needed, true);
  assert.deepEqual(yes.matches, [{ file: "ui/src/pages/Issues.tsx", why: "UI code" }]);
  const no = s2CheckNeeded(["doc/a.md", "ui/src/x.test.ts"]);
  assert.deepEqual(no, { needed: false, matches: [] });
});

test("the S2 check judges only the S2 CI budgets and names what broke", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "budgets.json"), "utf8"));
  const selected = s2Budgets(config).budgets;
  assert.equal(selected.length, 6);
  assert.ok(selected.every((budget) => budget.number === "S2" && budget.input === "s2"));

  const stats = (medianMs, p95Ms) => ({ n: 20, medianMs, p95Ms });
  const report = (boardP95) => ({ measuredAt: new Date().toISOString(), s2: { unthrottled: {
    issueDetailWarmContentPaint: stats(170, 210),
    issueDetailColdContentPaint: stats(490, 600),
    boardColdReady: stats(470, boardP95),
  } } });
  const check = (data) => checkBudgets(s2Budgets(config), { group: "ci", readReport: () => data });

  const pass = check(report(560));
  assert.equal(pass.ok, true);
  assert.match(summarize(pass), /^S2 page-load check: PASS/);

  const over = check(report(1300));
  assert.equal(over.ok, false);
  assert.match(summarize(over), /^S2 page-load check: FAIL - over budget or not measured: board cold open p95\n/);
  assert.match(summarize(over), /OVER board cold open p95: 1300 ms \(limit 1120 ms; 1300 > max 1120\)/);

  const missing = check({});
  assert.equal(missing.ok, false);
});

test("the Keystone host calibration covers the same S2 budgets with written margins", () => {
  const shared = s2Budgets(JSON.parse(readFileSync(resolve(import.meta.dirname, "budgets.json"), "utf8"))).budgets;
  const host = JSON.parse(readFileSync(resolve(import.meta.dirname, "budgets.keystone-host.json"), "utf8"));
  assert.ok(host.baselineRecorded.date && host.baselineRecorded.machine && host.baselineRecorded.command);
  assert.deepEqual(s2Budgets(host).budgets.map((b) => b.id), shared.map((b) => b.id));
  for (const budget of host.budgets) {
    const twin = shared.find((b) => b.id === budget.id);
    assert.equal(budget.path, twin.path, `${budget.id} measures the same thing`);
    assert.equal(budget.minSamples, twin.minSamples, `${budget.id} needs the same sample size`);
    assert.ok(budget.margin, `${budget.id} margin is written down`);
    assert.ok(budget.max > budget.baseline, `${budget.id} limit sits above its baseline`);
  }
  assert.ok(matchS2Path("tests/metrics-budgets/budgets.keystone-host.json"));
});
