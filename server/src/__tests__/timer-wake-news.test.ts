import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { readTimerWakeNews } from "../services/timer-wake-news.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-16T08:00:00.000Z");
const RUN_ENDED = new Date("2026-10-16T07:50:00.000Z");
const BEFORE_RUN = new Date("2026-10-16T07:40:00.000Z");
const AFTER_RUN = new Date("2026-10-16T07:55:00.000Z");

describeEmbeddedPostgres("readTimerWakeNews", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-wake-news-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { withRun?: boolean; runEnded?: Date } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Timer", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Everest", role: "ceo", status: "idle", adapterType: "codex_local" },
      { id: otherAgentId, companyId, name: "Mason", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Standing task", status: "todo", assigneeAgentId: agentId, updatedAt: BEFORE_RUN });
    if (options.withRun !== false) {
      const ended = options.runEnded ?? RUN_ENDED;
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", createdAt: ended, startedAt: ended, finishedAt: ended });
    }
    const agent = { id: agentId, companyId };
    return { companyId, agentId, otherAgentId, issueId, agent };
  }

  it("runs the first time", async () => {
    const { agent } = await seed({ withRun: false });
    expect(await readTimerWakeNews(db, agent, NOW)).toMatchObject({ hasNews: true, reason: "first_run" });
  });

  it("has no news when nothing changed since the last run ended", async () => {
    const { agent } = await seed();
    expect(await readTimerWakeNews(db, agent, NOW)).toEqual({ hasNews: false, reason: "nothing_changed", since: RUN_ENDED });
  });

  it("still checks in once a day", async () => {
    const { agent } = await seed({ runEnded: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
    expect(await readTimerWakeNews(db, agent, NOW)).toMatchObject({ hasNews: true, reason: "daily_check_in" });
  });

  it("sees a change to a task it owns or made", async () => {
    const { agent, companyId, otherAgentId } = await seed();
    await db.insert(issues).values({ companyId, title: "Delegated", status: "done", assigneeAgentId: otherAgentId, createdByAgentId: agent.id, updatedAt: AFTER_RUN });
    expect(await readTimerWakeNews(db, agent, NOW)).toMatchObject({ hasNews: true, reason: "task_changed" });
  });

  it("sees a comment from someone else but not its own", async () => {
    const { agent, companyId, issueId, otherAgentId } = await seed();
    await db.insert(issueComments).values({ companyId, issueId, body: "My own note", authorAgentId: agent.id, createdAt: AFTER_RUN });
    expect((await readTimerWakeNews(db, agent, NOW)).hasNews).toBe(false);
    await db.insert(issueComments).values({ companyId, issueId, body: "Over to you", authorAgentId: otherAgentId, createdAt: AFTER_RUN });
    expect(await readTimerWakeNews(db, agent, NOW)).toMatchObject({ hasNews: true, reason: "new_comment" });
  });
});
