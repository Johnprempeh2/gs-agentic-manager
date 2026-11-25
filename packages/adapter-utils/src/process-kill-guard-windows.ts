import os from "node:os";
import { processKillGuardPaths, type ProcessKillGuard } from "./process-kill-guard.js";

/**
 * The Windows process kill guard: the same promise as the POSIX pkill/killall
 * wrappers in process-kill-guard.ts, for the command agents kill with on
 * Windows, `taskkill`. Three files go first on the run's PATH:
 *
 *   taskkill.cmd             cmd.exe and PowerShell (found through PATHEXT)
 *   taskkill                 Git Bash, which Claude Code's shell tool uses
 *   gsam-process-guard.cjs   the guard itself, run with the same Node.js
 *
 * The guard asks Windows for every process (Get-CimInstance Win32_Process),
 * works out what taskkill would end (by /PID or /IM, and with /T every
 * descendant), leaves live's processes alone and passes only the rest to the
 * real taskkill.exe, one /PID at a time. Live is: the server, every process
 * above it, and any process whose command line or executable lies in a
 * protected folder (outside the run's own workspace). With /T a target whose
 * tree holds a live process is left alone whole. When Windows cannot be asked,
 * nothing is ended.
 *
 * Limits, as on POSIX: it covers the command it wraps. PowerShell's
 * Stop-Process and direct Win32 calls are not wrapped.
 */

const GUARD_SOURCE = String.raw`// GSAM process guard, written by GS Agentic Manager for one agent run.
// Agents run as the same user as the live server, so a broad taskkill can stop
// live. This guard leaves live's processes alone and ends only the rest.
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const say = (text) => process.stderr.write("taskkill: " + text + "\n");
const real = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
const norm = (text) => String(text || "").replace(/\//g, "\\").toLowerCase();
const protectedDirs = CONFIG.protectedPaths.map(norm);
const exemptDirs = CONFIG.exemptPaths.map(norm);

function passThrough(args) {
  const result = spawnSync(real, args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

// taskkill takes /X and -X, any case.
const args = process.argv.slice(2);
let force = false;
let tree = false;
const pids = [];
const images = [];
for (let i = 0; i < args.length; i += 1) {
  const flag = /^[\/-]/.test(args[i]) ? "/" + args[i].slice(1).toUpperCase() : null;
  if (flag === "/F") force = true;
  else if (flag === "/T") tree = true;
  else if (flag === "/PID" || flag === "/IM") {
    const value = args[i + 1];
    if (value === undefined) passThrough(args);
    i += 1;
    if (flag === "/PID") {
      if (!/^\d+$/.test(value)) passThrough(args);
      pids.push(Number(value));
    } else images.push(value);
  } else if (flag === "/?") passThrough(args);
  else {
    // /FI filters, and /S /U /P (another computer), cannot be checked here.
    say("the GSAM process guard cannot safely translate '" + args[i] + "', so nothing was ended.");
    say("Use /PID or /IM (with /F and /T), or end the process by the PID you recorded when you started it.");
    process.exit(2);
  }
}
if (pids.length === 0 && images.length === 0) passThrough(args);

let processes;
try {
  const json = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  processes = [].concat(JSON.parse(json));
} catch {
  say("the GSAM process guard could not list processes to see what would be ended, so nothing was ended.");
  process.exit(3);
}
const byPid = new Map(processes.map((p) => [p.ProcessId, p]));
const children = new Map();
for (const p of processes) {
  if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
  children.get(p.ParentProcessId).push(p.ProcessId);
}

// The live server and every process above it.
const serverTree = new Set();
for (let pid = CONFIG.serverPid, i = 0; pid > 4 && i < 64 && byPid.has(pid) && !serverTree.has(pid); i += 1) {
  serverTree.add(pid);
  pid = byPid.get(pid).ParentProcessId;
}

// dir appears at text[at] as a whole folder name (not the start of a longer one).
function dirAt(text, at, dir) {
  if (text.substr(at, dir.length) !== dir) return false;
  const next = text.charAt(at + dir.length);
  return next === "" || !/[a-z0-9._-]/.test(next);
}

// Live owns pid when it is the server or above it, or when its command line or
// executable names a protected folder that is not the run's own workspace.
function isLive(pid) {
  if (serverTree.has(pid)) return true;
  const p = byPid.get(pid);
  if (!p) return false;
  const info = norm(p.CommandLine) + "\n" + norm(p.ExecutablePath);
  for (const dir of protectedDirs) {
    for (let at = info.indexOf(dir); at >= 0; at = info.indexOf(dir, at + 1)) {
      if (dirAt(info, at, dir) && !exemptDirs.some((own) => dirAt(info, at, own))) return true;
    }
  }
  return false;
}

function treeOf(pid) {
  const out = [];
  const stack = [pid];
  const seen = new Set();
  while (stack.length > 0) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const child of children.get(next) || []) stack.push(child);
  }
  return out;
}

const wildcard = (pattern) => new RegExp("^" + pattern.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
const imagePatterns = images.map(wildcard);
const targets = new Set(pids);
for (const p of processes) if (imagePatterns.some((re) => re.test(p.Name || ""))) targets.add(p.ProcessId);
targets.delete(process.pid);
targets.delete(process.ppid);

let live = 0;
let ended = 0;
let failed = false; // a target that taskkill itself could not end
for (const pid of targets) {
  if (!byPid.has(pid)) {
    say("ERROR: The process \"" + pid + "\" not found.");
    failed = true;
    continue;
  }
  if ((tree ? treeOf(pid) : [pid]).some(isLive)) {
    live += 1;
    continue;
  }
  const result = spawnSync(real, [...(force ? ["/F"] : []), ...(tree ? ["/T"] : []), "/PID", String(pid)], { stdio: "inherit" });
  if (result.status === 0) ended += 1;
  else failed = true;
}
if (live > 0) {
  say("GSAM guard: left " + live + " matching process(es) alone. They belong to the live GS Agentic Manager (its install or data folder, or the server and the processes that started it).");
  say("To stop your own sandbox, run \"pnpm dev:stop --data-dir <the --data-dir you started it with>\" from your worktree root, or end the PID you recorded when you started it.");
}
// As taskkill: 0 when something was ended, 128 when nothing matched.
process.exit(ended > 0 ? 0 : live > 0 || failed ? 1 : 128);
`;

/** The guard files for a Windows run's launcher directory. */
export function windowsProcessKillGuardFiles(guard: ProcessKillGuard, homeDir = os.homedir()): Record<string, string> {
  const { protectedPaths, exemptPaths } = processKillGuardPaths(guard, homeDir);
  const serverPid = Number.isSafeInteger(guard.serverPid) && guard.serverPid > 4 ? guard.serverPid : 0;
  const config = JSON.stringify({ protectedPaths, exemptPaths, serverPid });
  return {
    "gsam-process-guard.cjs": `"use strict";\nconst CONFIG = ${config};\n${GUARD_SOURCE}`,
    "taskkill.cmd": `@"${process.execPath}" "%~dp0gsam-process-guard.cjs" %*\r\n`,
    // Git Bash: an extensionless script on PATH. The Node.js path is in single quotes.
    taskkill: `#!/bin/sh\n# GSAM process guard\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$(dirname "$0")/gsam-process-guard.cjs" "$@"\n`,
  };
}
