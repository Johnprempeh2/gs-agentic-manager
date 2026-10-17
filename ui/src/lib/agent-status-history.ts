import type { ActivityEvent } from "@greatstone/shared";

/** The agent events that change whether the agent works, in plain words. */
export const AGENT_STATUS_ACTIONS: Record<string, string> = {
  "agent.created": "Added",
  "agent.hire_created": "Hire requested",
  "agent.approved": "Hire approved",
  "agent.paused": "Paused",
  "agent.resumed": "Resumed",
  "agent.error_cleared": "Error cleared",
  "agent.budget_updated": "Monthly budget changed",
  "agent.config_rolled_back": "Settings rolled back",
  "agent.terminated": "Removed",
};

export interface AgentStatusHistoryRow {
  id: string;
  label: string;
  by: string;
  at: Date;
}

function byWhom(event: Pick<ActivityEvent, "actorType">): string {
  if (event.actorType === "user") return "by the board";
  if (event.actorType === "agent") return "by an agent";
  return "automatically";
}

/** Newest first, one row per status event, with who did it. */
export function agentStatusHistory(events: readonly ActivityEvent[]): AgentStatusHistoryRow[] {
  return events
    .filter((event) => event.action in AGENT_STATUS_ACTIONS)
    .map((event) => ({
      id: event.id,
      label: AGENT_STATUS_ACTIONS[event.action]!,
      by: byWhom(event),
      at: new Date(event.createdAt),
    }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}
