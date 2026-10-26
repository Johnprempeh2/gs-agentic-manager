import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, createDb, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@greatstone/db";
import { addAgentProjectAccess, readAgentProjectAccess } from "../services/agent-project-access.js";
import { accessService } from "../services/access.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("additive agent project access", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else { database = await startEmbeddedPostgresTestDatabase("agent-project-access-"); db = createDb(database.connectionString); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Project access", issuePrefix: `A${companyId.slice(0, 6)}` },
      { id: foreignCompanyId, name: "Other company", issuePrefix: `B${foreignCompanyId.slice(0, 6)}` },
    ]);
    const [first, second, third] = await db.insert(projects).values([
      { companyId, name: "First" }, { companyId, name: "Second" }, { companyId, name: "Third" },
    ]).returning();
    const [foreign] = await db.insert(projects).values({ companyId: foreignCompanyId, name: "Foreign" }).returning();
    const agentId = randomUUID();
    const permissions = {
      canCreateAgents: false,
      canCreateSkills: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        customPolicy: { preserve: true },
        trustBoundary: { mode: "low_trust_review", companyId, projectIds: [first!.id], allowedToolClasses: ["git.read"] },
      },
    };
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "process", status: "idle", permissions });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId,
      membershipRole: "member", status: "active" });
    return { companyId, agentId, first: first!, second: second!, third: third!, foreign: foreign!, permissions };
  }

  const board = { type: "board" as const, source: "local_implicit" as const };

  it("preserves the company boundary and the rest of the agent policy", async () => {
    const fixture = await seed();
    const actor = { type: "agent" as const, source: "agent_key" as const,
      agentId: fixture.agentId, companyId: fixture.companyId };
    const readSecond = () => accessService(db).decide({ actor, action: "project:read",
      resource: { type: "project", companyId: fixture.companyId, projectId: fixture.second.id } });
    expect(await readSecond()).toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(addAgentProjectAccess(db, board, fixture.companyId, fixture.agentId, [fixture.foreign.id]))
      .rejects.toMatchObject({ status: 404 });
    const result = await addAgentProjectAccess(db, board, fixture.companyId, fixture.agentId, [fixture.second.id]);
    expect(result.projectIds).toEqual([fixture.first.id, fixture.second.id]);
    expect(await readSecond()).toMatchObject({ allowed: true });
    expect(await readAgentProjectAccess(db, board, fixture.companyId, fixture.agentId))
      .toMatchObject({ projectIds: [fixture.first.id, fixture.second.id], canManage: true });
    const [saved] = await db.select().from(agents)
      .where(and(eq(agents.companyId, fixture.companyId), eq(agents.id, fixture.agentId)));
    expect(saved!.permissions).toMatchObject({
      canCreateSkills: false,
      authorizationPolicy: {
        customPolicy: { preserve: true },
        trustBoundary: { allowedToolClasses: ["git.read"], projectIds: [fixture.first.id, fixture.second.id] },
      },
    });
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, fixture.companyId), eq(agentWakeupRequests.agentId, fixture.agentId))))
      .toEqual([]);
  });

  it("does not let an agent grant itself project access", async () => {
    const fixture = await seed();
    const actor = { type: "agent" as const, source: "agent_key" as const,
      agentId: fixture.agentId, companyId: fixture.companyId };
    await expect(addAgentProjectAccess(db, actor, fixture.companyId, fixture.agentId, [fixture.second.id]))
      .rejects.toMatchObject({ status: 403 });
  });

  it("keeps both additions when authorised saves race", async () => {
    const fixture = await seed();
    await Promise.all([
      addAgentProjectAccess(db, board, fixture.companyId, fixture.agentId, [fixture.second.id]),
      addAgentProjectAccess(db, board, fixture.companyId, fixture.agentId, [fixture.third.id]),
    ]);
    const result = await readAgentProjectAccess(db, board, fixture.companyId, fixture.agentId);
    expect(result.projectIds).toHaveLength(3);
    expect(result.projectIds).toEqual(expect.arrayContaining([fixture.first.id, fixture.second.id, fixture.third.id]));
  });

  it("keeps viewer access read-only", async () => {
    const fixture = await seed();
    const actor = { type: "board" as const, source: "session" as const, userId: randomUUID(),
      companyIds: [fixture.companyId], memberships: [{ companyId: fixture.companyId,
        membershipRole: "viewer" as const, status: "active" as const }] };
    expect(await readAgentProjectAccess(db, actor, fixture.companyId, fixture.agentId))
      .toMatchObject({ canManage: false });
    await expect(addAgentProjectAccess(db, actor, fixture.companyId, fixture.agentId, [fixture.second.id]))
      .rejects.toMatchObject({ status: 403 });
  });
});
