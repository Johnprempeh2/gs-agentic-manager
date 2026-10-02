import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, agentTeamMembers, agentTeams } from "@greatstone/db";
import type { AgentTeam } from "@greatstone/shared";
import { agentTeamRoutes } from "../routes/agent-teams.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("agent teams API", () => {
  const ctx = useEmbeddedPostgres("gsam-agent-teams-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(agentTeamMembers);
      await db.delete(agentTeams);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string, reportsTo: string | null = null) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo,
      })
      .returning();
    return agent;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never;
  }

  it("creates, edits, lists and deletes a team; the lead is always a member", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Teams");
    const lead = await seedAgent(companyId, "Mason");
    const mica = await seedAgent(companyId, "Mica", lead.id);
    const bedrock = await seedAgent(companyId, "Bedrock");
    const app = routeApp(ctx.db, actor, agentTeamRoutes);

    const created = await request(app)
      .post(`/api/companies/${companyId}/agent-teams`)
      .send({ name: "Platform", color: "#2563eb", leadAgentId: lead.id, memberAgentIds: [mica.id] });
    expect(created.status).toBe(201);
    const team = created.body as AgentTeam;
    expect(team).toMatchObject({ name: "Platform", color: "#2563eb", leadAgentId: lead.id, description: null });
    expect(team.memberAgentIds.sort()).toEqual([lead.id, mica.id].sort());

    const edited = await request(app)
      .patch(`/api/agent-teams/${team.id}`)
      .send({ description: "Builds the app", memberAgentIds: [bedrock.id] });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe("Builds the app");
    // Replacing the member list keeps the lead in it.
    expect((edited.body as AgentTeam).memberAgentIds.sort()).toEqual([lead.id, bedrock.id].sort());

    const list = await request(app).get(`/api/companies/${companyId}/agent-teams`);
    expect(list.status).toBe(200);
    expect((list.body as AgentTeam[]).map((t) => t.id)).toEqual([team.id]);

    const removed = await request(app).delete(`/api/agent-teams/${team.id}`);
    expect(removed.status).toBe(200);
    expect(await ctx.db.select().from(agentTeamMembers)).toEqual([]);

    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action).sort();
    expect(actions).toEqual(["agent_team.created", "agent_team.deleted", "agent_team.updated"]);
  });

  it("lets an agent be in more than one team and adds/removes single members", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Multi");
    const ridge = await seedAgent(companyId, "Ridge");
    const app = routeApp(ctx.db, actor, agentTeamRoutes);
    const a = await request(app).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Reliability", color: "#16a34a", leadAgentId: ridge.id });
    const b = await request(app).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Release", color: "#d97706" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const added = await request(app).post(`/api/agent-teams/${b.body.id}/members`).send({ agentId: ridge.id });
    expect(added.status).toBe(200);
    expect(added.body.memberAgentIds).toEqual([ridge.id]);
    // Adding twice is a no-op.
    const again = await request(app).post(`/api/agent-teams/${b.body.id}/members`).send({ agentId: ridge.id });
    expect(again.body.memberAgentIds).toEqual([ridge.id]);

    // Removing the lead from their team clears the lead.
    const out = await request(app).delete(`/api/agent-teams/${a.body.id}/members/${ridge.id}`);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ leadAgentId: null, memberAgentIds: [] });
  });

  it("rejects a duplicate name with 409 and a bad colour with 400", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Dupes");
    const app = routeApp(ctx.db, actor, agentTeamRoutes);
    await request(app).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Upstream", color: "#7c3aed" });
    const dupe = await request(app).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Upstream", color: "#7c3aed" });
    expect(dupe.status).toBe(409);
    const badColor = await request(app).post(`/api/companies/${companyId}/agent-teams`).send({ name: "X", color: "blue" });
    expect(badColor.status).toBe(400);
  });

  it("keeps teams inside their company", async () => {
    const one = await seedCompanyWithBoardAccess(ctx.db, "One");
    const two = await seedCompanyWithBoardAccess(ctx.db, "Two");
    const outsider = await seedAgent(two.companyId, "Outsider");
    const appOne = routeApp(ctx.db, one.actor, agentTeamRoutes);
    const appTwo = routeApp(ctx.db, two.actor, agentTeamRoutes);

    // An agent from another company cannot be lead or member.
    const foreign = await request(appOne)
      .post(`/api/companies/${one.companyId}/agent-teams`)
      .send({ name: "Mixed", color: "#2563eb", memberAgentIds: [outsider.id] });
    expect(foreign.status).toBe(422);

    const team = await request(appOne).post(`/api/companies/${one.companyId}/agent-teams`).send({ name: "Mine", color: "#2563eb" });
    expect(team.status).toBe(201);

    // Company two cannot list, read, edit or delete company one's team.
    expect((await request(appTwo).get(`/api/companies/${one.companyId}/agent-teams`)).status).toBe(403);
    expect((await request(appTwo).get(`/api/agent-teams/${team.body.id}`)).status).toBe(404);
    expect((await request(appTwo).patch(`/api/agent-teams/${team.body.id}`).send({ name: "Taken" })).status).toBe(404);
    expect((await request(appTwo).delete(`/api/agent-teams/${team.body.id}`)).status).toBe(404);
    expect((await request(appTwo).get(`/api/companies/${two.companyId}/agent-teams`)).body).toEqual([]);
  });

  it("lets an agent read teams but not change them without the hire permission", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Perms");
    const worker = await seedAgent(companyId, "Worker");
    const boardApp = routeApp(ctx.db, actor, agentTeamRoutes);
    await request(boardApp).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Ops", color: "#4b5563" });

    const agentApp = routeApp(ctx.db, agentActor(companyId, worker.id), agentTeamRoutes);
    const list = await request(agentApp).get(`/api/companies/${companyId}/agent-teams`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const create = await request(agentApp).post(`/api/companies/${companyId}/agent-teams`).send({ name: "Rogue", color: "#4b5563" });
    expect(create.status).toBe(403);
  });

  it("never changes who reports to whom", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Lines");
    const boss = await seedAgent(companyId, "Boss");
    const report = await seedAgent(companyId, "Report", boss.id);
    const app = routeApp(ctx.db, actor, agentTeamRoutes);
    const team = await request(app)
      .post(`/api/companies/${companyId}/agent-teams`)
      .send({ name: "Flat", color: "#0891b2", leadAgentId: report.id, memberAgentIds: [boss.id] });
    await request(app).delete(`/api/agent-teams/${team.body.id}`);
    const rows = await ctx.db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents);
    expect(rows.find((row) => row.id === report.id)?.reportsTo).toBe(boss.id);
    expect(rows.find((row) => row.id === boss.id)?.reportsTo).toBeNull();
  });
});
