import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@greatstone/db";
import { renderPaperclipWakePrompt } from "@greatstone/adapter-utils/server-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "process", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "process", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const INTERACTION_DIRECTIVE = "ASD-STE100 Simplified Technical English";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("enableSimplifiedEnglishInteractions reaches the agent run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-simplified-english-"));
    vi.stubEnv("GSAM_HOME", path.join(root, "home"));
    // A dev worktree .env sets this and would suppress every run.
    vi.stubEnv("GSAM_IN_WORKTREE", "false");
    database = await startEmbeddedPostgresTestDatabase("simplified-english-interactions");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 30_000);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await instanceSettingsService(db).updateExperimental({ enableSimplifiedEnglishInteractions: false });
  });

  it.each([true, false])("with the switch %s, the run prompt carries the interaction directive only when on", async (enabled) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await instanceSettingsService(db).updateExperimental({ enableSimplifiedEnglishInteractions: enabled });
    await db.insert(companies).values({ id: companyId, name: "Plain words", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ask the user a question", status: "todo", assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded"), { timeout: 15_000 });

    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    const wake = calls[0]![0].context.paperclipWake;
    expect(wake).toBeTruthy();
    expect(wake.simplifiedEnglishInteractions).toBe(enabled);
    const prompt = renderPaperclipWakePrompt(wake);
    if (enabled) expect(prompt).toContain(INTERACTION_DIRECTIVE);
    else expect(prompt).not.toContain("ASD-STE100");
  }, 25_000);
});
