import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  processGroupAlive,
  spawnInProcessGroup,
  stopProcessGroup,
  type GuardedProcess,
} from "./helpers/process-group.js";

// GRE-1642: the CLI e2e test left `gsam run` running after the test ended.
// These cover the three ways a test can end: teardown, the worker dying, and
// the command exiting on its own.

const isWindows = process.platform === "win32";
const helperPath = fileURLToPath(new URL("./helpers/process-group.ts", import.meta.url));
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// A server stand-in: starts a grandchild that ignores SIGTERM, prints its pid,
// then stays up (or exits at once with "exit").
const treeScript = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
console.log("grandchild " + grandchild.pid);
if (process.argv[1] === "exit") setTimeout(() => process.exit(0), 200);
else setInterval(() => {}, 1000);
`;

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

async function readGrandchildPid(stream: NodeJS.ReadableStream | null): Promise<number> {
  return await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`no grandchild pid in output: ${text}`)), 10_000);
    stream?.on("data", (chunk) => {
      text += String(chunk);
      const match = text.match(/grandchild (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
}

describe.skipIf(isWindows)("process group helper (GRE-1642)", () => {
  const started: GuardedProcess[] = [];
  const owners: ChildProcess[] = [];
  const pgids: number[] = [];

  afterEach(async () => {
    for (const owner of owners.splice(0)) owner.kill("SIGKILL");
    for (const child of started.splice(0)) await stopProcessGroup(child, 1_000);
    for (const pgid of pgids.splice(0)) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("stops the command and a grandchild that ignores SIGTERM", async () => {
    const child = spawnInProcessGroup(process.execPath, ["-e", treeScript], {
      env: { ...process.env, GSAM_GUARD_GRACE_MS: "500" },
    });
    started.push(child);
    const grandchildPid = await readGrandchildPid(child.stdout);
    expect(pidAlive(grandchildPid)).toBe(true);

    await stopProcessGroup(child, 5_000);

    expect(processGroupAlive(child.pid!)).toBe(false);
    expect(pidAlive(grandchildPid)).toBe(false);
  });

  it("stops the group when the process that started it is killed without teardown", async () => {
    const ownerScript = `
      import { spawnInProcessGroup } from ${JSON.stringify(helperPath)};
      const child = spawnInProcessGroup(process.execPath, ["-e", ${JSON.stringify(treeScript)}], {
        env: { ...process.env, GSAM_GUARD_GRACE_MS: "500" },
      });
      console.log("pgid " + child.pid);
      child.stdout.pipe(process.stdout);
    `;
    // Load tsx in this process (not the tsx CLI, which runs the script in a
    // second node process) so SIGKILL hits the process that holds the guard.
    const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", ownerScript], {
      cwd: cliRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    owners.push(owner);
    let text = "";
    owner.stdout?.on("data", (chunk) => {
      text += String(chunk);
    });
    const grandchildPid = await readGrandchildPid(owner.stdout);
    const pgid = Number(text.match(/pgid (\d+)/)?.[1]);
    expect(pgid).toBeGreaterThan(0);
    pgids.push(pgid);
    expect(processGroupAlive(pgid)).toBe(true);

    owner.kill("SIGKILL");

    expect(await waitFor(() => !processGroupAlive(pgid), 10_000)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(false);
  }, 30_000);

  it("kills what the command left behind when it exits on its own", async () => {
    const child = spawnInProcessGroup(process.execPath, ["-e", treeScript, "exit"]);
    started.push(child);
    const grandchildPid = await readGrandchildPid(child.stdout);

    expect(await waitFor(() => !processGroupAlive(child.pid!), 10_000)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(false);
  });
});
