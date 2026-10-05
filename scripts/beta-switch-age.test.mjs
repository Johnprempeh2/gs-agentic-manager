// Tests for scripts/beta-switch-age.sh and its report (beta-switch-age.mjs).
// The activity list is fixed; the shell test serves it from a local stub API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatScorecardGaps,
  formatTable,
  isTestFile,
  parseCatalogKeys,
  parseRetiredKeys,
  parseScorecardKeys,
  scorecardGaps,
  switchAges,
  testFileCounts,
} from "./beta-switch-age.mjs";

const SCRIPT = new URL("./beta-switch-age.sh", import.meta.url).pathname;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// Newest first, as the activity route returns it.
function change(daysAgo, changedKeys, experimental) {
  return {
    action: "instance.settings.experimental_updated",
    createdAt: ago(daysAgo),
    details: { changedKeys, experimental },
  };
}
const SETTINGS = { onLong: true, onShort: true, onThenOff: false, neverChanged: true };
const ACTIVITY = [
  change(5, ["onShort"], { onLong: true, onShort: true, onThenOff: false, neverChanged: true }),
  change(8, ["onThenOff"], { onLong: true, onShort: false, onThenOff: false, neverChanged: true }),
  change(12, ["onLong"], { onLong: true, onShort: false, onThenOff: true, neverChanged: true }),
  change(18, ["onThenOff"], { onLong: true, onShort: false, onThenOff: true, neverChanged: true }),
  change(20, ["onLong"], { onLong: true, onShort: false, onThenOff: false, neverChanged: true }),
];

const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

test("on 20 days: met; on 5 days: not met; on then off: off, not met; never changed: unknown", () => {
  const rows = byKey(switchAges(SETTINGS, ACTIVITY, { now: NOW }));
  // onLong was re-saved on day 12; the clock still starts on day 20.
  assert.deepEqual(rows.onLong, { key: "onLong", state: "on", onSince: "2026-09-14", days: 20, ruleMet: "yes" });
  assert.deepEqual(rows.onShort, { key: "onShort", state: "on", onSince: "2026-09-29", days: 5, ruleMet: "no" });
  assert.deepEqual(rows.onThenOff, { key: "onThenOff", state: "off", onSince: "-", days: null, ruleMet: "no" });
  assert.deepEqual(rows.neverChanged, { key: "neverChanged", state: "on", onSince: "unknown", days: null, ruleMet: "unknown" });
});

test("a last logged value that differs from the current one is unknown, not a guess", () => {
  const rows = byKey(switchAges({ onShort: false }, ACTIVITY, { now: NOW }));
  assert.equal(rows.onShort.onSince, "unknown");
  assert.equal(rows.onShort.ruleMet, "unknown");
});

test("cut-off history: a run that reaches the oldest row is open-ended", () => {
  const recent = ACTIVITY.filter((row) => Date.parse(row.createdAt) > NOW - 10 * DAY);
  const rows = byKey(switchAges({ onShort: true }, recent, { now: NOW, truncated: true }));
  assert.equal(rows.onShort.onSince, "before 2026-09-29");
  assert.equal(rows.onShort.ruleMet, "unknown");
});

test("non-switch values and managedKeys", () => {
  const rows = switchAges({ maxThing: 3, managedKeys: ["x"] }, [], { now: NOW });
  assert.deepEqual(rows, [{ key: "maxThing", state: "3", onSince: "unknown", days: null, ruleMet: "n/a" }]);
});

// Runs the shell script against a stub API; returns { code, stdout, stderr, requests }.
async function runScript(args = []) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const url = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/agents/me") return res.end(JSON.stringify({ companyId: "c1" }));
    if (url.pathname === "/api/instance/settings/experimental") return res.end(JSON.stringify(SETTINGS));
    if (url.pathname === "/api/companies/c1/activity") {
      const shifted = ACTIVITY.map((row) => ({ ...row, createdAt: new Date(Date.parse(row.createdAt) - NOW + Date.now()).toISOString() }));
      return res.end(JSON.stringify(shifted));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const env = { ...process.env, GSAM_API_URL: `http://127.0.0.1:${port}/api`, GSAM_API_KEY: "test-key" };
    delete env.GSAM_COMPANY_ID;
    const child = spawn("bash", [SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, stdout, stderr, requests };
  } finally {
    server.close();
  }
}

test("shell script sends only GET requests and prints one row per switch", async () => {
  const { code, stdout, stderr, requests } = await runScript();
  assert.equal(code, 0, stderr);

  assert.deepEqual(requests.map((r) => r.method), ["GET", "GET", "GET"]);
  assert.ok(requests.every((r) => r.auth === "Bearer test-key"));
  const activityUrl = new URL(requests[2].url, "http://x");
  assert.equal(activityUrl.searchParams.get("action"), "instance.settings.experimental_updated");

  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1 + Object.keys(SETTINGS).length);
  assert.doesNotMatch(stdout, /scorecard/);
  assert.match(stdout, /^neverChanged\s+on\s+unknown\s+-\s+unknown$/m);
  assert.match(stdout, /^onLong\s+on\s+\d{4}-\d\d-\d\d\s+20\s+yes$/m);
  assert.match(stdout, /^onShort\s+on\s+\d{4}-\d\d-\d\d\s+5\s+no$/m);
  assert.match(stdout, /^onThenOff\s+off\s+-\s+-\s+no$/m);
});

test("shell script --scorecard adds the no row and gone lists after the same table; exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beta-switch-age-"));
  try {
    const file = join(dir, "scorecard.md");
    // Every real catalog key but the first, plus one key that is not in the catalog.
    const catalog = parseCatalogKeys(readFileSync(new URL("../packages/shared/src/feature-catalog.ts", import.meta.url), "utf8"));
    const rows = [...catalog.slice(1), "enableGoneSwitch"].map((key, i) => `| ${i + 1} | X (\`${key}\`) | x |`);
    writeFileSync(file, ["| # | Switch (key) | What |", "|---|---|---|", ...rows].join("\n"));
    const plain = await runScript();
    const { code, stdout, stderr } = await runScript(["--scorecard", file]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(code, 0, stderr);
    // Same output as without the flag, then the two lists.
    assert.equal(stdout, `${plain.stdout}\nscorecard: no row: ${catalog[0]}\nscorecard: gone: enableGoneSwitch\n`);

    const bad = await runScript(["--scorecard", join(dir, "missing.md")]);
    assert.equal(bad.code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatTable aligns columns", () => {
  const out = formatTable([{ key: "a", state: "on", onSince: "unknown", days: null, ruleMet: "unknown" }]);
  assert.equal(out, "switch  state  on since  days on  2-week rule met\na       on     unknown   -        unknown");
});

test("retired switches show retired, whatever their stored value", () => {
  const rows = byKey(switchAges({ ...SETTINGS, oldSwitch: false }, ACTIVITY, { now: NOW, retired: ["oldSwitch", "onLong"] }));
  assert.deepEqual(rows.oldSwitch, { key: "oldSwitch", state: "retired", onSince: "-", days: null, ruleMet: "n/a" });
  assert.equal(rows.onLong.state, "retired");
  assert.equal(rows.onShort.state, "on");
});

test("parseRetiredKeys reads the real feature catalog", () => {
  const source = readFileSync(new URL("../packages/shared/src/feature-catalog.ts", import.meta.url), "utf8");
  assert.deepEqual(parseRetiredKeys(source), [
    "enableClassicTaskInterface",
    "enableSmokeLab",
    "enablePaperclipDeveloperMode",
    "autoRestartDevServerWhenIdle",
  ]);
  assert.throws(() => parseRetiredKeys("export const X = 1;"), /not found/);
});

test("test files: a file naming every switch is a list file and is not counted", () => {
  const keys = ["enableA", "enableAB", "enableC"];
  const { counts, listFiles } = testFileCounts(keys, [
    { path: "ui/Settings.test.tsx", text: "enableA enableAB enableC" },
    { path: "server/a.test.ts", text: "settings.enableA = true" },
    { path: "server/ab.test.ts", text: "{ enableAB: true, enableC: false }" },
    { path: "server/none.test.ts", text: "enableAx is not a switch" },
  ]);
  assert.deepEqual(listFiles, ["ui/Settings.test.tsx"]);
  // Whole-word match: "enableAB" does not count for "enableA".
  assert.deepEqual(counts, { enableA: 1, enableAB: 1, enableC: 1 });
});

test("isTestFile matches test, spec and __tests__ files only", () => {
  for (const path of ["a/b.test.ts", "ui/X.test.tsx", "s/x.spec.mjs", "server/src/__tests__/helper.ts"]) {
    assert.ok(isTestFile(path), path);
  }
  for (const path of ["a/b.ts", "doc/test.md", "a/latest.ts"]) assert.ok(!isTestFile(path), path);
});

test("formatTable adds the test files column only when counted", () => {
  const out = formatTable([{ key: "a", state: "retired", onSince: "-", days: null, ruleMet: "n/a", testFiles: 2 }]);
  assert.equal(out, "switch  state    on since  days on  2-week rule met  test files\na       retired  -         -        n/a              2");
});

test("parseCatalogKeys reads every key of the real feature catalog", () => {
  const source = readFileSync(new URL("../packages/shared/src/feature-catalog.ts", import.meta.url), "utf8");
  const keys = parseCatalogKeys(source);
  assert.ok(keys.includes("enableEnvironments"));
  assert.ok(keys.includes("enableDeepDive"));
  for (const key of parseRetiredKeys(source)) assert.ok(keys.includes(key), key);
  // Field names inside an entry are not keys.
  assert.ok(!keys.includes("title") && !keys.includes("tier"));
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => parseCatalogKeys("export const X = 1;"), /not found/);
});

test("scorecard: one missing row and one gone row", () => {
  const text = [
    "| # | Switch (key) | Live | Verdict |",
    "|---|---|---|---|",
    "| 1 | Environments (`enableEnvironments`) | off | **keep in beta** |",
    "| 2 | Old thing (`enableOldThing`) | off | **removed** |",
    "",
    "| Issue | Owner | Switch |",
    "| GRE-89 | Ridge | Branch (`enableNotARow`) |",
    "Text naming `enableAlsoNotARow` is not a row.",
  ].join("\n");
  const keys = parseScorecardKeys(text);
  assert.deepEqual(keys, ["enableEnvironments", "enableOldThing"]);
  const gaps = scorecardGaps(["enableEnvironments", "enableDeepDive"], keys);
  assert.deepEqual(gaps, { noRow: ["enableDeepDive"], gone: ["enableOldThing"] });
  assert.equal(formatScorecardGaps(gaps), "scorecard: no row: enableDeepDive\nscorecard: gone: enableOldThing");
  assert.equal(formatScorecardGaps({ noRow: [], gone: [] }), "scorecard: no row: none\nscorecard: gone: none");
});
