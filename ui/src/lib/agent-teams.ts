import type { AgentTeam } from "@greatstone/shared";

/** Team filter value meaning "agents in no team". */
export const NO_TEAM_FILTER = "none";

/** agentId -> the teams the agent is in, in team-name order. */
export function teamsByAgent(teams: readonly AgentTeam[]): Map<string, AgentTeam[]> {
  const map = new Map<string, AgentTeam[]>();
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  for (const team of sorted) {
    for (const agentId of team.memberAgentIds) {
      const list = map.get(agentId) ?? [];
      list.push(team);
      map.set(agentId, list);
    }
  }
  return map;
}

/**
 * Keeps agents in the chosen team. `null` keeps everyone; `NO_TEAM_FILTER`
 * keeps agents in no team. An unknown team id keeps no one.
 */
export function filterAgentsByTeam<T extends { id: string }>(
  agents: readonly T[],
  teams: readonly AgentTeam[],
  teamFilter: string | null,
): T[] {
  if (!teamFilter) return [...agents];
  if (teamFilter === NO_TEAM_FILTER) {
    const inAnyTeam = new Set(teams.flatMap((team) => team.memberAgentIds));
    return agents.filter((agent) => !inAnyTeam.has(agent.id));
  }
  const members = new Set(teams.find((team) => team.id === teamFilter)?.memberAgentIds ?? []);
  return agents.filter((agent) => members.has(agent.id));
}

export interface TeamGroup<T> {
  /** `null` for the "No team" group. */
  team: AgentTeam | null;
  agents: T[];
}

/**
 * Groups agents by team for the org chart's "group by team" view. An agent in
 * two teams shows in both groups. Agents in no team land in a final "No team"
 * group, left out when empty. Teams with no visible members are left out.
 */
export function groupAgentsByTeam<T extends { id: string; name: string }>(
  agents: readonly T[],
  teams: readonly AgentTeam[],
): TeamGroup<T>[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const groups: TeamGroup<T>[] = [];
  const placed = new Set<string>();
  for (const team of [...teams].sort((a, b) => a.name.localeCompare(b.name))) {
    const members = team.memberAgentIds
      .map((id) => byId.get(id))
      .filter((agent): agent is T => Boolean(agent))
      .sort(byName);
    // The lead goes first.
    const leadIndex = members.findIndex((agent) => agent.id === team.leadAgentId);
    if (leadIndex > 0) members.unshift(...members.splice(leadIndex, 1));
    if (members.length === 0) continue;
    members.forEach((agent) => placed.add(agent.id));
    groups.push({ team, agents: members });
  }
  const loose = agents.filter((agent) => !placed.has(agent.id)).sort(byName);
  if (loose.length > 0) groups.push({ team: null, agents: loose });
  return groups;
}

/** Shown when a team with no lead is offered as an assignee (GRE-437). */
export const TEAM_NO_LEAD_MESSAGE = "No lead. Set a team lead on the Agents page first.";

/**
 * The issue update that assigns a task to a team: the lead becomes the
 * assignee and the team is stored. `null` when the team has no lead, so it
 * cannot be picked.
 */
export function teamAssignmentPatch(
  team: Pick<AgentTeam, "id" | "leadAgentId">,
): { teamId: string; assigneeAgentId: string; assigneeUserId: null } | null {
  if (!team.leadAgentId) return null;
  return { teamId: team.id, assigneeAgentId: team.leadAgentId, assigneeUserId: null };
}

const TEAM_ASSIGNEE_PREFIX = "team:";

/** Assignee picker value for a team, beside `agent:<id>` and `user:<id>`. */
export function teamAssigneeValue(teamId: string): string {
  return `${TEAM_ASSIGNEE_PREFIX}${teamId}`;
}

export function isTeamAssigneeValue(value: string): boolean {
  return value.startsWith(TEAM_ASSIGNEE_PREFIX);
}

/** The team a `team:<id>` picker value points at, when it can be picked (has a lead). */
export function teamForAssigneeValue(value: string, teams: readonly AgentTeam[] | undefined): AgentTeam | null {
  if (!isTeamAssigneeValue(value)) return null;
  const id = value.slice(TEAM_ASSIGNEE_PREFIX.length);
  const team = (teams ?? []).find((candidate) => candidate.id === id);
  return team?.leadAgentId ? team : null;
}
