import type { AgentWorkDigest } from "@greatstone/shared";

/**
 * "Copy as an update" on Since you were last here: the headline, then each
 * agent's lines, newest first, ready to paste into a message.
 */
export function digestText(digest: Pick<AgentWorkDigest, "agents">, headline: string): string {
  const lines = [headline];
  for (const agent of digest.agents) {
    if (agent.items.length === 0) continue;
    lines.push("", agent.agentName);
    for (const item of agent.items) lines.push(`• ${item.label}`);
  }
  return lines.join("\n");
}
