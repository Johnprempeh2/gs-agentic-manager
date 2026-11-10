import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      appearance: pending.appearance,
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  it("refuses an agent-originated budget change in the service (upstream paperclipai/paperclip#20213)", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);
    const agent = await db.insert(agents).values({
      companyId, name: "Spender", role: "engineer", budgetMonthlyCents: 1000,
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning().then(rows => rows[0]!);
    const byAgent = { recordRevision: { createdByAgentId: agent.id, createdByUserId: null, source: "patch" } };

    await expect(service.update(agent.id, { budgetMonthlyCents: 5000 }, byAgent as never))
      .rejects.toMatchObject({ status: 403 });
    // The unchanged amount with another edit still works for an agent.
    await service.update(agent.id, { title: "Lead", budgetMonthlyCents: 1000 }, byAgent as never);
    // A board user may change it.
    await service.update(agent.id, { budgetMonthlyCents: 5000 }, {
      recordRevision: { createdByAgentId: null, createdByUserId: "board-user", source: "patch" },
    } as never);
    const stored = await db.select().from(agents).where(eq(agents.id, agent.id)).then(rows => rows[0]!);
    expect(stored).toMatchObject({ title: "Lead", budgetMonthlyCents: 5000 });
  });

  it("keeps a CEO's hiring authority as saved when another permission changes", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);
    const insertCeo = (permissions: Record<string, unknown>) => db.insert(agents).values({
      companyId, name: `CEO ${randomUUID()}`, role: "ceo", permissions,
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning().then(rows => rows[0]!);
    const stored = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0]!.permissions as Record<string, unknown>);

    const legacy = await insertCeo({});
    await service.updatePermissions(legacy.id, { canCreateSkills: false } as never);
    expect(await stored(legacy.id)).toMatchObject({ canCreateAgents: true, canCreateSkills: false });

    const unrecorded = await insertCeo({ canCreateAgents: false, canCreateSkills: true });
    await service.updatePermissions(unrecorded.id, { canCreateSkills: false } as never);
    expect(await stored(unrecorded.id)).toMatchObject({ canCreateAgents: true, canCreateSkills: false });

    const denial = { actorType: "user", actorId: "board-user", at: "2026-11-08T00:00:00.000Z" };
    const denied = await insertCeo({ canCreateAgents: false, canCreateSkills: true, ceoHiringDeniedBy: denial });
    await service.updatePermissions(denied.id, { canCreateSkills: false } as never);
    expect(await stored(denied.id)).toMatchObject({ canCreateAgents: false, canCreateSkills: false, ceoHiringDeniedBy: denial });

    // An import update whose manifest omits the field keeps the board's denial,
    // and a supplied denial record is never taken from input.
    await service.update(denied.id, { permissions: {} } as never);
    expect(await stored(denied.id)).toMatchObject({ canCreateAgents: false, ceoHiringDeniedBy: denial });
    const open = await insertCeo({ canCreateAgents: true });
    await service.update(open.id, { permissions: { canCreateAgents: false, ceoHiringDeniedBy: denial } } as never);
    expect(await stored(open.id)).not.toHaveProperty("ceoHiringDeniedBy");
  });
});
