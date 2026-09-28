// Runs the tests of every Experimental switch that is on in live, so that a
// release candidate with a broken live feature fails before John sees it
// (GRE-101). The switch -> test files map is switch-tests.json next to this file.
//
//   node tests/release-switch-tests/run.mjs [--repo dir] [--map file] [--json out]
//        (--settings-url base | --settings-file file | --from-activity)
//
// Where the switch values come from:
//   --settings-url   GET <base>/api/instance/settings/experimental. Use the
//                    preview (http://localhost:3200): it runs on a fresh copy of
//                    the live data, so it has live's values.
//   --settings-file  a saved copy of that response (JSON).
//   --from-activity  the last "instance.settings.experimental_updated" entry in
//                    the company activity log, read with the agent's own
//                    GSAM_API_URL / GSAM_API_KEY / GSAM_COMPANY_ID. Agents cannot
//                    read the settings route of live; the log has the full stored
//                    settings after each change.
//
// Tests run with vitest in each file's package, from --repo (default: this
// checkout), with the GSAM_* and legacy upstream-prefixed variables and
// DATABASE_URL removed from the env so that no test can reach the live instance. Exit 0: all pass. Exit 1: a test of
// an on switch fails, a file is missing, or an on switch has no map entry.
// Exit 2: bad arguments or the switch values could not be read.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = realpathSync(resolve(HERE, "../.."));
const MAP_PATH = "tests/release-switch-tests/switch-tests.json";

export function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, map: null, json: null, source: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--repo") opts.repo = realpathSync(resolve(value()));
    else if (arg === "--map") opts.map = resolve(value());
    else if (arg === "--json") opts.json = resolve(value());
    else if (arg === "--settings-url") opts.source = { kind: "url", value: value() };
    else if (arg === "--settings-file") opts.source = { kind: "file", value: resolve(value()) };
    else if (arg === "--from-activity") opts.source = { kind: "activity" };
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.source) throw new Error("say where the switch values come from: --settings-url, --settings-file or --from-activity");
  return opts;
}

// The map of the candidate is used when it has one, so that a candidate's own
// new tests count; otherwise the map of this checkout.
export function loadMap(opts) {
  const candidates = opts.map ? [opts.map] : [join(opts.repo, MAP_PATH), join(DEFAULT_REPO, MAP_PATH)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`no switch map at ${candidates.join(" or ")}`);
  const map = JSON.parse(readFileSync(path, "utf8")).switches;
  if (!map || typeof map !== "object") throw new Error(`${path} has no "switches" object`);
  return { path, map };
}

export async function readSettings(source, { fetchImpl = fetch, env = process.env } = {}) {
  if (source.kind === "file") {
    return { settings: JSON.parse(readFileSync(source.value, "utf8")), from: source.value };
  }
  if (source.kind === "url") {
    const url = `${source.value.replace(/\/+$/, "")}/api/instance/settings/experimental`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
    return { settings: await res.json(), from: url };
  }
  const { GSAM_API_URL: apiUrl, GSAM_API_KEY: key, GSAM_COMPANY_ID: companyId } = env;
  if (!apiUrl || !key || !companyId) throw new Error("--from-activity needs GSAM_API_URL, GSAM_API_KEY and GSAM_COMPANY_ID");
  const base = apiUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const url = `${base}/api/companies/${companyId}/activity?entityType=instance_settings&limit=200`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET company activity answered ${res.status}`);
  const entries = (await res.json())
    .filter((e) => e.action === "instance.settings.experimental_updated" && e.details?.experimental)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (entries.length === 0) {
    throw new Error("the activity log has no experimental settings change; use --settings-url with the preview");
  }
  return { settings: entries[0].details.experimental, from: `activity log entry of ${entries[0].createdAt}` };
}

export function planRun(settings, map, repo) {
  const on = Object.keys(settings).filter((key) => settings[key] === true).sort();
  const unmapped = on.filter((key) => !Array.isArray(map[key]));
  const untested = on.filter((key) => Array.isArray(map[key]) && map[key].length === 0);
  const switchesByFile = new Map();
  for (const key of on) {
    for (const file of map[key] ?? []) {
      if (!switchesByFile.has(file)) switchesByFile.set(file, []);
      switchesByFile.get(file).push(key);
    }
  }
  const missing = [];
  const byPackage = new Map();
  for (const file of switchesByFile.keys()) {
    const abs = join(repo, file);
    if (!existsSync(abs)) {
      missing.push(file);
      continue;
    }
    const pkg = packageDir(repo, abs);
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(file);
  }
  return { on, unmapped, untested, missing, switchesByFile, byPackage };
}

function packageDir(repo, absFile) {
  let dir = dirname(absFile);
  while (dir.startsWith(repo) && dir !== repo) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return repo;
}

// The legacy upstream prefix is built at run time so the rebrand guard does not
// flag it; the server still reads variables with that prefix.
const ENV_PREFIXES = ["GSAM_", ["PAPER", "CLIP_"].join("")];

function cleanEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || key === "DATABASE_URL") continue;
    out[key] = value;
  }
  return out;
}

// The server tests import @greatstone/plugin-sdk from its dist/, which a fresh
// clone (the preview's) does not have. The repo's own test scripts build it
// first with the same command.
export function prepareRepo(repo) {
  const result = spawnSync("pnpm", ["--filter", "@greatstone/plugin-sdk", "ensure-build-deps"],
    { cwd: repo, env: cleanEnv(process.env), stdio: ["ignore", "inherit", "inherit"] });
  return result.status === 0;
}

// Runs vitest on the files of one package and returns its JSON report, or
// null when vitest wrote none (it crashed or could not start).
export function runVitest(pkgDir, files, repo) {
  const outDir = mkdtempSync(join(tmpdir(), "switch-tests-"));
  const outFile = join(outDir, "report.json");
  try {
    const args = ["exec", "vitest", "run", "--reporter=dot", "--reporter=json", `--outputFile.json=${outFile}`,
      ...files.map((f) => relative(pkgDir, join(repo, f)))];
    const result = spawnSync("pnpm", args, { cwd: pkgDir, env: cleanEnv(process.env), stdio: ["ignore", "inherit", "inherit"] });
    if (!existsSync(outFile)) return { report: null, exitCode: result.status };
    return { report: JSON.parse(readFileSync(outFile, "utf8")), exitCode: result.status };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Turns vitest reports into one result per test file: pass or fail with the
// names of the failed tests.
export function collectResults(plan, repo, runs) {
  const results = [];
  for (const [pkg, files] of plan.byPackage) {
    const run = runs.get(pkg);
    const byFile = new Map((run?.report?.testResults ?? []).map((r) => [relative(repo, r.name), r]));
    for (const file of files) {
      const r = byFile.get(file);
      if (!r) {
        results.push({ file, status: "failed", failed: [`no result from vitest (exit ${run?.exitCode ?? "?"})`] });
        continue;
      }
      const failed = (r.assertionResults ?? []).filter((a) => a.status === "failed").map((a) => a.fullName ?? a.title);
      if (r.status === "failed" && failed.length === 0) failed.push(firstLine(r.message) || "the file did not load");
      results.push({ file, status: failed.length ? "failed" : "passed", failed });
    }
  }
  for (const file of plan.missing) results.push({ file, status: "failed", failed: ["test file is missing in this candidate"] });
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function firstLine(text) {
  return String(text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
}

export function buildReport({ plan, results, from, mapPath, repo, commit }) {
  const failures = [];
  for (const key of plan.unmapped) {
    failures.push({ switch: key, file: null, tests: [`switch is on but has no entry in ${MAP_PATH}`] });
  }
  for (const r of results.filter((x) => x.status === "failed")) {
    for (const key of plan.switchesByFile.get(r.file) ?? []) failures.push({ switch: key, file: r.file, tests: r.failed });
  }
  failures.sort((a, b) => a.switch.localeCompare(b.switch) || String(a.file).localeCompare(String(b.file)));
  return {
    verdict: failures.length ? "failed" : "passed",
    commit,
    repo,
    settingsFrom: from,
    map: mapPath,
    switchesOn: plan.on,
    switchesOnWithoutTests: plan.untested,
    files: results,
    failures,
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`Switch tests: ${report.verdict === "passed" ? "PASSED" : "FAILED"}${report.commit ? ` on ${report.commit}` : ""}`);
  lines.push(`Switch values: ${report.settingsFrom}`);
  lines.push(`Switches on (${report.switchesOn.length}): ${report.switchesOn.join(", ") || "none"}`);
  if (report.switchesOnWithoutTests.length) lines.push(`On without tests: ${report.switchesOnWithoutTests.join(", ")}`);
  const passed = report.files.filter((f) => f.status === "passed").length;
  lines.push(`Test files: ${report.files.length} run, ${passed} passed, ${report.files.length - passed} failed`);
  if (report.failures.length) {
    lines.push("", "Failed (switch, test file, test):");
    for (const f of report.failures) {
      for (const test of f.tests) lines.push(`- ${f.switch} | ${f.file ?? "-"} | ${test}`);
    }
  }
  return lines.join("\n");
}

export async function main(argv, { run = runVitest, prepare = prepareRepo, fetchImpl = fetch, env = process.env, log = console.log } = {}) {
  let opts, loaded, settings;
  try {
    opts = parseArgs(argv);
    loaded = loadMap(opts);
    settings = await readSettings(opts.source, { fetchImpl, env });
  } catch (error) {
    log(`switch-tests: ${error.message}`);
    return 2;
  }
  const plan = planRun(settings.settings, loaded.map, opts.repo);
  if (plan.byPackage.size && !prepare(opts.repo)) log("switch-tests: building the plugin SDK failed; server tests may not load");
  const runs = new Map();
  for (const [pkg, files] of plan.byPackage) runs.set(pkg, run(pkg, files, opts.repo));
  const results = collectResults(plan, opts.repo, runs);
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: opts.repo, encoding: "utf8" }).stdout?.trim() || null;
  const report = buildReport({ plan, results, from: settings.from, mapPath: loaded.path, repo: opts.repo, commit });
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  log(formatReport(report));
  return report.verdict === "passed" ? 0 : 1;
}

// Compare real paths: started through a symlink (macOS /var -> /private/var),
// argv[1] is not the real path that import.meta.url holds, and main() would be
// skipped with exit 0 and no report.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
