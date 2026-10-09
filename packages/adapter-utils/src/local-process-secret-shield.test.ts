import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SECRET_SHIELD_COMMAND_ENV,
  AGENT_SECRET_SHIELD_ENV,
  AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV,
  buildAgentSecretShieldArgs,
  resetAgentSecretShieldCacheForTests,
  resolveAgentSecretShield,
  resolveAgentSecretShieldHiddenPaths,
} from "./local-process-sandbox.js";
import { wrapLocalAcpAgentCommand } from "./acpx-engine/execute.js";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

// GRE-1094: local agent runs must not read ~/gs-memory/secrets or the
// server's /proc/<pid>/environ. The bwrap cases need a working bubblewrap:
// set GSAM_TEST_BWRAP to a binary, or have bwrap on PATH.
function findBwrap(): string | null {
  const candidates = [process.env.GSAM_TEST_BWRAP, "bwrap"].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const bwrap = process.platform === "linux" ? findBwrap() : null;
const skipReason = bwrap ? null : "no working bwrap (install bubblewrap or set GSAM_TEST_BWRAP)";
const SHIELD_ENV_KEYS = [AGENT_SECRET_SHIELD_ENV, AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV, AGENT_SECRET_SHIELD_COMMAND_ENV];

const cleanup: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(SHIELD_ENV_KEYS.map((key) => [key, process.env[key]]));
  resetAgentSecretShieldCacheForTests();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAgentSecretShieldCacheForTests();
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

async function dummySecretsDir(): Promise<{ dir: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-secret-shield-"));
  cleanup.push(root);
  const dir = path.join(root, "secrets");
  await fs.mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, "gateway.env");
  await fs.writeFile(file, "DUMMY=not-a-secret\n", { mode: 0o600 });
  return { dir, file };
}

async function runShell(script: string, opts: { secretShield?: boolean; cwd?: string } = {}) {
  return runChildProcess(`secret-shield-${Date.now()}`, "sh", ["-c", script], {
    cwd: opts.cwd ?? os.tmpdir(),
    env: {},
    timeoutSec: 20,
    graceSec: 1,
    onLog: async () => {},
    secretShield: opts.secretShield,
  });
}

describe("agent secret shield", () => {
  it("hides ~/gs-memory/secrets by default and accepts extra absolute paths", () => {
    const hidden = resolveAgentSecretShieldHiddenPaths({
      [AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV]: ["/srv/extra-secrets", "relative/ignored"].join(path.delimiter),
    });
    expect(hidden).toContain(path.join(os.homedir(), "gs-memory", "secrets"));
    expect(hidden).toContain("/srv/extra-secrets");
    expect(hidden).not.toContain("relative/ignored");
  });

  it("builds a normal-root, fresh-/proc bwrap prefix with a tmpfs per hidden path", () => {
    expect(buildAgentSecretShieldArgs({ hiddenPaths: ["/h/secrets"], dieWithParent: false })).toEqual([
      "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--tmpfs", "/h/secrets", "--",
    ]);
    expect(buildAgentSecretShieldArgs({ hiddenPaths: [], dieWithParent: true })).toContain("--die-with-parent");
  });

  it("can be turned off by the operator", async () => {
    process.env[AGENT_SECRET_SHIELD_ENV] = "off";
    await expect(resolveAgentSecretShield()).resolves.toMatchObject({ state: "disabled" });
  });

  it.runIf(process.platform === "linux")(
    "runs unwrapped with one warning per spawn when bwrap is missing",
    async () => {
      const { dir, file } = await dummySecretsDir();
      process.env[AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV] = dir;
      process.env[AGENT_SECRET_SHIELD_COMMAND_ENV] = path.join(dir, "..", "missing-bwrap");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const first = await runShell(`test -r ${JSON.stringify(file)}`);
      const second = await runShell("exit 0");

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      const shieldWarnings = warn.mock.calls.filter(([message]) => String(message).includes("Agent secret sandbox is OFF"));
      expect(shieldWarnings).toHaveLength(2);
      expect(String(shieldWarnings[0][0])).toContain("install bubblewrap");
      await expect(resolveAgentSecretShield()).resolves.toMatchObject({ state: "unavailable", command: null });
      await expect(wrapLocalAcpAgentCommand("/opt/bin/codex-acp")).resolves.toBe("/opt/bin/codex-acp");
    },
  );

  describe.skipIf(!bwrap)(`with bubblewrap${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
    beforeEach(() => {
      process.env[AGENT_SECRET_SHIELD_COMMAND_ENV] = bwrap!;
    });

    it("a wrapped process cannot read the hidden secrets file; the same process unwrapped can", async () => {
      const { dir, file } = await dummySecretsDir();
      process.env[AGENT_SECRET_SHIELD_HIDDEN_PATHS_ENV] = dir;
      const probe = `test -r ${JSON.stringify(file)}`;

      expect((await runShell(probe, { secretShield: false })).exitCode).toBe(0);
      expect((await runShell(probe)).exitCode).toBe(1);
      expect((await runShell(`ls -A ${JSON.stringify(dir)} | wc -l`)).stdout.trim()).toBe("0");
    });

    it("hides the real ~/gs-memory/secrets/gateway.env when it exists (test -r only)", async (ctx) => {
      const gatewayEnv = path.join(os.userInfo().homedir, "gs-memory", "secrets", "gateway.env");
      const unwrapped = await runShell(`test -r ${JSON.stringify(gatewayEnv)}`, { secretShield: false });
      if (unwrapped.exitCode !== 0) ctx.skip();
      expect((await runShell(`test -r ${JSON.stringify(gatewayEnv)}`)).exitCode).toBe(1);
    });

    it("a wrapped process cannot read the parent server's /proc/<pid>/environ", async () => {
      const environ = `/proc/${process.pid}/environ`;
      expect((await runShell(`test -r ${environ} && head -c1 ${environ} >/dev/null`, { secretShield: false })).exitCode).toBe(0);
      const wrapped = await runShell(`test -e ${environ}; echo "exists=$?"; head -c1 ${environ} >/dev/null 2>&1; echo "read=$?"`);
      expect(wrapped.stdout).toContain("exists=1");
      expect(wrapped.stdout).toContain("read=1");
    });

    it("keeps workspace writes, git and the process group stop path working", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-secret-shield-ws-"));
      cleanup.push(workspace);
      const result = await runShell(
        "git init -q . && echo ok > file.txt && git add file.txt && git -c user.email=t@t -c user.name=t commit -qm init && git log --oneline | wc -l",
        { cwd: workspace },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("1");
      await expect(fs.readFile(path.join(workspace, "file.txt"), "utf8")).resolves.toBe("ok\n");

      const timed = await runChildProcess("secret-shield-timeout", "sh", ["-c", "sleep 30"], {
        cwd: workspace, env: {}, timeoutSec: 1, graceSec: 1, onLog: async () => {},
      });
      expect(timed.timedOut).toBe(true);
    });

    // A PID namespace hides the agent's real PID, so find it by a unique argv token.
    async function hostPidsWithToken(token: string): Promise<number[]> {
      const pids: number[] = [];
      for (const entry of await fs.readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
        if (cmdline.includes(token)) pids.push(Number(entry));
      }
      return pids;
    }

    async function waitForNoPids(token: string, timeoutMs: number): Promise<number[]> {
      const deadline = Date.now() + timeoutMs;
      let pids = await hostPidsWithToken(token);
      while (pids.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        pids = await hostPidsWithToken(token);
      }
      return pids;
    }

    const stubbornAgent = (token: string, before = "") =>
      `${before} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); // ${token}`;

    it("timeout escalation still kills a wrapped agent that ignores SIGTERM", async () => {
      const token = `gsam-shield-timeout-${process.pid}-${Date.now()}`;
      const result = await runChildProcess("secret-shield-stubborn-timeout", process.execPath, ["-e", stubbornAgent(token)], {
        cwd: os.tmpdir(), env: {}, timeoutSec: 1, graceSec: 1, onLog: async () => {},
      });
      expect(result.timedOut).toBe(true);
      expect(await waitForNoPids(token, 3_000)).toEqual([]);
    });

    it("terminal-result cleanup with file capture still kills a wrapped agent that ignores SIGTERM", async () => {
      const token = `gsam-shield-terminal-${process.pid}-${Date.now()}`;
      const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-shield-capture-"));
      cleanup.push(captureDir);
      const result = await runChildProcess(
        "secret-shield-stubborn-terminal",
        process.execPath,
        ["-e", stubbornAgent(token, "process.stdout.write('{\"type\":\"result\"}\\n');")],
        {
          cwd: os.tmpdir(),
          env: {},
          timeoutSec: 0,
          graceSec: 1,
          onLog: async () => {},
          outputCapture: { dir: captureDir },
          terminalResultCleanup: { graceMs: 50, hasTerminalResult: ({ stdout }) => stdout.includes('"type":"result"') },
        },
      );
      expect(result.terminalResultCleanup?.stopped).toBe(true);
      expect(await waitForNoPids(token, 4_000)).toEqual([]);
    });

    it("a background descendant keeps the run open until a group stop clears the whole namespace", async () => {
      const token = `gsam-shield-descendant-${process.pid}-${Date.now()}`;
      const runId = `secret-shield-descendant-${Date.now()}`;
      const script = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('noise\\\\n'), 50) // ${token}"], { stdio: ['ignore', 'inherit', 'ignore'] });`,
        "setTimeout(() => process.exit(0), 100);",
      ].join(" ");
      let observed = "";
      const resultPromise = runChildProcess(runId, process.execPath, ["-e", script], {
        cwd: os.tmpdir(), env: {}, timeoutSec: 0, graceSec: 1,
        onLog: async (_stream, chunk) => { observed += chunk; },
      });
      const deadline = Date.now() + 5_000;
      while (!observed.includes("noise") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const race = await Promise.race([
        resultPromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 300)),
      ]);
      expect(race).toBe("pending");
      expect((await hostPidsWithToken(token)).length).toBeGreaterThan(0);

      // The cancel path: group SIGTERM, then group SIGKILL. The namespace
      // init is in the same group, so SIGKILL tears down everything inside.
      const running = runningProcesses.get(runId)!;
      signalRunningProcess(running, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      signalRunningProcess(running, "SIGKILL");
      await resultPromise;
      expect(await waitForNoPids(token, 3_000)).toEqual([]);
    });

    it("prefixes local ACP agent commands so acpx still sees the agent binary", async () => {
      const wrapped = await wrapLocalAcpAgentCommand("/opt/bin/claude-agent-acp");
      expect(wrapped.startsWith(JSON.stringify(bwrap))).toBe(true);
      expect(wrapped).toContain('"--die-with-parent"');
      expect(wrapped.endsWith('"--" /opt/bin/claude-agent-acp')).toBe(true);
    });
  });
});
