import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, planRun, readSettings } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const MAP = JSON.parse(readFileSync(join(HERE, "switch-tests.json"), "utf8")).switches;

function catalogKeys() {
  const source = readFileSync(join(REPO, "packages/shared/src/feature-catalog.ts"), "utf8");
  const start = source.indexOf("export const INSTANCE_FEATURE_CATALOG");
  const end = source.indexOf("\n};", start);
  return [...source.slice(start, end).matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]).sort();
}

test("the map has exactly one entry per Experimental switch", () => {
  const keys = catalogKeys();
  assert.ok(keys.length > 30, `parsed ${keys.length} catalog keys`);
  assert.deepEqual(Object.keys(MAP).sort(), keys);
});

test("every mapped test file exists and is a vitest file", () => {
  for (const [key, files] of Object.entries(MAP)) {
    for (const file of files) {
      assert.match(file, /\.test\.tsx?$/, `${key}: ${file}`);
      assert.ok(existsSync(join(REPO, file)), `${key}: ${file} is missing`);
    }
  }
});

// A throwaway repo: server/ is a package with two test files.
function fixtureRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "switch-tests-fixture-")));
  mkdirSync(join(repo, "server/src"), { recursive: true });
  writeFileSync(join(repo, "server/package.json"), "{}");
  writeFileSync(join(repo, "server/src/a.test.ts"), "");
  writeFileSync(join(repo, "server/src/b.test.ts"), "");
  const map = join(repo, "map.json");
  writeFileSync(map, JSON.stringify({ switches: {
    alphaOn: ["server/src/a.test.ts"],
    betaOn: ["server/src/b.test.ts", "server/src/gone.test.ts"],
    gammaOff: ["server/src/b.test.ts"],
  } }));
  const settings = join(repo, "settings.json");
  writeFileSync(settings, JSON.stringify({ alphaOn: true, betaOn: true, gammaOff: false, someTimestamp: null }));
  return { repo, map, settings };
}

function vitestReport(repo, outcomes) {
  return {
    report: {
      testResults: Object.entries(outcomes).map(([file, failedTests]) => ({
        name: join(repo, file),
        status: failedTests.length ? "failed" : "passed",
        assertionResults: [
          { fullName: "ok case", status: "passed" },
          ...failedTests.map((fullName) => ({ fullName, status: "failed" })),
        ],
      })),
    },
    exitCode: 0,
  };
}

test("only files of switches that are on are run, once per package", () => {
  const { repo, map, settings } = fixtureRepo();
  const plan = planRun(JSON.parse(readFileSync(settings, "utf8")), JSON.parse(readFileSync(map, "utf8")).switches, repo);
  assert.deepEqual(plan.on, ["alphaOn", "betaOn"]);
  assert.deepEqual([...plan.byPackage.keys()], [join(repo, "server")]);
  assert.deepEqual(plan.byPackage.get(join(repo, "server")), ["server/src/a.test.ts", "server/src/b.test.ts"]);
  assert.deepEqual(plan.missing, ["server/src/gone.test.ts"]);
});

test("all passing tests of on switches pass the candidate", async () => {
  const { repo, map, settings } = fixtureRepo();
  writeFileSync(map, JSON.stringify({ switches: { alphaOn: ["server/src/a.test.ts"], betaOn: [], gammaOff: [] } }));
  const logs = [];
  const code = await main(["--repo", repo, "--map", map, "--settings-file", settings], {
    prepare: () => true,
    run: () => vitestReport(repo, { "server/src/a.test.ts": [] }),
    log: (line) => logs.push(line),
  });
  assert.equal(code, 0, logs.join("\n"));
  assert.match(logs.join("\n"), /Switch tests: PASSED/);
  assert.match(logs.join("\n"), /On without tests: betaOn/);
});

test("a failing test of an on switch fails the candidate and names the switch and the test", async () => {
  const { repo, map, settings } = fixtureRepo();
  const logs = [];
  const json = join(repo, "report.json");
  const code = await main(["--repo", repo, "--map", map, "--settings-file", settings, "--json", json], {
    prepare: () => true,
    run: () => vitestReport(repo, { "server/src/a.test.ts": [], "server/src/b.test.ts": ["heartbeat > blocks the run"] }),
    log: (line) => logs.push(line),
  });
  const out = logs.join("\n");
  assert.equal(code, 1, out);
  assert.match(out, /Switch tests: FAILED/);
  assert.match(out, /- betaOn \| server\/src\/b\.test\.ts \| heartbeat > blocks the run/);
  assert.match(out, /- betaOn \| server\/src\/gone\.test\.ts \| test file is missing in this candidate/);
  assert.doesNotMatch(out, /gammaOff/);
  assert.doesNotMatch(out, /alphaOn \|/);
  const report = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(report.verdict, "failed");
  assert.deepEqual(report.failures.map((f) => f.switch), ["betaOn", "betaOn"]);
});

test("a file that does not load and a crashed vitest both fail", async () => {
  const { repo, map, settings } = fixtureRepo();
  const logs = [];
  const code = await main(["--repo", repo, "--map", map, "--settings-file", settings], {
    prepare: () => true,
    run: () => ({
      report: { testResults: [{ name: join(repo, "server/src/a.test.ts"), status: "failed", message: "SyntaxError: bad\n at x", assertionResults: [] }] },
      exitCode: 1,
    }),
    log: (line) => logs.push(line),
  });
  const out = logs.join("\n");
  assert.equal(code, 1);
  assert.match(out, /alphaOn \| server\/src\/a\.test\.ts \| SyntaxError: bad/);
  assert.match(out, /betaOn \| server\/src\/b\.test\.ts \| no result from vitest \(exit 1\)/);
});

test("a switch that is on with no map entry fails the candidate", async () => {
  const { repo, map, settings } = fixtureRepo();
  writeFileSync(settings, JSON.stringify({ alphaOn: true, brandNewSwitch: true }));
  const logs = [];
  const code = await main(["--repo", repo, "--map", map, "--settings-file", settings], {
    prepare: () => true,
    run: () => vitestReport(repo, { "server/src/a.test.ts": [] }),
    log: (line) => logs.push(line),
  });
  assert.equal(code, 1);
  assert.match(logs.join("\n"), /brandNewSwitch \| - \| switch is on but has no entry/);
});

test("--from-activity reads the latest stored settings with the agent key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return new Response(JSON.stringify([
      { action: "instance.settings.experimental_updated", createdAt: "2026-09-26T10:00:00Z", details: { experimental: { a: false } } },
      { action: "instance.settings.general_updated", createdAt: "2026-09-28T10:00:00Z", details: {} },
      { action: "instance.settings.experimental_updated", createdAt: "2026-09-27T14:06:26Z", details: { experimental: { a: true } } },
    ]));
  };
  const env = { GSAM_API_URL: "http://127.0.0.1:3100/api", GSAM_API_KEY: "k", GSAM_COMPANY_ID: "c1" };
  const out = await readSettings({ kind: "activity" }, { fetchImpl, env });
  assert.deepEqual(out.settings, { a: true });
  assert.equal(calls[0].url, "http://127.0.0.1:3100/api/companies/c1/activity?entityType=instance_settings&limit=200");
  assert.equal(calls[0].auth, "Bearer k");
});

test("missing switch values is a usage error, not a pass", async () => {
  const logs = [];
  assert.equal(await main([], { log: (l) => logs.push(l) }), 2);
  const fetchImpl = async () => new Response("forbidden", { status: 403 });
  assert.equal(await main(["--settings-url", "http://localhost:3200"], { fetchImpl, log: (l) => logs.push(l) }), 2);
  assert.match(logs.join("\n"), /answered 403/);
});

test("started through a symlinked path, the runner still runs main()", () => {
  // macOS /var -> /private/var: argv[1] is not the real path of the script.
  const link = join(mkdtempSync(join(tmpdir(), "switch-tests-link-")), "dir");
  symlinkSync(HERE, link, "dir");
  const out = spawnSync(process.execPath, [join(link, "run.mjs")], { encoding: "utf8" });
  assert.equal(out.status, 2, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
  assert.match(out.stdout, /switch-tests:/);
});
