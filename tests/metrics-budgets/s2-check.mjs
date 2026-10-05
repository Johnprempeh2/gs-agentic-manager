// S2 page-load check before merge (GRE-501). Keystone runs it on pull requests
// that `s2-paths.mjs` flags; nothing runs it automatically per PR.
//
//   pnpm test:metrics:s2                      # build UI, measure in ./tmp sandbox, check budgets
//   pnpm test:metrics:s2 --skip-build         # UI already built from this checkout
//   pnpm test:metrics:s2 --metrics <file>     # only check an existing metrics.json
//   pnpm test:metrics:s2 --budgets <file>     # judge against another calibration
//
// Measures issue detail (warm and cold) and board cold open, 20 samples each,
// unthrottled, on a fresh seeded instance whose data lives in ./tmp/s2-check-*
// and is removed afterwards. Exits 1 with a one-line reason when over budget,
// or when the report is over 6 hours old or undated (GRE-837).
// Budgets default to budgets.keystone-host.json, calibrated on the machine
// Keystone runs on; budgets.json is the Apple-silicon calibration.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkBudgets, formatMeasured } from "./check.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_METRICS = "test-results/issue-detail-perf/metrics.json";
const DEFAULT_BUDGETS = "tests/metrics-budgets/budgets.keystone-host.json";

const LABELS = {
  "s2-issue-cold-p95-unthrottled": "issue detail cold open p95",
  "s2-issue-warm-p95-unthrottled": "issue detail warm open p95",
  "s2-board-cold-p95-unthrottled": "board cold open p95",
  "s2-issue-cold-median-unthrottled": "issue detail cold open median",
  "s2-issue-warm-median-unthrottled": "issue detail warm open median",
  "s2-board-cold-median-unthrottled": "board cold open median",
};

export function s2Budgets(config) {
  return { ...config, budgets: config.budgets.filter((budget) => budget.group === "ci" && budget.input === "s2") };
}

export function summarize({ ok, results }) {
  const rows = results.map((r) => {
    const label = LABELS[r.id] ?? r.id;
    const value = typeof r.value === "number" ? `${r.value} ms` : "n/a";
    return `  ${r.status === "pass" ? "ok  " : "OVER"} ${label}: ${value} (limit ${r.limit} ms${r.status === "pass" ? "" : `; ${r.reason}`})`;
  });
  const failed = results.filter((r) => r.status !== "pass").map((r) => LABELS[r.id] ?? r.id);
  const verdict = ok
    ? "S2 page-load check: PASS (within budget)"
    : `S2 page-load check: FAIL - over budget or not measured: ${failed.join(", ") || "no S2 budgets selected"}`;
  const measured = results[0] ? formatMeasured(results[0]) : "unknown";
  const stale = results.some((r) => r.stale) ? "  STALE: this report is too old or undated; measure again." : null;
  return [verdict, ...rows, `  measured: ${results[0]?.measuredAt ?? "unknown"} (${measured})`, stale].filter(Boolean).join("\n");
}

// One report line naming the machine that took the numbers and its load, plus a
// NOTE when it is not the machine the budgets were calibrated on or is busier
// than it was then (GRE-894). Text only; the exit code does not change.
export function hostLines(host, recorded) {
  const calibrated = recorded
    ? `${recorded.label ?? `${recorded.platform} ${recorded.arch}`}${recorded.loadAvg1m ? `, load ${recorded.loadAvg1m.join("-")}` : ""}`
    : "not recorded";
  if (!host) return [`  host: not recorded (budgets calibrated on: ${calibrated})`];
  const load = (n) => (typeof n === "number" ? n.toFixed(1) : "?");
  const lines = [`  host: ${host.platform} ${host.arch}, ${host.cpus} cpu, load ${load(host.loadAvg1mStart)}→${load(host.loadAvg1mEnd)} (budgets calibrated on: ${calibrated})`];
  if (recorded && (host.platform !== recorded.platform || host.arch !== recorded.arch)) {
    lines.push(`  NOTE: measured on ${host.platform} ${host.arch}, but these budgets are for ${recorded.platform} ${recorded.arch}; a FAIL may be the machine, not a regression.`);
  }
  const peak = Math.max(...[host.loadAvg1mStart, host.loadAvg1mEnd].filter((n) => typeof n === "number"));
  const ceiling = recorded?.loadAvg1m?.[1];
  if (typeof ceiling === "number" && peak > ceiling) {
    lines.push(`  NOTE: load ${peak.toFixed(1)} is above the calibrated range (${recorded.loadAvg1m.join("-")}); a FAIL may be a busy host, not a regression.`);
  }
  return lines;
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return result.status === 0;
}

// Agent runs get a fresh HOME and the host may lack Chromium's system
// libraries (WSL has no libnss3). Install the browser, then fetch any missing
// library into ./tmp/chromium-libs without root, so Keystone needs no setup.
const LIB_PACKAGES = {
  "libnspr4.so": ["libnspr4"],
  "libnss3.so": ["libnss3"],
  "libnssutil3.so": ["libnss3"],
  "libsmime3.so": ["libnss3"],
  "libasound.so.2": ["libasound2t64", "libasound2"],
};

function headlessShell() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const dir = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith("chromium_headless_shell-")).sort().pop() : undefined;
  const binary = dir && join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
  return binary && existsSync(binary) ? binary : undefined;
}

function missingLibs(binary, env) {
  const output = execFileSync("ldd", [binary], { encoding: "utf8", env: { ...process.env, ...env } });
  return [...output.matchAll(/^\s*(\S+) => not found/gm)].map((match) => match[1]);
}

function prepareBrowser() {
  if (!run("pnpm", ["exec", "playwright", "install", "--only-shell", "chromium"])) throw new Error("could not install Playwright Chromium");
  const binary = process.platform === "linux" ? headlessShell() : undefined;
  if (!binary) return {};
  const libRoot = resolve(ROOT, "tmp", "chromium-libs");
  const libDir = join(libRoot, "root", "usr", "lib", "x86_64-linux-gnu");
  const env = { LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  let missing = missingLibs(binary, env);
  if (missing.length === 0) return env;
  const unknown = missing.filter((lib) => !LIB_PACKAGES[lib]);
  if (unknown.length) throw new Error(`Chromium needs ${unknown.join(", ")}; ask John to run \`sudo pnpm exec playwright install-deps chromium\` once`);
  mkdirSync(join(libRoot, "debs"), { recursive: true });
  for (const options of new Set(missing.map((lib) => LIB_PACKAGES[lib]))) {
    const fetched = options.some((name) => spawnSync("apt-get", ["download", name], { cwd: join(libRoot, "debs"), stdio: "ignore" }).status === 0);
    if (!fetched) throw new Error(`could not download ${options.join(" or ")} for Chromium`);
  }
  for (const deb of readdirSync(join(libRoot, "debs")).filter((name) => name.endsWith(".deb"))) {
    execFileSync("dpkg-deb", ["-x", join(libRoot, "debs", deb), join(libRoot, "root")]);
  }
  missing = missingLibs(binary, env);
  if (missing.length) throw new Error(`Chromium still misses ${missing.join(", ")}`);
  return env;
}

async function measure({ skipBuild }) {
  const browserEnv = prepareBrowser();
  if (!skipBuild && !run("pnpm", ["--filter", "@greatstone/ui", "build"])) {
    throw new Error("UI build failed; the page cannot be timed");
  }
  const sandbox = resolve(ROOT, "tmp", `s2-check-${Date.now()}`);
  try {
    const ok = run("pnpm", ["perf:issue-detail"], {
      ...browserEnv,
      GSAM_ISSUE_PERF_HOME: sandbox,
      GSAM_ISSUE_PERF_PORT: String(await freePort()),
      GSAM_ISSUE_PERF_RUNS: process.env.GSAM_ISSUE_PERF_RUNS ?? "20",
      GSAM_ISSUE_PERF_PROFILES: "unthrottled",
    });
    if (!ok) throw new Error("the S2 harness did not finish; see the Playwright output above");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const metrics = flag("metrics");
  const budgets = flag("budgets") ?? DEFAULT_BUDGETS;
  try {
    if (!metrics) await measure({ skipBuild: argv.includes("--skip-build") });
    const config = JSON.parse(readFileSync(resolve(ROOT, budgets), "utf8"));
    const outcome = checkBudgets(s2Budgets(config), { group: "ci", inputs: { s2: metrics ?? DEFAULT_METRICS }, root: ROOT });
    console.log(summarize(outcome));
    const report = (() => {
      try { return JSON.parse(readFileSync(resolve(ROOT, metrics ?? DEFAULT_METRICS), "utf8")); } catch { return {}; }
    })();
    console.log(hostLines(report.host, config.baselineRecorded?.host).join("\n"));
    console.log(`  budgets: ${budgets}`);
    process.exitCode = outcome.ok ? 0 : 1;
  } catch (error) {
    console.error(`S2 page-load check: FAIL - ${error.message}`);
    process.exitCode = 1;
  }
}
