#!/usr/bin/env node
/**
 * native-install-smoke.mjs
 *
 * Starts GSAM the way an installed copy does (`pnpm dev:once --data-dir <dir>`,
 * exactly what the Mac app's background service runs), on a fresh data folder:
 *
 *   1. waits for /api/health (embedded PostgreSQL initialised and started),
 *   2. checks the UI answers on /,
 *   3. creates a company and an agent through the API,
 *   4. stops the whole process tree and checks nothing is left on the port,
 *   5. starts again on the same data folder and reads the company back
 *      (the database survived the stop and PostgreSQL started again),
 *   6. stops again.
 *
 * On Windows the stop is the stop a Windows service manager gives: the whole
 * tree ends at once (taskkill /T /F, see doc/plans/2026-11-25-gsam-for-windows.md),
 * so step 5 also proves PostgreSQL recovers from it. Elsewhere it is SIGTERM to
 * the dev runner, which stops its server and PostgreSQL in order.
 *
 * Used by .github/workflows/windows-ci.yml; runs on any OS:
 *   node scripts/native-install-smoke.mjs [--port 3197] [--data-dir <dir>]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3197" },
    "data-dir": { type: "string" },
    "start-timeout-sec": { type: "string", default: "900" },
  },
});
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;
const ownDataDir = !values["data-dir"];
const dataDir = values["data-dir"] ?? mkdtempSync(path.join(os.tmpdir(), "gsam-smoke-"));
const startTimeoutMs = Number(values["start-timeout-sec"]) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[smoke] ${message}`);

async function get(pathname) {
  try {
    const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(5000) });
    return response;
  } catch {
    return null;
  }
}

async function api(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function start() {
  log(`starting: pnpm dev:once --data-dir ${dataDir} (port ${port})`);
  // pnpm is a .cmd shim on Windows, which Node only runs through a shell; a
  // single command line (not an argument list) is what a shell takes.
  const child = isWindows
    ? spawn(`pnpm dev:once --data-dir "${dataDir}"`, { cwd: repoRoot, stdio: "inherit", shell: true, env: smokeEnv() })
    : spawn("pnpm", ["dev:once", "--data-dir", dataDir], { cwd: repoRoot, stdio: "inherit", env: smokeEnv() });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

function smokeEnv() {
  return {
    ...process.env,
    PORT: String(port),
    GSAM_TELEMETRY_DISABLED: "1",
    GSAM_OPEN_ON_LISTEN: "false",
  };
}

async function waitHealthy(server) {
  const deadline = Date.now() + startTimeoutMs;
  let early = null;
  server.exited.then((exit) => { early = exit; });
  while (Date.now() < deadline) {
    if (early) throw new Error(`server exited before it was healthy: ${JSON.stringify(early)}`);
    const response = await get("/api/health");
    if (response?.ok) return response.json();
    await sleep(2000);
  }
  if (isWindows) {
    // What is still running, and so what the start is stuck on.
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|postgres|pnpm|cargo|cmd' } | Format-Table -AutoSize -Wrap ProcessId,ParentProcessId,CommandLine | Out-String -Width 400"],
      { stdio: "inherit" },
    );
  }
  throw new Error(`no healthy /api/health within ${startTimeoutMs / 1000}s`);
}

async function stop(server) {
  const { child, exited } = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    // Already gone; nothing to stop.
  } else if (isWindows) {
    // No POSIX signals on Windows: end the whole tree (pnpm, tsx, the server,
    // embedded PostgreSQL) the way Task Scheduler or a service manager would.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "inherit" });
  } else {
    child.kill("SIGTERM");
  }
  const result = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
  if (result === "timeout") throw new Error("server did not exit within 60s of the stop");
  // The port must be free again: nothing of the tree may linger.
  const deadline = Date.now() + 30_000;
  while (await get("/api/health")) {
    if (Date.now() > deadline) throw new Error(`port ${port} still answers after the stop`);
    await sleep(1000);
  }
  log(`stopped (${JSON.stringify(result)}), port ${port} is free`);
}

// On failure: the end of every log the instance wrote, since the server logs
// to files under the data folder as well as to the console.
function printLogTails() {
  let files = [];
  try {
    files = readdirSync(dataDir, { recursive: true }).filter((name) => /\.log$/i.test(name));
  } catch {
    return;
  }
  for (const name of files) {
    try {
      const lines = readFileSync(path.join(dataDir, name), "utf8").trimEnd().split(/\r?\n/);
      console.error(`[smoke] ---- ${name} (last 80 of ${lines.length} lines) ----`);
      console.error(lines.slice(-80).join("\n"));
    } catch {
      // A log that cannot be read (still locked) is skipped.
    }
  }
}

let server = null;
try {
  server = start();
  const health = await waitHealthy(server);
  log(`healthy: ${JSON.stringify({ status: health.status, deploymentMode: health.deploymentMode, version: health.version })}`);

  const ui = await get("/");
  if (!ui?.ok) throw new Error(`UI did not answer on /: ${ui?.status}`);
  log(`UI answers on / (${ui.status})`);

  const company = await api("POST", "/api/companies", { name: `Windows smoke ${Date.now()}` });
  log(`created company ${company.id} (${company.issuePrefix})`);
  const agent = await api("POST", `/api/companies/${company.id}/agents`, {
    name: "Smoke agent",
    adapterType: "process",
    adapterConfig: { command: process.execPath, args: ["-e", ""], graceSec: 1 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  });
  log(`created agent ${agent.id}`);

  await stop(server);
  server = null;

  server = start();
  await waitHealthy(server);
  const companies = await api("GET", "/api/companies");
  if (!companies.some((row) => row.id === company.id)) throw new Error("company missing after restart");
  const agents = await api("GET", `/api/companies/${company.id}/agents`);
  if (!agents.some((row) => row.id === agent.id)) throw new Error("agent missing after restart");
  log("restart on the same data folder kept the company and agent");

  await stop(server);
  server = null;
  log("PASS");
} catch (error) {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  if (server) await stop(server).catch(() => undefined);
  printLogTails();
  process.exitCode = 1;
} finally {
  if (ownDataDir && process.exitCode !== 1) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
