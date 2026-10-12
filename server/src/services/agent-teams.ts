import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, agentTeamMembers, agentTeams } from "@greatstone/db";
import type { AgentTeam, CreateAgentTeam, UpdateAgentTeam } from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, unprocessable } from "../errors.js";

type TeamRow = typeof agentTeams.$inferSelect;

// Teams (GRE-436) only group agents. Nothing here touches `agents.reports_to`
// or task assignment.
export function agentTeamService(db: Db) {
  async function assertAgentsInCompany(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    if (rows.length !== agentIds.length) {
      throw unprocessable("Every team member and the lead must be an agent in this company");
    }
  }

  async function membersByTeam(teamIds: string[]) {
    const byTeam = new Map<string, string[]>();
    if (teamIds.length === 0) return byTeam;
    const rows = await db
      .select({ teamId: agentTeamMembers.teamId, agentId: agentTeamMembers.agentId })
      .from(agentTeamMembers)
      .where(inArray(agentTeamMembers.teamId, teamIds))
      .orderBy(asc(agentTeamMembers.createdAt));
    for (const row of rows) {
      const list = byTeam.get(row.teamId) ?? [];
      list.push(row.agentId);
      byTeam.set(row.teamId, list);
    }
    return byTeam;
  }

  function toTeam(row: TeamRow, memberAgentIds: string[]): AgentTeam {
    return { ...row, memberAgentIds };
  }

  async function withMembers(row: TeamRow) {
    const members = await membersByTeam([row.id]);
    return toTeam(row, members.get(row.id) ?? []);
  }

  function uniqueIds(ids: Array<string | null | undefined>) {
    return [...new Set(ids.filter((id): id is string => Boolean(id)))];
  }

  async function getById(id: string) {
    const row = await db.select().from(agentTeams).where(eq(agentTeams.id, id)).then((rows) => rows[0] ?? null);
    return row ? withMembers(row) : null;
  }

  async function writeTeam<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error, "agent_teams_company_name_uq")) {
        throw conflict("A team with this name already exists");
      }
      throw error;
    }
  }

  return {
    async list(companyId: string): Promise<AgentTeam[]> {
      const rows = await db
        .select()
        .from(agentTeams)
        .where(eq(agentTeams.companyId, companyId))
        .orderBy(asc(agentTeams.name));
      const members = await membersByTeam(rows.map((row) => row.id));
      return rows.map((row) => toTeam(row, members.get(row.id) ?? []));
    },

    getById,

    async create(companyId: string, input: CreateAgentTeam): Promise<AgentTeam> {
      const leadAgentId = input.leadAgentId ?? null;
      const memberIds = uniqueIds([leadAgentId, ...(input.memberAgentIds ?? [])]);
      await assertAgentsInCompany(companyId, memberIds);
      const row = await writeTeam(() =>
        db.transaction(async (tx) => {
          const [team] = await tx
            .insert(agentTeams)
            .values({
              companyId,
              name: input.name,
              color: input.color,
              description: input.description ?? null,
              leadAgentId,
            })
            .returning();
          if (memberIds.length > 0) {
            await tx
              .insert(agentTeamMembers)
              .values(memberIds.map((agentId) => ({ companyId, teamId: team.id, agentId })));
          }
          return team;
        }),
      );
      return withMembers(row);
    },

    async update(existing: AgentTeam, input: UpdateAgentTeam): Promise<AgentTeam> {
      const leadAgentId = input.leadAgentId === undefined ? existing.leadAgentId : input.leadAgentId;
      const memberIds =
        input.memberAgentIds === undefined ? null : uniqueIds([leadAgentId, ...input.memberAgentIds]);
      await assertAgentsInCompany(existing.companyId, uniqueIds([leadAgentId, ...(memberIds ?? [])]));
      const row = await writeTeam(() =>
        db.transaction(async (tx) => {
          const [team] = await tx
            .update(agentTeams)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.color !== undefined ? { color: input.color } : {}),
              ...(input.description !== undefined ? { description: input.description ?? null } : {}),
              leadAgentId,
              updatedAt: new Date(),
            })
            .where(eq(agentTeams.id, existing.id))
            .returning();
          if (memberIds) {
            await tx.delete(agentTeamMembers).where(eq(agentTeamMembers.teamId, existing.id));
            if (memberIds.length > 0) {
              await tx
                .insert(agentTeamMembers)
                .values(memberIds.map((agentId) => ({ companyId: existing.companyId, teamId: existing.id, agentId })));
            }
          } else if (leadAgentId) {
            await tx
              .insert(agentTeamMembers)
              .values({ companyId: existing.companyId, teamId: existing.id, agentId: leadAgentId })
              .onConflictDoNothing();
          }
          return team;
        }),
      );
      return withMembers(row);
    },

    /**
     * Turns a task's `teamId` into its assignee (GRE-437): the team lead.
     * Mutates `body` in place so the usual assignment checks, permission
     * checks and wakes see a normal agent assignment. `teamId: null` only
     * clears the team.
     */
    async applyTeamAssignment(
      companyId: string,
      body: { teamId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null },
    ) {
      if (!body.teamId) return;
      const team = await getById(body.teamId);
      if (!team || team.companyId !== companyId) {
        throw unprocessable("Team not found in this company", { code: "agent_team_not_found" });
      }
      if (!team.leadAgentId) {
        throw unprocessable(
          `Team "${team.name}" has no lead. Set a team lead on the Agents page, or assign the task to an agent.`,
          { code: "agent_team_no_lead", teamId: team.id },
        );
      }
      if (body.assigneeUserId) {
        throw unprocessable("A task assigned to a team cannot also be assigned to a user");
      }
      if (body.assigneeAgentId && body.assigneeAgentId !== team.leadAgentId) {
        throw unprocessable(`A task assigned to team "${team.name}" goes to the team lead`, {
          code: "agent_team_assignee_mismatch",
          teamId: team.id,
        });
      }
      body.assigneeAgentId = team.leadAgentId;
      if (body.assigneeUserId === undefined) body.assigneeUserId = null;
    },

    /**
     * What a team lead needs to delegate a team task (GRE-437): the team and
     * its other members. Terminated agents are left out.
     */
    async getDelegationContext(companyId: string, teamId: string) {
      const team = await getById(teamId);
      if (!team || team.companyId !== companyId) return null;
      const memberIds = team.memberAgentIds.filter((id) => id !== team.leadAgentId);
      const members =
        memberIds.length === 0
          ? []
          : await db
              .select({ id: agents.id, name: agents.name, role: agents.role, title: agents.title, status: agents.status })
              .from(agents)
              .where(and(eq(agents.companyId, companyId), inArray(agents.id, memberIds)))
              .orderBy(asc(agents.name));
      return {
        id: team.id,
        name: team.name,
        leadAgentId: team.leadAgentId,
        members: members
          .filter((member) => member.status !== "terminated")
          .map(({ id, name, role, title }) => ({ id, name, role, title })),
      };
    },

    async remove(id: string) {
      const [row] = await db.delete(agentTeams).where(eq(agentTeams.id, id)).returning();
      return row ?? null;
    },

    async addMember(team: AgentTeam, agentId: string): Promise<AgentTeam> {
      await assertAgentsInCompany(team.companyId, [agentId]);
      await db
        .insert(agentTeamMembers)
        .values({ companyId: team.companyId, teamId: team.id, agentId })
        .onConflictDoNothing();
      return (await getById(team.id))!;
    },

    async removeMember(team: AgentTeam, agentId: string): Promise<AgentTeam> {
      await db.transaction(async (tx) => {
        await tx
          .delete(agentTeamMembers)
          .where(and(eq(agentTeamMembers.teamId, team.id), eq(agentTeamMembers.agentId, agentId)));
        // The lead is always a member, so removing the lead clears the lead.
        if (team.leadAgentId === agentId) {
          await tx
            .update(agentTeams)
            .set({ leadAgentId: null, updatedAt: new Date() })
            .where(eq(agentTeams.id, team.id));
        }
      });
      return (await getById(team.id))!;
    },
  };
}
