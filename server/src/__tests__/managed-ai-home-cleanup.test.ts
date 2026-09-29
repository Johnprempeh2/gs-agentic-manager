import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@greatstone/db";
import type { AdapterExecutionContext } from "@greatstone/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import {
  claimManagedAiHome,
  removeManagedAiHome,
  sweepStaleManagedAiHomes,
  sweepStaleTestTempDirs,
} from "../services/managed-ai-home-sweep.js";

// GRE-209: 380 per-run AI homes were left in the temp folder. Every run end
// must remove the home, and a sweep must remove homes with no live run.

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let gsamHome: string;

beforeAll(async () => {
  gsamHome = await mkdtemp(path.join(os.tmpdir(), "gsam-ai-home-cleanup-"));
  vi.stubEnv("GSAM_HOME", gsamHome);
  vi.stubEnv("GSAM_INSTANCE_ID", "ai-home-cleanup");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-home-cleanup-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (gsamHome) await rm(gsamHome, { recursive: true, force: true });
});

const exists = (target: string) => stat(target).then(() => true, () => false);

async function fixture() {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;
  await db.insert(companies).values({ id: companyId, name: "Home cleanup", issuePrefix: `C${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "claude_local", adapterConfig: { cwd: gsamHome, engine: "cli" }, runtimeConfig: { aiConnection: binding, heartbeat: { enabled: false } } });
  await aiConnectionService(db).save(companyId, userId, {
    provider: "anthropic", method: "api_key", name: "Worker connection", ownership: "personal", agentIds: [agentId], allAgents: false, apiKey: "fixture-api-key",
  }, "fixture-api-key");
  const [issue] = await db.insert(issues).values({ companyId, title: "Home cleanup task", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, createdByUserId: userId }).returning();
  return { companyId, agentId, userId, binding, issueId: issue!.id };
}

// The first heartbeat run in a worker is slow to start under load.
describe("per-run AI home is removed when the run ends", { timeout: 60_000 }, () => {
  afterEach(() => unregisterServerAdapter("claude_local"));

  const outcomes = {
    succeeded: async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }),
    failed: async () => ({ exitCode: 1, signal: null, timedOut: false, errorMessage: "provider failed" }),
    threw: async () => { throw new Error("adapter crashed"); },
    timed_out: async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true }),
  } as const;

  it.each(Object.keys(outcomes) as (keyof typeof outcomes)[])("removes the home when the run %s", async (outcome) => {
    const f = await fixture();
    // A finished run can queue a follow-up run; every run's home must go.
    const runHomes: string[] = [];
    const execute = vi.fn(async (ctx: AdapterExecutionContext) => {
      const runHome = String((ctx.config.env as Record<string, unknown>).HOME);
      runHomes.push(runHome);
      expect(await exists(path.join(runHome, "provider"))).toBe(true);
      return outcomes[outcome]();
    });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute } as never);
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system");
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).not.toMatch(/^(queued|running)$/);
      await heartbeat.drainActiveRunExecutions();
      expect(runHomes.length).toBeGreaterThan(0);
      for (const runHome of runHomes) {
        expect(runHome).toContain(path.join(os.tmpdir(), "paperclip-ai-"));
        expect(await exists(runHome)).toBe(false);
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  });

  it("removes the home when the run is cancelled", async () => {
    const f = await fixture();
    let runHome: string | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const execute = vi.fn(async (ctx: AdapterExecutionContext) => {
      runHome = String((ctx.config.env as Record<string, unknown>).HOME);
      await ctx.onCancellationReady?.();
      started();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: null, signal: "SIGTERM", timedOut: false, resultJson: { executionCancellation: { state: "acknowledged" } } };
    });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute } as never);
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system");
      await startedPromise;
      await heartbeat.cancelRun(run!.id);
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
      await heartbeat.drainActiveRunExecutions();
      expect(await exists(runHome!)).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  });

  it("records this server as the owner so a later sweep can tell live homes from stale ones", async () => {
    const f = await fixture();
    const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.userId, adapterType: "claude_local", binding: f.binding, config: {} });
    try {
      const owner = JSON.parse(await readFile(path.join(runtime.home, ".gsam-run-home.json"), "utf8"));
      expect(owner.pid).toBe(process.pid);
    } finally {
      await runtime.cleanup();
    }
    expect(await exists(runtime.home)).toBe(false);
  });
});

describe("removeManagedAiHome", () => {
  it("removes files the provider writes after the first removal", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "gsam-ai-late-write-"));
    await claimManagedAiHome(home);
    await removeManagedAiHome(home, { lateWriteRetryMs: 20 });
    // Claude CLI flushes MCP logs into $HOME/Library/Caches while it exits.
    await mkdir(path.join(home, "Library", "Caches", "claude-cli-nodejs"), { recursive: true });
    await expect.poll(() => exists(home), { timeout: 2_000 }).toBe(false);
  });
});

describe("temp folder sweeps", () => {
  let tmpDir: string;
  const now = Date.now();
  const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000);

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "gsam-sweep-test-"));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeDir(name: string, opts: { ageHours: number; provider?: boolean; ownerPid?: number }) {
    const dir = path.join(tmpDir, name);
    await mkdir(dir, { recursive: true });
    if (opts.provider) await mkdir(path.join(dir, "provider"));
    if (opts.ownerPid !== undefined) await writeFile(path.join(dir, ".gsam-run-home.json"), JSON.stringify({ pid: opts.ownerPid }));
    await utimes(dir, hoursAgo(opts.ageHours), hoursAgo(opts.ageHours));
    return dir;
  }

  it("removes per-run homes with no live run and keeps live ones", async () => {
    const deadPid = 2 ** 22 + 12345; // above the macOS and Linux default pid range
    const residue = await makeDir("paperclip-ai-c-g-residue", { ageHours: 1 });
    const freshResidue = await makeDir("paperclip-ai-c-g-fresh", { ageHours: 0 });
    const crashed = await makeDir("paperclip-ai-c-g-crashed", { ageHours: 0, provider: true, ownerPid: deadPid });
    const ownFinished = await makeDir("paperclip-ai-c-g-own", { ageHours: 0, provider: true, ownerPid: process.pid });
    const otherLiveServer = await makeDir("paperclip-ai-c-g-other", { ageHours: 48, provider: true, ownerPid: process.ppid });
    const unownedOld = await makeDir("paperclip-ai-c-g-legacy-old", { ageHours: 30, provider: true });
    const unownedRecent = await makeDir("paperclip-ai-c-g-legacy-new", { ageHours: 2, provider: true });
    const ownLive = await makeDir("paperclip-ai-c-g-live", { ageHours: 0, provider: true });
    await claimManagedAiHome(ownLive);
    const unrelated = await makeDir("other-app-folder", { ageHours: 100 });

    const result = await sweepStaleManagedAiHomes({ tmpDir, now });

    expect(result.removed.sort()).toEqual([crashed, residue, ownFinished, unownedOld].sort());
    for (const kept of [freshResidue, otherLiveServer, unownedRecent, ownLive, unrelated]) expect(await exists(kept)).toBe(true);
    await removeManagedAiHome(ownLive, { lateWriteRetryMs: 0 });
  });

  it("removes test temp folders older than one day only", async () => {
    const old = await Promise.all([
      makeDir("paperclip-worktree-repo-abc", { ageHours: 25 }),
      makeDir("paperclip-worktree-remote-abc", { ageHours: 25 }),
      makeDir("paperclip-worktree-clone-abc", { ageHours: 25 }),
      makeDir("paperclip-vitest-codex-home-abc", { ageHours: 25 }),
    ]);
    const recent = await makeDir("paperclip-worktree-repo-new", { ageHours: 1 });
    const unrelated = await makeDir("someone-else-clone", { ageHours: 100 });

    const result = await sweepStaleTestTempDirs({ tmpDir, now });

    expect(result.removed.sort()).toEqual(old.sort());
    expect(await exists(recent)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
  });
});
