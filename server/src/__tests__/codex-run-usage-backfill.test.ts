import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, costEvents, createDb, heartbeatRuns } from "@greatstone/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { backfillCodexRunUsage } from "../services/codex-run-usage-backfill.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const tokenCount = (timestamp: string, total: object, last: object) =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });

describeEmbeddedPostgres("backfillCodexRunUsage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sessionsRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("codex-run-usage-backfill-");
    db = createDb(tempDb.connectionString);
    sessionsRoot = mkdtempSync(path.join(tmpdir(), "codex-sessions-"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(sessionsRoot, { recursive: true, force: true });
  });

  it("dry-runs, then rewrites a last-request-only run from its rollout, once", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const threadId = "01a169d0-da99-7632-9eca-8d3407590cf4";
    await db.insert(companies).values({
      id: companyId,
      name: "Codex Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Lintel", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId, companyId, adapterType: "codex_local",
      totalInputTokens: 251, totalCachedInputTokens: 22784, totalOutputTokens: 5,
    });
    // What the stock codex-acp stored: the last request, input excluding cached.
    const stored = { inputTokens: 251, cachedInputTokens: 22784, outputTokens: 5 };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "succeeded",
      startedAt: new Date("2026-10-23T17:30:50Z"), finishedAt: new Date("2026-10-23T17:31:10Z"),
      sessionIdAfter: threadId,
      usageJson: { ...stored, provider: "openai", model: "gpt-6-sol", costStatus: "estimated", costUsd: 0.001, usageCompleteness: "partial" },
    });
    await db.insert(costEvents).values({
      companyId, agentId, heartbeatRunId: runId, provider: "openai", model: "gpt-6-sol",
      ...stored, costCents: 0, occurredAt: new Date("2026-10-23T17:31:10Z"),
    });
    const dir = path.join(sessionsRoot, "sessions", "2026", "10", "23");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `rollout-2026-10-23T18-30-57-${threadId}.jsonl`), [
      tokenCount("2026-10-23T17:31:01Z", usage(22861, 13056, 38), usage(22861, 13056, 38)),
      tokenCount("2026-10-23T17:31:05Z", usage(45817, 35840, 60), usage(22956, 22784, 22)),
      tokenCount("2026-10-23T17:31:08Z", usage(68852, 58624, 65), usage(23035, 22784, 5)),
    ].join("\n"));

    const dry = await backfillCodexRunUsage(db, { sessionsRoots: [sessionsRoot], companyId, apply: false });
    expect(dry.changed).toBe(1);
    const [untouched] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(untouched!.usageJson).toMatchObject(stored);

    const applied = await backfillCodexRunUsage(db, { sessionsRoots: [sessionsRoot], companyId, apply: true });
    expect(applied.changed).toBe(1);
    const expected = { inputTokens: 68852, cachedInputTokens: 58624, outputTokens: 65 };
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.usageJson).toMatchObject({ ...expected, costStatus: "estimated", usageBackfill: { requests: 3, previous: stored } });
    expect(run!.usageJson).not.toHaveProperty("usageCompleteness");
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    expect(event).toMatchObject(expected);
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(state).toMatchObject({ totalInputTokens: 68852, totalCachedInputTokens: 58624, totalOutputTokens: 65 });

    const again = await backfillCodexRunUsage(db, { sessionsRoots: [sessionsRoot], companyId, apply: true });
    expect(again).toMatchObject({ changed: 0, alreadyBackfilled: 1 });
  });
});
