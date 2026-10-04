import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupGitHubOperationLaunchers, prepareGitHubOperationLaunchers } from "./execution-target.js";
import { processKillGuardFiles, processKillGuardPaths, type ProcessKillGuard } from "./process-kill-guard.js";
import { shellQuote } from "./ssh.js";

describe("process kill guard paths", () => {
  it("never uses the root or the home directory (or above it) as a marker of live", () => {
    const { protectedPaths } = processKillGuardPaths({
      protectedPaths: ["/", "/home/agent", "/home", "/srv/gsam-guard-test/live", "relative/live", "/srv/bad\nline"],
      serverPid: 1,
    }, "/home/agent");
    expect(protectedPaths).toEqual(["/srv/gsam-guard-test/live"]);
  });

  it("exempts the run's own workspace only when it lies strictly inside a protected directory", () => {
    const exempt = (ownWorkspace: string) => processKillGuardPaths({
      protectedPaths: ["/srv/gsam-guard-test/live", "/srv/gsam-guard-test/data"], serverPid: 1, ownWorkspace,
    }, "/home/agent").exemptPaths;
    expect(exempt("/srv/gsam-guard-test/data/instances/default/workspaces/agent-a"))
      .toEqual(["/srv/gsam-guard-test/data/instances/default/workspaces/agent-a"]);
    expect(exempt("/srv/elsewhere/worktree")).toEqual([]);
    expect(exempt("/srv/gsam-guard-test/data")).toEqual([]);
    expect(exempt("/srv/gsam-guard-test")).toEqual([]);
  });

  it("writes pkill and killall wrappers on Linux and macOS only", () => {
    const guard = { protectedPaths: ["/srv/gsam-guard-test/live"], serverPid: 4242 };
    expect(processKillGuardFiles(guard, "win32")).toEqual({});
    expect(processKillGuardFiles(null, "linux")).toEqual({});
    const linux = processKillGuardFiles(guard, "linux");
    expect(Object.keys(linux).sort()).toEqual(["killall", "pkill"]);
    expect(linux.pkill).toContain("GUARD_FLAVOUR=gnu");
    expect(linux.pkill).toContain("GUARD_SERVER_PID=4242");
    expect(processKillGuardFiles(guard, "darwin").killall).toContain("GUARD_FLAVOUR=bsd");
  });
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("per-run launcher directory", () => {
  it("stages executable pkill and killall guards first on PATH, and none without a guard", async () => {
    const guarded = { runId: randomUUID(), target: null };
    const plain = { runId: randomUUID(), target: null };
    try {
      const env = await prepareGitHubOperationLaunchers({
        ...guarded, cwd: os.tmpdir(), env: {},
        processGuard: { protectedPaths: ["/srv/gsam-guard-test/live"], serverPid: process.pid },
      });
      expect(env.PATH.split(":")[0]).toBe(env.GSAM_GITHUB_LAUNCHER_DIR);
      for (const name of ["pkill", "killall"]) {
        const file = path.join(env.GSAM_GITHUB_LAUNCHER_DIR, name);
        expect((await stat(file)).mode & 0o777).toBe(0o700);
        expect(await readFile(file, "utf8")).toMatch(/^#!\/bin\/sh\n# GSAM process guard/);
      }
      const unguarded = await prepareGitHubOperationLaunchers({ ...plain, cwd: os.tmpdir(), env: {} });
      await expect(stat(path.join(unguarded.GSAM_GITHUB_LAUNCHER_DIR, "pkill"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupGitHubOperationLaunchers(guarded);
      await cleanupGitHubOperationLaunchers(plain);
    }
  });
});

// Real processes. Every process signalled here is one this file started: the
// patterns and names are a random marker, and the "live" directories are fake
// ones under a temporary folder.
type Dummy = { label: string; pid: number; exit: Promise<NodeJS.Signals | null> };
const started: { pid: number; marker: string }[] = [];
const roots: string[] = [];
const launchers: { runId: string; target: null }[] = [];

afterEach(async () => {
  for (const { pid, marker } of started.splice(0)) {
    // Only a process that still carries this test's marker (never a reused PID).
    if (readProc(pid, "comm").trim() !== marker) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await Promise.all(launchers.splice(0).map((location) => cleanupGitHubOperationLaunchers(location)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function running(pid: number): boolean {
  try {
    // A process that has exited but is not yet reaped shows state Z.
    return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const readProc = (pid: number, file: string) => {
  try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; }
};

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "killguard-test-")));
  roots.push(root);
  // Under the 15-character limit the kernel keeps for a process name.
  const marker = `kgm${randomBytes(5).toString("hex")}`;
  const live = path.join(root, "fake-live-install");
  const data = path.join(root, "fake-live-data");
  const own = path.join(data, "instances", "default", "workspaces", "agent-a");
  for (const dir of [path.join(live, "server"), path.join(live, "bin"), own, path.join(root, "bin"), path.join(root, "shell")]) {
    await mkdir(dir, { recursive: true });
  }
  // Copies named after the marker, so killall can match them by name.
  const sleeper = path.join(root, "bin", marker);
  const liveSleeper = path.join(live, "bin", marker);
  const shell = path.join(root, "shell", marker);
  for (const [from, to] of [["/bin/sleep", sleeper], ["/bin/sleep", liveSleeper], ["/bin/sh", shell]] as const) {
    await copyFile(await realpath(from), to);
    await chmod(to, 0o755);
  }

  const start = async (label: string, file: string, argv0: string, cwd = root): Promise<Dummy> => {
    const child: ChildProcess = spawn(file, ["600"], { argv0, cwd, stdio: "ignore" });
    const exit = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    const pid = child.pid!;
    started.push({ pid, marker });
    await waitFor(() => readProc(pid, "comm").trim() === marker, `${label} to start`);
    return { label, pid, exit };
  };

  // A shell named after the marker that starts a sleeper; the sleeper stands
  // in for the live server and the shell for the runner above it.
  const startServerTree = async () => {
    const parent = spawn(shell, ["-c", `${shellQuote(sleeper)} 600 & echo $!; wait`], {
      argv0: marker, cwd: root, stdio: ["ignore", "pipe", "ignore"],
    });
    started.push({ pid: parent.pid!, marker });
    const serverPid = await new Promise<number>((resolve, reject) => {
      parent.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      parent.once("error", reject);
    });
    started.push({ pid: serverPid, marker });
    await waitFor(() => readProc(serverPid, "cmdline").startsWith(`${sleeper}\0`), "the fake server to start");
    return { runnerPid: parent.pid!, serverPid };
  };

  const stage = async (guard: Omit<ProcessKillGuard, "protectedPaths">) => {
    const location = { runId: randomUUID(), target: null };
    launchers.push(location);
    const env = await prepareGitHubOperationLaunchers({
      ...location, cwd: own, env: {}, processGuard: { protectedPaths: [live, data], ...guard },
    });
    const run = (command: "pkill" | "killall", args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        // Always the staged wrapper by its full path, never the system binary.
        const child = spawn(path.join(env.GSAM_GITHUB_LAUNCHER_DIR, command), args, {
          env: { ...process.env, PATH: env.PATH }, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk) => { stdout += chunk; });
        child.stderr!.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
    return { env, run };
  };

  return { root, marker, live, data, own, sleeper, liveSleeper, start, startServerTree, stage };
}

// Live-like processes (6) and the agent's own (3), all matching the marker.
async function liveAndOwnProcesses(fx: Awaited<ReturnType<typeof fixture>>) {
  const { marker, live, data, own, root, sleeper, liveSleeper } = fx;
  const tree = await fx.startServerTree();
  const protectedDummies = [
    await fx.start("argument in the install directory", sleeper, path.join(live, "node_modules", ".bin", marker)),
    await fx.start("argument in the data directory", sleeper, `${marker} --data-dir=${data}`),
    await fx.start("working directory in the install", sleeper, marker, path.join(live, "server")),
    await fx.start("executable in the install", liveSleeper, marker),
  ];
  const own_ = [
    await fx.start("own sandbox in the workspace", sleeper, `${marker} --data-dir=${own}/tmp/sandbox`, own),
    await fx.start("plain", sleeper, marker),
    await fx.start("elsewhere", sleeper, path.join(root, "elsewhere", marker)),
  ];
  return { tree, protectedPids: [...protectedDummies.map((dummy) => dummy.pid), tree.runnerPid, tree.serverPid], own: own_ };
}

describe.skipIf(process.platform !== "linux")("process kill guard against real processes", () => {
  it("pkill -f signals the agent's own matches and leaves live's alone", async () => {
    const fx = await fixture();
    const { tree, protectedPids, own } = await liveAndOwnProcesses(fx);
    const { env, run } = await fx.stage({ serverPid: tree.serverPid });

    const resolved = await new Promise<string>((resolve) => {
      const child = spawn("sh", ["-c", "command -v pkill; command -v killall"], { env: { ...process.env, PATH: env.PATH } });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.once("close", () => resolve(out));
    });
    expect(resolved.trim().split("\n")).toEqual(["pkill", "killall"].map((name) => path.join(env.GSAM_GITHUB_LAUNCHER_DIR, name)));

    const result = await run("pkill", ["-e", "-c", "-f", fx.marker]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("left 6 matching process(es) alone");
    expect(result.stderr).toContain("pnpm dev:stop --data-dir");
    const lines = result.stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("3");
    expect(lines.slice(0, -1).sort()).toEqual(own.map((dummy) => `${fx.marker} killed (pid ${dummy.pid})`).sort());
    for (const dummy of own) expect(await dummy.exit, dummy.label).toBe("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of protectedPids) expect(running(pid), `pid ${pid}`).toBe(true);
  }, 30_000);

  it("killall by name sends the requested signal to the agent's own processes only", async () => {
    const fx = await fixture();
    const { tree, protectedPids, own } = await liveAndOwnProcesses(fx);
    const { run } = await fx.stage({ serverPid: tree.serverPid });

    const result = await run("killall", ["-s", "KILL", fx.marker]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("left 6 matching process(es) alone");
    for (const dummy of own) expect(await dummy.exit, dummy.label).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of protectedPids) expect(running(pid), `pid ${pid}`).toBe(true);
  }, 30_000);

  it("exits 1 and explains when every match belongs to live", async () => {
    const fx = await fixture();
    const live = [
      await fx.start("argument in the install directory", fx.sleeper, `${fx.marker} ${path.join(fx.live, "server", "src", "index.ts")}`),
      await fx.start("argument in the data directory", fx.sleeper, `${fx.marker} -D ${fx.data}/instances/default/db`),
    ];
    const { run } = await fx.stage({ serverPid: 0 });
    for (const [command, args] of [["pkill", ["-9", "-f", fx.marker]], ["killall", ["-KILL", fx.marker]]] as const) {
      const result = await run(command, [...args]);
      expect(result.code, `${command}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("left 2 matching process(es) alone");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const dummy of live) expect(running(dummy.pid), dummy.label).toBe(true);
  }, 30_000);

  it("refuses options it cannot translate and signals nothing", async () => {
    const fx = await fixture();
    const mine = await fx.start("plain", fx.sleeper, fx.marker);
    const { run } = await fx.stage({ serverPid: 0 });
    for (const [command, args] of [
      ["pkill", ["-l", fx.marker]],
      ["pkill", ["-fv", fx.marker]],
      ["pkill", ["--sig=KILL", "-f", fx.marker]],
      ["pkill", ["-q", "1", "-f", fx.marker]],
      ["killall", ["-i", fx.marker]],
      ["killall", ["-w", fx.marker]],
      ["killall", ["-qv", fx.marker]],
      ["killall", [fx.sleeper]],
    ] as const) {
      const result = await run(command, [...args]);
      expect(result.code, `${command} ${args.join(" ")}`).toBe(2);
      expect(result.stderr).toContain("cannot safely translate");
    }
    expect(running(mine.pid)).toBe(true);
  }, 30_000);

  it("reports no match and passes pgrep usage errors through like pkill and killall", async () => {
    const fx = await fixture();
    const { run } = await fx.stage({ serverPid: 0 });
    const none = await run("pkill", ["-f", `${fx.marker}-none`]);
    expect(none).toMatchObject({ code: 1, stdout: "", stderr: "" });
    const usage = await run("pkill", []);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("no matching criteria specified");
    const missing = await run("killall", [`${fx.marker}x`]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(`${fx.marker}x: no process found\n`);
  }, 30_000);
});
