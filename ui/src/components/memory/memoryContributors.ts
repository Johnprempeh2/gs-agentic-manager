import type { AgentAppearance, MemoryActorRef, MemoryGraphContributor, MemoryGraphNode } from "@greatstone/shared";
import { actorLabel } from "./memoryLabels";

/**
 * Contributors on the Memory page: who wrote the entries the server returned, how
 * many each, and which one is the main agent (the CEO). Pure, so it is cheap to test.
 * Built only from the permitted graph data plus the agent list the caller may read.
 */

/** What the Memory page needs to know about an agent from the agent list. */
export interface MemoryAgentInfo {
  id: string;
  name: string;
  /** The agent role (`ceo` for the main agent). Missing when the list did not say. */
  role?: string | null;
  appearance?: AgentAppearance | null;
}

export interface MemoryContributor {
  /** Focus key, as kept in `?agent=`: the agent id, `user:<id>` for a person, or the actor type. */
  key: string;
  name: string;
  actorType: MemoryActorRef["actorType"];
  count: number;
  isCeo: boolean;
  /** The agent from the agent list, when the contributor is an agent the caller can see. */
  agent: MemoryAgentInfo | null;
}

export const CEO_ROLE = "ceo";
/** Used only when no agent carries a role at all (an older agent list, or none loaded). */
export const CEO_FALLBACK_NAME = "Everest";

/** The key a contributor is focused by. Agent ids stay bare so `?agent=<agentId>` links keep working. */
export function contributorFocusKey(actor: MemoryActorRef): string {
  if (actor.actorType === "agent" && actor.agentId) return actor.agentId;
  if (actor.actorType === "user" && actor.userId) return `user:${actor.userId}`;
  return actor.actorType;
}

function nameMatchesFallback(name: string | null | undefined) {
  return Boolean(name && new RegExp(`^${CEO_FALLBACK_NAME}\\b`, "i").test(name.trim()));
}

/**
 * The main agent's id. The role decides: the first agent with role `ceo`. Only when
 * the agent list carries no roles at all (or is empty) does the name decide, first
 * from the list and then from the contributors in the graph.
 */
export function findCeoAgentId(agents: MemoryAgentInfo[], contributors: MemoryActorRef[] = []): string | null {
  const byRole = agents.find((agent) => agent.role === CEO_ROLE);
  if (byRole) return byRole.id;
  const rolesKnown = agents.some((agent) => typeof agent.role === "string" && agent.role.length > 0);
  if (rolesKnown) return null;
  const byName = agents.find((agent) => nameMatchesFallback(agent.name));
  if (byName) return byName.id;
  const contributor = contributors.find((actor) => actor.actorType === "agent" && actor.agentId && nameMatchesFallback(actor.name));
  return contributor?.agentId ?? null;
}

/**
 * One row per contributor, the main agent first, then by entry count. `totals` are the
 * server's counts over every matching entry; with them, a contributor whose entries are
 * all older than the loaded ones still gets a row and its real count.
 */
export function listContributors(
  nodes: MemoryGraphNode[],
  agents: MemoryAgentInfo[],
  totals?: MemoryGraphContributor[],
): MemoryContributor[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const ceoId = findCeoAgentId(agents, [...(totals ?? []).map((total) => total.contributor), ...nodes.map((node) => node.contributor)]);
  const rows = new Map<string, MemoryContributor>();
  const add = (actor: MemoryActorRef, count: number) => {
    const key = contributorFocusKey(actor);
    const existing = rows.get(key);
    if (existing) {
      existing.count += count;
      return;
    }
    const agent = actor.actorType === "agent" && actor.agentId ? agentsById.get(actor.agentId) ?? null : null;
    rows.set(key, {
      key,
      name: agent?.name ?? actorLabel(actor),
      actorType: actor.actorType,
      count,
      isCeo: ceoId !== null && actor.actorType === "agent" && actor.agentId === ceoId,
      agent,
    });
  };
  if (totals) {
    for (const total of totals) add(total.contributor, total.count);
    // Loaded entries the totals missed (a write since the count); never double counted.
    const counted = new Set(rows.keys());
    for (const node of nodes) if (!counted.has(contributorFocusKey(node.contributor))) add(node.contributor, 1);
  } else {
    for (const node of nodes) add(node.contributor, 1);
  }
  return [...rows.values()].sort((a, b) => Number(b.isCeo) - Number(a.isCeo) || b.count - a.count || a.name.localeCompare(b.name));
}

/** `?agent=a,b` to a list of focus keys (empty means all agents). */
export function parseAgentFocus(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

export function formatAgentFocus(keys: string[]): string | undefined {
  return keys.length > 0 ? keys.join(",") : undefined;
}
