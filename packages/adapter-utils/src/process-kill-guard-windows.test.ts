import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupGitHubOperationLaunchers, prepareGitHubOperationLaunchers } from "./execution-target.js";
import { processKillGuardPaths } from "./process-kill-guard.js";

// The Windows taskkill guard (process-kill-guard-windows.ts), against real processes.
const onWindows = process.platform === "win32";
const realTaskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
const started: ChildProcess[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill();
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A Node.js process that sleeps, with extra command line arguments. */
function sleeper(...args: string[]) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore", windowsHide: true });
  started.push(child);
  return child;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function stage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsam-guard-win-"));
  const live = path.join(root, "live");
  const own = path.join(live, "instances", "default", "workspaces", "agent-a");
  await mkdir(own, { recursive: true });
  const server = sleeper("fake-server");
  const runId = `guard-${randomUUID()}`;
  const env = await prepareGitHubOperationLaunchers({
    runId, target: null, cwd: own, env: { PATH: process.env.PATH ?? "" },
    processGuard: { protectedPaths: [live], serverPid: server.pid! },
  });
  cleanups.push(async () => {
    await cleanupGitHubOperationLaunchers({ runId, target: null });
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  // taskkill as an agent's cmd.exe or PowerShell finds it: through PATH and PATHEXT.
  const taskkill = (...args: string[]) =>
    spawnSync("cmd.exe", ["/d", "/c", "taskkill", ...args], { env: { ...process.env, PATH: env.PATH }, encoding: "utf8" });
  return { env, live, own, server, taskkill };
}

describe.runIf(onWindows)("Windows process kill guard paths", () => {
  it("never uses a drive root or the user profile (or above it) as a marker of live", () => {
    const home = os.homedir();
    const drive = path.parse(home).root;
    const { protectedPaths } = processKillGuardPaths({
      protectedPaths: [drive, home, path.dirname(home), "D:\\gsam-guard-test\\live", "relative\\live"],
      serverPid: 1,
    }, home);
    expect(protectedPaths).toEqual(["D:\\gsam-guard-test\\live"]);
  });
});

describe.runIf(onWindows)("Windows process kill guard against real processes", () => {
  it("is first on the run's PATH for cmd.exe and Git Bash", async () => {
    const { env } = await stage();
    const where = spawnSync("where.exe", ["taskkill"], { env: { ...process.env, PATH: env.PATH }, encoding: "utf8" });
    // cmd.exe runs only names with a PATHEXT extension (where.exe also lists the
    // extensionless Git Bash shim). Compared as real paths: Windows may spell the
    // temp folder in its short 8.3 form.
    const runnable = where.stdout.trim().split(/\r?\n/).find((line) => /\.(cmd|exe|bat|com)$/i.test(line))!;
    const first = realpathSync.native(runnable);
    expect(first.toLowerCase()).toBe(realpathSync.native(path.join(env.GSAM_GITHUB_LAUNCHER_DIR, "taskkill.cmd")).toLowerCase());
  });

  it("ends the agent's own process and leaves the server and live's processes alone", async () => {
    const { live, own, server, taskkill } = await stage();
    const liveChild = sleeper(path.join(live, "db"));
    const ownChild = sleeper(path.join(own, "dev-server.js"));
    const unrelated = sleeper("unrelated");
    await settle();

    const result = taskkill("/F", "/PID", String(server.pid), "/PID", String(liveChild.pid), "/PID", String(ownChild.pid), "/PID", String(unrelated.pid));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("left 2 matching process(es) alone");
    await settle();
    expect(running(ownChild.pid!)).toBe(false);
    expect(running(unrelated.pid!)).toBe(false);
    expect(running(server.pid!)).toBe(true);
    expect(running(liveChild.pid!)).toBe(true);

    // Planted failure: the real taskkill.exe, with no guard, does end live's process,
    // so the survival checked above is the guard's doing, not the test's.
    spawnSync(realTaskkill, ["/F", "/PID", String(liveChild.pid)]);
    await settle();
    expect(running(liveChild.pid!)).toBe(false);
  }, 30_000);

  it("with /T leaves a whole tree alone when live's process is in it", async () => {
    const { live, taskkill } = await stage();
    // A parent whose child names the live folder: ending the tree would end live's process.
    const parent = spawn(process.execPath, ["-e",
      `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(path.join(live, "db"))}], { stdio: "ignore" }); setInterval(() => {}, 1000)`],
    { stdio: "ignore", windowsHide: true });
    started.push(parent);
    await settle();

    const result = taskkill("/F", "/T", "/PID", String(parent.pid));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left 1 matching process(es) alone");
    expect(running(parent.pid!)).toBe(true);
    spawnSync(realTaskkill, ["/F", "/T", "/PID", String(parent.pid)]);
  }, 30_000);

  it("refuses options it cannot check, ending nothing", async () => {
    const { taskkill } = await stage();
    const victim = sleeper("victim");
    await settle();
    const result = taskkill("/F", "/FI", `PID eq ${victim.pid}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot safely translate");
    expect(running(victim.pid!)).toBe(true);
  }, 30_000);
});
