import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@greatstone/db";
import { PARENT_RUN_API_URL_ENV_KEY, scrubAgentRunEnvForServer } from "@greatstone/shared/agent-run-env";
import { toLegacyEnvKey, withLegacyEnvAliases } from "@greatstone/shared/legacy-env";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  apiUrlPort,
  cleanupRunLeftoverProcesses,
  mentionsPath,
  parseRunMarker,
  runProcessCleanupEnabled,
  selectRunEndLeftovers,
  selectSweepLeftovers,
  shortCommand,
  sweepLeftoverRunProcesses,
  type ObservedProcess,
  type ProcessProtection,
} from "./run-process-cleanup.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const UID = 1000;
const SERVER = 500;
const API = "http://127.0.0.1:3100";
// A sandbox an agent started from its worktree, on the next free port.
const SANDBOX_API = "http://127.0.0.1:3101";
const WORKTREE = "/home/agent/code/gs-clip/.gsam/worktrees/GRE-504-storybook";
// The legacy aliases every agent environment also carries.
const LEGACY_RUN_ID = toLegacyEnvKey("GSAM_RUN_ID");
const LEGACY_API_URL = toLegacyEnvKey("GSAM_API_URL");

const protection: ProcessProtection = {
  uid: UID,
  serverPid: SERVER,
  protectedPaths: ["/home/agent/GSAM/live", "/home/agent/GSAM/data", "/home/agent/GSAM"],
  servicePids: [700],
  serviceGroupIds: [700],
};

let nextPid = 1000;
function proc(overrides: Partial<ObservedProcess> & { runId?: string | null; apiUrl?: string | null } = {}): ObservedProcess {
  const { runId = RUN, apiUrl = API, ...rest } = overrides;
  const pid = rest.pid ?? nextPid++;
  return {
    pid,
    ppid: 1,
    pgid: pid,
    uid: UID,
    state: "S",
    hasTty: false,
    startTicks: "12345",
    ageMs: 60 * 60_000,
    args: ["node", "storybook/dist/bin/dispatcher.js", "dev", "-p", "39581"],
    exe: "/usr/bin/node",
    cwd: WORKTREE,
    cwdDeleted: false,
    marker: { runId, conflicting: false, apiUrl },
    ...rest,
  };
}

/** The live server and the chain that started it. */
function serverTree(): ObservedProcess[] {
  return [
    proc({ pid: 400, ppid: 1, runId: null, args: ["sh", "-c", "pnpm dev:once"], cwd: "/home/agent/somewhere" }),
    proc({ pid: 450, ppid: 400, runId: null, args: ["pnpm"], cwd: "/home/agent/somewhere" }),
    proc({ pid: SERVER, ppid: 450, runId: null, args: ["node", "src/index.ts"], cwd: "/home/agent/somewhere" }),
  ];
}

const pids = (selection: { targets: Array<{ process: ObservedProcess }> }) =>
  selection.targets.map((target) => target.process.pid).sort((a, b) => a - b);

describe("parseRunMarker", () => {
  it("reads the run id and API URL and nothing else", () => {
    const marker = parseRunMarker(
      `PATH=/usr/bin\0GSAM_RUN_ID=${RUN}\0${LEGACY_RUN_ID}=${RUN}\0GSAM_API_KEY=secret\0GSAM_API_URL=${API}\0`,
    );
    expect(marker).toEqual({ runId: RUN, conflicting: false, apiUrl: API });
  });

  it("falls back to the legacy names", () => {
    expect(parseRunMarker(`${LEGACY_RUN_ID}=${RUN}\0${LEGACY_API_URL}=${API}`)).toEqual({
      runId: RUN,
      conflicting: false,
      apiUrl: API,
    });
  });

  it("flags two different run ids and reports none when unset", () => {
    expect(parseRunMarker(`GSAM_RUN_ID=${RUN}\0${LEGACY_RUN_ID}=${OTHER_RUN}`).conflicting).toBe(true);
    expect(parseRunMarker("PATH=/usr/bin\0HOME=/home/agent")).toEqual({ runId: null, conflicting: false, apiUrl: null });
  });

  it("reads a sandbox's marker: the run id it kept and the parent URL it recorded, over its own URL", () => {
    const marker = parseRunMarker(
      `GSAM_RUN_ID=${RUN}\0${LEGACY_RUN_ID}=${RUN}\0GSAM_API_URL=${SANDBOX_API}\0${PARENT_RUN_API_URL_ENV_KEY}=${API}\0`,
    );
    expect(marker).toEqual({ runId: RUN, conflicting: false, apiUrl: API });
  });
});

/** The environment an agent's shell has: its run marker, URL, key and context (fake values). */
function agentShellEnv(runId: string, apiUrl: string): Record<string, string> {
  return withLegacyEnvAliases({
    PATH: "/usr/bin:/bin",
    GSAM_RUN_ID: runId,
    GSAM_API_URL: apiUrl,
    GSAM_API_KEY: "fake-agent-key",
    GSAM_AGENT_ID: "fake-agent",
    GSAM_COMPANY_ID: "fake-company",
    GSAM_TASK_ID: "fake-task",
    GSAM_GIT_TOKEN: "fake-git-token",
  });
}

/** The same environment after a sandbox server scrubbed it (packages/shared/src/agent-run-env.ts). */
function scrubbedSandboxEnv(runId: string, apiUrl: string, ownApiUrl?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = agentShellEnv(runId, apiUrl);
  scrubAgentRunEnvForServer(env);
  // Once it listens, the sandbox server sets GSAM_API_URL to its own URL, and
  // what it starts afterwards (its database, plugin workers) inherits that.
  if (ownApiUrl) env.GSAM_API_URL = ownApiUrl;
  return env;
}

const environOf = (env: Record<string, string | undefined>) =>
  Object.entries(env)
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]))
    .join("\0");

describe("helpers", () => {
  it("reads the port of an API URL", () => {
    expect(apiUrlPort("http://127.0.0.1:3100")).toBe(3100);
    expect(apiUrlPort("https://gsam.example.ts.net")).toBe(443);
    expect(apiUrlPort("not a url")).toBeNull();
    expect(apiUrlPort(null)).toBeNull();
  });

  it("matches a protected path only at a path boundary, like the pkill guard", () => {
    expect(mentionsPath("/home/agent/GSAM/live/node_modules/x.js", "/home/agent/GSAM/live")).toBe(true);
    expect(mentionsPath("/home/agent/GSAM/live", "/home/agent/GSAM/live")).toBe(true);
    expect(mentionsPath("/home/agent/GSAM/live2/x", "/home/agent/GSAM/live")).toBe(false);
    expect(mentionsPath("/home/agent/GSAM/live-old/x", "/home/agent/GSAM/live")).toBe(false);
  });

  it("is on unless GSAM_RUN_PROCESS_CLEANUP turns it off", () => {
    expect(runProcessCleanupEnabled({})).toBe(true);
    expect(runProcessCleanupEnabled({ GSAM_RUN_PROCESS_CLEANUP: "true" })).toBe(true);
    for (const off of ["false", "0", "off", "no", " FALSE "]) {
      expect(runProcessCleanupEnabled({ GSAM_RUN_PROCESS_CLEANUP: off })).toBe(false);
    }
  });

  it("redacts and shortens the command it logs", () => {
    const text = shortCommand(["curl", "-H", "Authorization: Bearer abcdefghijklmnop", "http://x"]);
    expect(text).not.toContain("abcdefghijklmnop");
    expect(shortCommand(["x".repeat(400)]).length).toBe(160);
  });
});

describe("selectRunEndLeftovers", () => {
  it("selects the processes that carry the run's marker, orphaned or not", () => {
    const storybook = proc({ pid: 2001 });
    const esbuild = proc({ pid: 2002, ppid: 2001, args: ["esbuild", "--service"] });
    const selection = selectRunEndLeftovers([...serverTree(), storybook, esbuild], { runId: RUN, protection });
    expect(pids(selection)).toEqual([2001, 2002]);
    expect(selection.targets.every((target) => target.reason === "run_ended" && target.runId === RUN)).toBe(true);
  });

  it("leaves other runs' processes and unmarked processes alone", () => {
    const selection = selectRunEndLeftovers(
      [...serverTree(), proc({ pid: 2101, runId: OTHER_RUN }), proc({ pid: 2102, runId: null })],
      { runId: RUN, protection },
    );
    expect(pids(selection)).toEqual([]);
  });

  it("leaves a process alone when its environment cannot be read or its markers disagree", () => {
    const selection = selectRunEndLeftovers(
      [
        ...serverTree(),
        proc({ pid: 2201, marker: null }),
        proc({ pid: 2202, marker: { runId: RUN, conflicting: true, apiUrl: API } }),
      ],
      { runId: RUN, protection },
    );
    expect(pids(selection)).toEqual([]);
  });

  it("never selects the server, the processes above it or the processes it still parents", () => {
    const tree = serverTree().map((entry) => ({ ...entry, marker: { runId: RUN, conflicting: false, apiUrl: API } }));
    // A warm ACP session and its shell are still the server's children.
    const warmAgent = proc({ pid: 2301, ppid: SERVER, args: ["node", "/opt/agent-acp/index.js"] });
    const agentShell = proc({ pid: 2302, ppid: 2301, args: ["bash", "-c", "pnpm storybook"] });
    const selection = selectRunEndLeftovers([...tree, warmAgent, agentShell], { runId: RUN, protection });
    expect(pids(selection)).toEqual([]);
    expect(selection.protectedMatches).toBe(5);
  });

  it("never selects anything from live's install or data, or the GSAM root (preview)", () => {
    const selection = selectRunEndLeftovers(
      [
        ...serverTree(),
        proc({ pid: 2401, args: ["node", "/home/agent/GSAM/live/node_modules/.bin/tsx", "x"] }),
        proc({ pid: 2402, exe: "/home/agent/GSAM/live/node_modules/.pnpm/postgres/bin/postgres", args: ["postgres"] }),
        proc({ pid: 2403, cwd: "/home/agent/GSAM/data/instances/default/projects/p1" }),
        proc({ pid: 2404, cwd: "/home/agent/GSAM/preview/code", args: ["pnpm", "dev:once"] }),
        proc({ pid: 2405, args: ["node", "/home/agent/GSAM-old/live/x.js"], cwd: "/tmp" }),
      ],
      { runId: RUN, protection },
    );
    expect(pids(selection)).toEqual([2405]);
    expect(selection.protectedMatches).toBe(4);
  });

  it("never selects a workspace runtime service or what it started", () => {
    const selection = selectRunEndLeftovers(
      [
        ...serverTree(),
        proc({ pid: 700, pgid: 700, args: ["sh", "-lc", "pnpm dev"] }),
        proc({ pid: 701, ppid: 700, pgid: 700, args: ["node", "vite"] }),
        proc({ pid: 702, ppid: 1, pgid: 700, args: ["node", "worker"] }),
      ],
      { runId: RUN, protection },
    );
    expect(pids(selection)).toEqual([]);
    expect(selection.protectedMatches).toBe(3);
  });

  it("skips other users' processes, zombies and init", () => {
    const selection = selectRunEndLeftovers(
      [...serverTree(), proc({ pid: 2501, uid: 0 }), proc({ pid: 2502, state: "Z" }), proc({ pid: 1 })],
      { runId: RUN, protection },
    );
    expect(pids(selection)).toEqual([]);
  });
});

describe("selectSweepLeftovers", () => {
  const sweep = (processes: ObservedProcess[], overrides: Partial<Parameters<typeof selectSweepLeftovers>[1]> = {}) =>
    selectSweepLeftovers([...serverTree(), ...processes], {
      endedRunIds: new Set([RUN]),
      apiPort: 3100,
      protection,
      ...overrides,
    });

  it("selects processes of runs of this instance that ended", () => {
    const selection = sweep([proc({ pid: 3001 }), proc({ pid: 3002, runId: OTHER_RUN })]);
    expect(pids(selection)).toEqual([3001]);
    expect(selection.targets[0]?.reason).toBe("ended_run_marker");
  });

  it("needs the marker's API URL to point at this server's port", () => {
    expect(pids(sweep([proc({ pid: 3101, apiUrl: "http://127.0.0.1:3101" })]))).toEqual([]);
    expect(pids(sweep([proc({ pid: 3102, apiUrl: null })]))).toEqual([]);
    expect(pids(sweep([proc({ pid: 3103 })], { apiPort: null }))).toEqual([]);
  });

  it("keeps a run's processes while the run is queued or running (not in the ended set)", () => {
    expect(pids(sweep([proc({ pid: 3201 })], { endedRunIds: new Set() }))).toEqual([]);
  });

  it("stops unmarked orphans whose deleted worktree they still run in, with their children", () => {
    const storybook = proc({ pid: 3301, runId: null, cwdDeleted: true });
    const esbuild = proc({ pid: 3302, ppid: 3301, runId: null, cwdDeleted: true, args: ["esbuild"] });
    const selection = sweep([storybook, esbuild]);
    expect(pids(selection)).toEqual([3301, 3302]);
    expect(selection.targets.every((target) => target.reason === "deleted_worktree")).toBe(true);
  });

  it("leaves deleted-worktree processes alone unless all the conditions hold", () => {
    const selection = sweep([
      // Still a child of something else (an editor's language server).
      proc({ pid: 3401, ppid: 3400, runId: null, cwdDeleted: true }),
      proc({ pid: 3400, ppid: 1, runId: null, cwd: "/home/agent/.vscode-server" }),
      // Has a terminal (someone's shell).
      proc({ pid: 3402, runId: null, cwdDeleted: true, hasTty: true }),
      // Too young.
      proc({ pid: 3403, runId: null, cwdDeleted: true, ageMs: 60_000 }),
      // The working directory still exists.
      proc({ pid: 3404, runId: null, cwdDeleted: false }),
      // Deleted, but not a task worktree.
      proc({ pid: 3405, runId: null, cwdDeleted: true, cwd: "/tmp/some-dir" }),
      // The environment cannot be read.
      proc({ pid: 3406, marker: null, cwdDeleted: true }),
      // Marked with a run that is still running: the marker decides.
      proc({ pid: 3407, runId: OTHER_RUN, cwdDeleted: true }),
    ]);
    expect(pids(selection)).toEqual([]);
  });

  it("keeps the same exclusions as the end of a run", () => {
    const selection = sweep([
      proc({ pid: 3501, args: ["node", "/home/agent/GSAM/live/server/x.js"] }),
      proc({ pid: 3502, ppid: SERVER }),
      proc({ pid: 3503, runId: null, cwdDeleted: true, args: ["node", "/home/agent/GSAM/preview/x.js"] }),
    ]);
    expect(pids(selection)).toEqual([]);
    expect(selection.protectedMatches).toBe(3);
  });
});

// A sandbox an agent started (`pnpm dev:once --data-dir ./tmp/sandbox`) and
// left running. The dev runner keeps the agent's environment as it was started
// with (a process's /proc environ never changes); the server, its pnpm wrapper
// and its database get the scrubbed environment.
describe("a sandbox started from an agent run", () => {
  const sandboxTree = () => [
    proc({ pid: 5001, ppid: 1, marker: parseRunMarker(environOf(agentShellEnv(RUN, API))), args: ["node", "tsx", "../scripts/dev-runner.ts", "dev", "--data-dir", "./tmp/sandbox"] }),
    proc({ pid: 5002, ppid: 5001, marker: parseRunMarker(environOf(scrubbedSandboxEnv(RUN, API))), args: ["pnpm", "--filter", "@greatstone/server", "dev"] }),
    proc({ pid: 5003, ppid: 5002, marker: parseRunMarker(environOf(scrubbedSandboxEnv(RUN, API))), args: ["node", "tsx", "src/index.ts"] }),
    proc({ pid: 5004, ppid: 5003, marker: parseRunMarker(environOf(scrubbedSandboxEnv(RUN, API, SANDBOX_API))), args: ["postgres", "-D", "./tmp/sandbox/db"] }),
  ];

  it("is still stopped at the end of the run that started it", () => {
    const selection = selectRunEndLeftovers([...serverTree(), ...sandboxTree()], { runId: RUN, protection });
    expect(pids(selection)).toEqual([5001, 5002, 5003, 5004]);
  });

  it("is still stopped by the parent server's sweep once that run has ended", () => {
    const selection = selectSweepLeftovers([...serverTree(), ...sandboxTree()], {
      endedRunIds: new Set([RUN]),
      apiPort: 3100,
      protection,
    });
    expect(pids(selection)).toEqual([5001, 5002, 5003, 5004]);
  });

  it("is never claimed by another server's sweep, the sandbox's own included", () => {
    for (const apiPort of [3101, 3200]) {
      const selection = selectSweepLeftovers([...serverTree(), ...sandboxTree()], {
        endedRunIds: new Set([RUN]),
        apiPort,
        protection,
      });
      expect(pids(selection)).toEqual([]);
    }
  });
});

// Real processes: detached, setsid'd children carrying fake run markers, and
// controls that must survive. Each marker is a fresh random run id, so the
// cleanup can only ever match processes these tests started, and every PID a
// test starts is stopped afterwards by that exact PID (checked against its
// start time first).
const onLinux = process.platform === "linux";
const startedProcesses: Array<{ pid: number; startTicks: string }> = [];
const tempDirs: string[] = [];

function readStatFields(pid: number): string[] | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** Alive and not a zombie. */
function alive(pid: number): boolean {
  const fields = readStatFields(pid);
  return !!fields && fields[0] !== "Z";
}

async function stopStartedProcesses() {
  for (const { pid, startTicks } of startedProcesses.splice(0)) {
    if (readStatFields(pid)?.[19] !== startTicks) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsam-leftover-test-"));
  tempDirs.push(dir);
  return dir;
}

function markedEnv(runId: string | null, apiUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GSAM_RUN_ID", LEGACY_RUN_ID, "GSAM_API_URL", LEGACY_API_URL, PARENT_RUN_API_URL_ENV_KEY]) delete env[key];
  if (runId) {
    env.GSAM_RUN_ID = runId;
    env[LEGACY_RUN_ID] = runId;
  }
  if (apiUrl) {
    env.GSAM_API_URL = apiUrl;
    env[LEGACY_API_URL] = apiUrl;
  }
  return env;
}

/**
 * A sandbox server's environment: an agent shell's (fake key and context
 * added) scrubbed as the dev runner and `gsam run` do, optionally with the
 * sandbox's own GSAM_API_URL set afterwards.
 */
function sandboxEnv(runId: string, apiUrl: string, ownApiUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...markedEnv(runId, apiUrl),
    ...withLegacyEnvAliases({ GSAM_API_KEY: "fake-agent-key", GSAM_AGENT_ID: randomUUID(), GSAM_TASK_ID: randomUUID() }),
  };
  scrubAgentRunEnvForServer(env);
  if (ownApiUrl) env.GSAM_API_URL = ownApiUrl;
  return env;
}

/**
 * Starts `command` in a new session through a shell that exits at once, so the
 * process is reparented away from this test (as an agent's background server
 * is), and returns its PID.
 */
async function startOrphan(dir: string, name: string, env: NodeJS.ProcessEnv, command: string): Promise<number> {
  const pidFile = path.join(dir, `${name}.pid`);
  const child = spawn(
    "sh",
    ["-c", `setsid sh -c 'echo $$ > "$1"; exec ${command}' sh "${pidFile}" </dev/null >/dev/null 2>&1 &`],
    { cwd: dir, env, stdio: "ignore" },
  );
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 20));
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  const startTicks = readStatFields(pid)?.[19];
  if (startTicks) startedProcesses.push({ pid, startTicks });
  // Wait until the exec has happened.
  for (let i = 0; i < 100; i += 1) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sh\0")) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return pid;
}

describe.skipIf(!onLinux)("cleanupRunLeftoverProcesses on Linux", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await stopStartedProcesses();
  });

  it("stops only the processes that carry the ended run's marker", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
    const dir = await makeTempDir();
    const runId = randomUUID();
    const marked = await startOrphan(dir, "marked", markedEnv(runId), "sleep 600");
    // Ignores SIGTERM, so the cleanup has to escalate to SIGKILL.
    const script = path.join(dir, "stubborn.js");
    const ready = path.join(dir, "stubborn.ready");
    await writeFile(
      script,
      `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1"); setInterval(() => {}, 1000);\n`,
    );
    const stubborn = await startOrphan(dir, "stubborn", markedEnv(runId), `"${process.execPath}" "${script}"`);
    for (let i = 0; i < 250 && !existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(ready)).toBe(true);
    const unmarked = await startOrphan(dir, "unmarked", markedEnv(null), "sleep 600");
    const otherRun = await startOrphan(dir, "other", markedEnv(randomUUID()), "sleep 600");

    // Detached, in its own session, no longer this test's child, and marked.
    const stat = readStatFields(marked)!;
    expect(Number(stat[1])).not.toBe(process.pid);
    expect(Number(stat[3])).toBe(marked);
    expect(readFileSync(`/proc/${marked}/environ`, "utf8")).toContain(`GSAM_RUN_ID=${runId}`);

    const result = await cleanupRunLeftoverProcesses({ runId, graceMs: 1_500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    const outcomes = Object.fromEntries(result.stopped.map((entry) => [entry.pid, entry.outcome]));
    expect(outcomes[marked]).toBe("terminated");
    expect(outcomes[stubborn]).toBe("killed");
    expect(Object.keys(outcomes).map(Number).sort()).toEqual([marked, stubborn].sort());

    for (let i = 0; i < 50 && (alive(marked) || alive(stubborn)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(marked)).toBe(false);
    expect(alive(stubborn)).toBe(false);
    expect(alive(unmarked)).toBe(true);
    expect(alive(otherRun)).toBe(true);
  });

  it("stops a sandbox started from the ended run, after it dropped the run's variables", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
    const dir = await makeTempDir();
    const runId = randomUUID();
    // Fake ports, never live's: these are real processes.
    const parentApi = "http://127.0.0.1:45677";
    const server = await startOrphan(dir, "sandbox-server", sandboxEnv(runId, parentApi), "sleep 600");
    const database = await startOrphan(dir, "sandbox-db", sandboxEnv(runId, parentApi, "http://127.0.0.1:45678"), "sleep 600");

    const keys = readFileSync(`/proc/${server}/environ`, "utf8")
      .split("\0")
      .map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(keys).toContain("GSAM_RUN_ID");
    expect(keys).toContain(PARENT_RUN_API_URL_ENV_KEY);
    for (const gone of ["GSAM_API_KEY", "GSAM_API_URL", "GSAM_AGENT_ID", "GSAM_TASK_ID"]) {
      expect(keys).not.toContain(gone);
      expect(keys).not.toContain(toLegacyEnvKey(gone));
    }

    const result = await cleanupRunLeftoverProcesses({ runId, graceMs: 1_500 });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.stopped.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([server, database].sort((a, b) => a - b));
    for (let i = 0; i < 50 && (alive(server) || alive(database)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(server)).toBe(false);
    expect(alive(database)).toBe(false);
  });

  it("does nothing when GSAM_RUN_PROCESS_CLEANUP=false", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "false");
    const dir = await makeTempDir();
    const runId = randomUUID();
    const marked = await startOrphan(dir, "marked", markedEnv(runId), "sleep 600");
    expect(await cleanupRunLeftoverProcesses({ runId, graceMs: 500 })).toEqual({ status: "disabled" });
    expect(alive(marked)).toBe(true);
  });
});

const embeddedPostgresSupport = onLinux ? await getEmbeddedPostgresTestSupport() : { supported: false };

describe.skipIf(!onLinux || !embeddedPostgresSupport.supported)("sweepLeftoverRunProcesses on Linux", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // Not a port anything listens on: the sweep only compares it with the marker.
  const apiPort = 45_678;
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-process-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await stopStartedProcesses();
  });

  /** A run for a new agent, or for `agent` when given. */
  async function seedRun(
    status: string,
    finishedMinutesAgo: number | null,
    agent?: { companyId: string; agentId: string },
  ) {
    const companyId = agent?.companyId ?? randomUUID();
    const agentId = agent?.agentId ?? randomUUID();
    const runId = randomUUID();
    if (!agent) {
      await db.insert(companies).values({
        id: companyId,
        name: "Leftover sweep",
        issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "claude_local" });
    }
    const finishedAt = finishedMinutesAgo === null ? null : new Date(Date.now() - finishedMinutesAgo * 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status, finishedAt });
    return { runId, companyId, agentId };
  }

  it("stops processes of runs that ended a while ago, and only those", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
    const dir = await makeTempDir();
    const endedLongAgo = (await seedRun("succeeded", 30)).runId;
    const endedJustNow = (await seedRun("failed", 1)).runId;
    const stillRunning = (await seedRun("running", null)).runId;

    const leftover = await startOrphan(dir, "leftover", markedEnv(endedLongAgo, apiUrl), "sleep 600");
    const recent = await startOrphan(dir, "recent", markedEnv(endedJustNow, apiUrl), "sleep 600");
    const running = await startOrphan(dir, "running", markedEnv(stillRunning, apiUrl), "sleep 600");
    const otherServer = await startOrphan(dir, "other-server", markedEnv(endedLongAgo, "http://127.0.0.1:45679"), "sleep 600");
    const unknownRun = await startOrphan(dir, "unknown", markedEnv(randomUUID(), apiUrl), "sleep 600");

    const result = await sweepLeftoverRunProcesses({
      db,
      apiPort,
      graceMs: 1_500,
      deletedWorktreeMinAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.stopped.map((entry) => [entry.pid, entry.reason, entry.runId, entry.outcome])).toEqual([
      [leftover, "ended_run_marker", endedLongAgo, "terminated"],
    ]);
    for (let i = 0; i < 50 && alive(leftover); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(leftover)).toBe(false);
    for (const pid of [recent, running, otherServer, unknownRun]) expect(alive(pid)).toBe(true);
  });

  it("stops a sandbox of a run that ended by the parent URL it recorded, not by its own URL", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
    const dir = await makeTempDir();
    const ended = (await seedRun("succeeded", 30)).runId;
    const server = await startOrphan(dir, "sandbox-server", sandboxEnv(ended, apiUrl), "sleep 600");
    // Started after the sandbox server set GSAM_API_URL to its own port.
    const database = await startOrphan(dir, "sandbox-db", sandboxEnv(ended, apiUrl, "http://127.0.0.1:45680"), "sleep 600");
    // The same run id recorded for another server is that server's to stop.
    const elsewhere = await startOrphan(dir, "elsewhere", sandboxEnv(ended, "http://127.0.0.1:45679"), "sleep 600");

    const result = await sweepLeftoverRunProcesses({
      db,
      apiPort,
      graceMs: 1_500,
      deletedWorktreeMinAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.stopped.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([server, database].sort((a, b) => a - b));
    expect(result.stopped.every((entry) => entry.reason === "ended_run_marker" && entry.runId === ended)).toBe(true);
    for (let i = 0; i < 50 && (alive(server) || alive(database)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(server)).toBe(false);
    expect(alive(database)).toBe(false);
    expect(alive(elsewhere)).toBe(true);
  });

  // A warm ACP session keeps the environment of the run that started it, so a
  // process it starts during a later run carries the earlier, ended run's id.
  it("leaves an ended run's processes alone while its agent has a live run", async () => {
    vi.stubEnv("GSAM_RUN_PROCESS_CLEANUP", "");
    const dir = await makeTempDir();
    const first = await seedRun("succeeded", 30);
    const second = await seedRun("running", null, first);
    const devServer = await startOrphan(dir, "dev-server", markedEnv(first.runId, apiUrl), "sleep 600");
    const sweep = () =>
      sweepLeftoverRunProcesses({
        db,
        apiPort,
        graceMs: 1_500,
        deletedWorktreeMinAgeMs: Number.POSITIVE_INFINITY,
      });

    for (const status of ["running", "queued", "scheduled_retry"]) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, second.runId));
      expect(await sweep()).toMatchObject({ status: "done", stopped: [] });
      expect(alive(devServer)).toBe(true);
    }

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, second.runId));
    const result = await sweep();
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.stopped.map((entry) => [entry.pid, entry.runId, entry.outcome])).toEqual([
      [devServer, first.runId, "terminated"],
    ]);
    for (let i = 0; i < 50 && alive(devServer); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(alive(devServer)).toBe(false);
  });
});

