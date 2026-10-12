import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, agentTeamMembers, agentTeams, issues } from "@greatstone/db";
import { issueRoutes } from "../routes/issues.js";
import { agentTeamService } from "../services/agent-teams.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// GRE-437: assigning a task to a team assigns the team lead and stores the team.
describeEmbeddedPostgres("assign a task to a team", () => {
  const ctx = useEmbeddedPostgres("gsam-issue-team-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(agentTeamMembers);
      await db.delete(agentTeams);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string, status = "idle") {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent;
  }

  async function seedTeam(companyId: string, name: string, leadAgentId: string | null, memberAgentIds: string[] = []) {
    return agentTeamService(ctx.db).create(companyId, { name, color: "#2563eb", leadAgentId, memberAgentIds });
  }

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Teams co");
    const lead = await seedAgent(company.companyId, "Lead");
    const member = await seedAgent(company.companyId, "Member");
    const team = await seedTeam(company.companyId, "Platform", lead.id, [member.id]);
    const app = routeApp(ctx.db, company.actor, issueRoutes);
    return { ...company, lead, member, team, app };
  }

  it("creates a task for a team: the lead is the assignee and the team is stored", async () => {
    const { companyId, app, lead, team } = await seed();
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Team task", status: "backlog", teamId: team.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ assigneeAgentId: lead.id, assigneeUserId: null, teamId: team.id });
  });

  it("assigns an existing task to a team, and clears the team on request", async () => {
    const { companyId, app, lead, member, team } = await seed();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Loose task", status: "backlog" });
    expect(created.status).toBe(201);

    const assigned = await request(app).patch(`/api/issues/${created.body.id}`).send({ teamId: team.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ assigneeAgentId: lead.id, teamId: team.id });

    // Picking a plain agent clears the team.
    const reassigned = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .send({ teamId: null, assigneeAgentId: member.id });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body).toMatchObject({ assigneeAgentId: member.id, teamId: null });
  });

  it("refuses a team with no lead, with a clear message", async () => {
    const { companyId, app } = await seed();
    const leaderless = await seedTeam(companyId, "No lead", null);
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Orphan", status: "backlog", teamId: leaderless.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Team "No lead" has no lead');
    expect(res.body.details).toMatchObject({ code: "agent_team_no_lead" });
    expect(await ctx.db.select().from(issues)).toEqual([]);
  });

  it("refuses an assignee that is not the team lead", async () => {
    const { companyId, app, member, team } = await seed();
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Mismatch", status: "backlog", teamId: team.id, assigneeAgentId: member.id });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "agent_team_assignee_mismatch" });
  });

  it("refuses a team from another company", async () => {
    const { companyId, app } = await seed();
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other co");
    const otherLead = await seedAgent(other.companyId, "Other lead");
    const otherTeam = await seedTeam(other.companyId, "Theirs", otherLead.id);
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cross", status: "backlog", teamId: otherTeam.id });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "agent_team_not_found" });
  });

  it("filters the issue list by team", async () => {
    const { companyId, app, team } = await seed();
    const teamTask = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "In team", status: "backlog", teamId: team.id });
    await request(app).post(`/api/companies/${companyId}/issues`).send({ title: "Not in team", status: "backlog" });

    const filtered = await request(app).get(`/api/companies/${companyId}/issues`).query({ teamId: team.id });
    expect(filtered.status).toBe(200);
    expect((filtered.body as Array<{ id: string; teamId: string | null }>).map((i) => [i.id, i.teamId])).toEqual([
      [teamTask.body.id, team.id],
    ]);

    const bad = await request(app).get(`/api/companies/${companyId}/issues`).query({ teamId: "nope" });
    expect(bad.status).toBe(422);
  });

  it("gives the lead the other active team members to delegate to", async () => {
    const { companyId, lead, member, team } = await seed();
    const gone = await seedAgent(companyId, "Gone", "terminated");
    await agentTeamService(ctx.db).addMember(team, gone.id);

    const context = await agentTeamService(ctx.db).getDelegationContext(companyId, team.id);
    expect(context).toMatchObject({ id: team.id, name: "Platform", leadAgentId: lead.id });
    expect(context!.members.map((m) => m.id)).toEqual([member.id]);
    // Another company cannot read it.
    const other = await seedCompanyWithBoardAccess(ctx.db, "Nosy co");
    expect(await agentTeamService(ctx.db).getDelegationContext(other.companyId, team.id)).toBeNull();
  });
});

it("lists the team members in the lead's task context", () => {
  const markdown = buildPaperclipTaskMarkdown({
    issue: { id: "i1", identifier: "GRE-1", title: "Team task" },
    team: {
      id: "t1",
      name: "Platform",
      members: [
        { id: "a2", name: "Mica", role: "engineer", title: "UI Engineer" },
        { id: "a3", name: "Ridge", role: "engineer", title: null },
      ],
    },
  });
  expect(markdown).toContain('Team context: this task is assigned to team "Platform" and you are its lead.');
  expect(markdown).toContain("- Mica (UI Engineer, engineer): agent a2");
  expect(markdown).toContain("- Ridge (engineer): agent a3");
});
