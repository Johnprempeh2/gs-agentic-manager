import { AGENT_ROLE_LABELS, type Agent, type AgentStatus, type AgentTeam } from "@greatstone/shared";
import type { Sheet } from "./spreadsheet-export";

/**
 * "Download as spreadsheet" on Agents: the team as it stands today, one row
 * per agent, with who they report to and what they have spent this month.
 */

export const AGENT_STATUS_WORDS: Record<AgentStatus, string> = {
  active: "Active",
  paused: "Paused",
  idle: "Idle",
  running: "Working now",
  error: "Needs attention",
  pending_approval: "Waiting for approval",
  terminated: "Removed",
};

const dollars = (cents: number) => Math.round(cents) / 100;

function isoDay(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function agentsSheet(
  agents: readonly Agent[],
  teamsForAgent: ReadonlyMap<string, readonly AgentTeam[]> = new Map(),
): Sheet {
  const nameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  return {
    name: "Agents",
    headers: ["Agent", "Role", "Title", "Status", "Reports to", "Teams", "Monthly budget ($)", "Spent this month ($)", "Last active"],
    rows: [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => [
        agent.name,
        (AGENT_ROLE_LABELS as Record<string, string>)[agent.role] ?? agent.role,
        agent.title ?? "",
        AGENT_STATUS_WORDS[agent.status] ?? agent.status,
        agent.reportsTo ? (nameById.get(agent.reportsTo) ?? "") : "",
        (teamsForAgent.get(agent.id) ?? []).map((team) => team.name).join(", "),
        agent.budgetMonthlyCents > 0 ? dollars(agent.budgetMonthlyCents) : "",
        dollars(agent.spentMonthlyCents),
        isoDay(agent.lastHeartbeatAt),
      ]),
  };
}
