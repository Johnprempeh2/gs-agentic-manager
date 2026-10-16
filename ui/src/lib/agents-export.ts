import { AGENT_ROLE_LABELS, type Agent, type AgentStatus, type AgentTeam } from "@greatstone/shared";
import type { Sheet } from "./spreadsheet-export";
import { formatShortDate } from "./utils";

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

/**
 * "Copy as an update" on Agents: how the team stands right now.
 *
 *   Team, 16 Oct
 *   3 agents: 1 working now, 1 needs attention, 1 idle.
 *
 *   • Ridge, Head of sales: Working now
 */
export function agentsUpdateText(agents: readonly Agent[], relative: (at: Date | string) => string, now: Date = new Date()): string {
  const live = agents.filter((agent) => agent.status !== "terminated");
  const lines = [`Team, ${formatShortDate(now)}`];
  if (live.length === 0) return `${lines[0]}\n\nNo agents yet.`;
  const order: AgentStatus[] = ["error", "running", "pending_approval", "active", "idle", "paused"];
  const counts = order
    .map((status) => [status, live.filter((agent) => agent.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${AGENT_STATUS_WORDS[status].toLowerCase()}`);
  lines.push(`${live.length} ${live.length === 1 ? "agent" : "agents"}: ${counts.join(", ")}.`, "");
  const sorted = [...live].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  for (const agent of sorted) {
    const who = agent.title ? `${agent.name}, ${agent.title}` : agent.name;
    const last = agent.lastHeartbeatAt && agent.status !== "running" ? `, last active ${relative(agent.lastHeartbeatAt)}` : "";
    lines.push(`• ${who}: ${AGENT_STATUS_WORDS[agent.status]}${last}`);
  }
  return lines.join("\n");
}

/**
 * A warning on an agent row as its monthly budget runs low: "82% of budget"
 * from 80%, "Budget used up" at 100%. Nothing below 80% or with no budget.
 */
export function budgetUseLabel(agent: Pick<Agent, "budgetMonthlyCents" | "spentMonthlyCents">): { text: string; tone: "warning" | "danger" } | null {
  if (agent.budgetMonthlyCents <= 0) return null;
  const percent = Math.floor((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100);
  if (percent >= 100) return { text: "Budget used up", tone: "danger" };
  if (percent >= 80) return { text: `${percent}% of budget`, tone: "warning" };
  return null;
}
