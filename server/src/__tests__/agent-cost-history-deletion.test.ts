import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, financeEvents, heartbeatRuns } from "@greatstone/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

// Upstream #19022, adapted to our agentService.remove.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent purge with retained cost history", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-cost-deletion-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cost deletion", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Billed worker", status: "terminated" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();
    return { companyId, agentId, run: run! };
  }
  const cost = (companyId: string, agentId: string, values: Partial<typeof costEvents.$inferInsert> = {}) =>
    db.insert(costEvents).values({
      companyId, agentId, provider: "anthropic", model: "claude", costCents: 1, occurredAt: new Date(), ...values,
    }).returning();

  async function expectRetained(f: Awaited<ReturnType<typeof fixture>>) {
    await expect(agentService(db).remove(f.agentId)).rejects.toMatchObject({ status: 409,
      details: { code: "agent_cost_history_retained" } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toHaveLength(1);
    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toHaveLength(1);
  }

  it("refuses before cleanup when a cost event references one of the agent's runs", async () => {
    const f = await fixture();
    const [event] = await cost(f.companyId, f.agentId, { heartbeatRunId: f.run.id });
    await expectRetained(f);
    expect(await db.select().from(costEvents).where(eq(costEvents.id, event!.id))).toEqual([event]);
  });

  it("refuses when a cost event is attributed to the agent", async () => {
    const f = await fixture();
    await cost(f.companyId, f.agentId);
    await expectRetained(f);
  });

  it("refuses when a finance event references one of the agent's runs", async () => {
    const f = await fixture();
    const [event] = await db.insert(financeEvents).values({ companyId: f.companyId, heartbeatRunId: f.run.id,
      eventKind: "usage", biller: "anthropic", amountCents: 1, occurredAt: new Date() }).returning();
    await expectRetained(f);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.id, event!.id))).toEqual([event]);
  });

  it("still purges an agent whose runs have no cost history", async () => {
    const f = await fixture();
    expect(await agentService(db).remove(f.agentId)).toMatchObject({ id: f.agentId });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toHaveLength(0);
  });
});
