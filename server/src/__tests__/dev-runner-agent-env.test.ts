import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PARENT_RUN_API_URL_ENV_KEY, agentRunEnvKeyNames } from "@greatstone/shared/agent-run-env";
import { toLegacyEnvKey, withLegacyEnvAliases } from "@greatstone/shared/legacy-env";
import { isLinkedGitWorktreeCheckout, resolveWorktreeEnvFilePath } from "../dev-runner-worktree.js";
import { parseRunMarker, selectRunEndLeftovers, selectSweepLeftovers } from "../services/run-process-cleanup.js";

/**
 * Starts the real dev runner (`pnpm dev` path, watch mode) with a fake agent
 * environment and a fake `pnpm` first on PATH. The fake answers the runner's
 * preflight commands and, when asked to start the server, records the
 * environment it was given (`/proc/self/environ` on Linux, the same view the
 * leftover cleanup reads) and exits. Nothing listens on a port and nothing is
 * written to the repository: watch mode keeps no status file, and the service
 * registry lives under the temporary --data-dir. Every value is fake.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const devRunner = path.join(repoRoot, "scripts", "dev-runner.ts");
const tsxCli = path.join(repoRoot, "server", "node_modules", "tsx", "dist", "cli.mjs");
// A linked worktree needs its .gsam/.env before the dev runner starts at all.
const runnerCannotStart = isLinkedGitWorktreeCheckout(repoRoot) && !existsSync(resolveWorktreeEnvFilePath(repoRoot));

const FAKE_PNPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const joined = args.join(" ");
if (joined.includes("migration-status.ts")) {
  process.stdout.write('{"status":"upToDate"}\\n');
} else if (joined.includes("dev-native-runner-status.ts")) {
  process.stdout.write('{"nativeRunnerRequired":false}\\n');
} else if (args.includes("@greatstone/server") && (args.includes("dev") || args.includes("dev:watch"))) {
  let environ;
  try {
    environ = fs.readFileSync("/proc/self/environ");
  } catch {
    environ = Buffer.from(Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\0"));
  }
  fs.writeFileSync(path.join(process.env.FAKE_PNPM_OUT_DIR, "server-environ"), environ);
}
process.exit(0);
`;

const tempDirs: string[] = [];
const started: number[] = [];

afterEach(async () => {
  // Only the dev runner this test started, by its own PID.
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function parseEnviron(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of buffer.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) entries.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return entries;
}

async function runDevRunner(extraEnv: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsam-dev-runner-agent-env-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const outDir = path.join(root, "out");
  const dataDir = path.join(root, "sandbox");
  await mkdir(binDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(binDir, "pnpm"), FAKE_PNPM);
  await chmod(path.join(binDir, "pnpm"), 0o755);

  const env: Record<string, string> = {
    PATH: [binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    // Not a port anything listens on, and never live's.
    PORT: String(45_000 + Math.floor(Math.random() * 1_000)),
    FAKE_PNPM_OUT_DIR: outDir,
    GSAM_DB_BACKUP_ENABLED: "false",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [tsxCli, devRunner, "watch", "--data-dir", dataDir], {
    cwd: path.join(repoRoot, "server"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) started.push(child.pid);
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  const environFile = path.join(outDir, "server-environ");
  if (!existsSync(environFile)) throw new Error(`the dev runner never started the server (exit ${code}):\n${output}`);
  const raw = await readFile(environFile);
  return { raw, environ: parseEnviron(raw), output, dataDir };
}

describe.skipIf(runnerCannotStart)("dev runner started from an agent run", () => {
  it("hands the server an environment without the run's identity and credentials, keeping the marker", async () => {
    const runId = randomUUID();
    const parentApiUrl = "http://127.0.0.1:45991";
    const fakeKey = `fake-agent-key-${randomUUID()}`;
    const agentRun = withLegacyEnvAliases({
      GSAM_RUN_ID: runId,
      GSAM_API_URL: parentApiUrl,
      GSAM_API_KEY: fakeKey,
      GSAM_AGENT_ID: randomUUID(),
      GSAM_COMPANY_ID: randomUUID(),
      GSAM_TASK_ID: randomUUID(),
      GSAM_WAKE_REASON: "issue_assigned",
      GSAM_WORKSPACE_BRANCH: "fake-branch",
      GSAM_GIT_TOKEN: "fake-git-token",
      GSAM_GITHUB_BROKER_TOKEN: "fake-broker-token",
      GSAM_RUN_SCRATCH_DIR: "/tmp/fake-run-scratch",
    });

    const { raw, environ, output, dataDir } = await runDevRunner(agentRun);

    for (const key of agentRunEnvKeyNames()) expect(environ.has(key), key).toBe(false);
    expect(raw.toString("utf8")).not.toContain(fakeKey);
    expect(environ.get("GSAM_RUN_ID")).toBe(runId);
    expect(environ.get(toLegacyEnvKey("GSAM_RUN_ID"))).toBe(runId);
    expect(environ.get(PARENT_RUN_API_URL_ENV_KEY)).toBe(parentApiUrl);
    // The sandbox's own settings still arrive.
    expect(environ.get("GSAM_HOME")).toBe(dataDir);
    expect(environ.get("GSAM_DB_BACKUP_ENABLED")).toBe("false");
    expect(output).toContain(`started from agent run ${runId}`);

    // The parent's leftover cleanup reads this same environ: it still names
    // the run and the parent server, so both of its rules still apply (#369).
    const marker = parseRunMarker(raw);
    expect(marker).toEqual({ runId, conflicting: false, apiUrl: parentApiUrl });
    const sandboxServer = {
      pid: 4321,
      ppid: 1,
      pgid: 4321,
      uid: 1000,
      state: "S",
      hasTty: false,
      startTicks: "1",
      ageMs: 60 * 60_000,
      args: ["node", "tsx", "src/index.ts"],
      exe: "/usr/bin/node",
      cwd: "/home/agent/code/gs-clip/.gsam/worktrees/GRE-1-x/server",
      cwdDeleted: false,
      marker,
    };
    const protection = { uid: 1000, serverPid: 99, protectedPaths: ["/home/agent/GSAM"] };
    expect(selectRunEndLeftovers([sandboxServer], { runId, protection }).targets).toHaveLength(1);
    expect(
      selectSweepLeftovers([sandboxServer], { endedRunIds: new Set([runId]), apiPort: 45991, protection }).targets,
    ).toHaveLength(1);
  }, 120_000);

  it("changes nothing for a server started outside an agent run (live, the preview, client instances)", async () => {
    const { environ, output } = await runDevRunner({ GSAM_COMPANY_ID: "operator-company", GSAM_TASK_ID: "operator-task" });
    expect(environ.get("GSAM_COMPANY_ID")).toBe("operator-company");
    expect(environ.get("GSAM_TASK_ID")).toBe("operator-task");
    expect(environ.has("GSAM_RUN_ID")).toBe(false);
    expect(environ.has(PARENT_RUN_API_URL_ENV_KEY)).toBe(false);
    expect(output).not.toContain("started from agent run");
  }, 120_000);
});
