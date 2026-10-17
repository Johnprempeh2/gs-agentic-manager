import type { Agent } from "@greatstone/shared";

type AgentLike = Pick<Agent, "id" | "name" | "status" | "runtimeConfig">;

function heartbeatOf(agent: Pick<Agent, "runtimeConfig">): Record<string, unknown> {
  const runtime = agent.runtimeConfig;
  const heartbeat = runtime && typeof runtime === "object" ? (runtime as Record<string, unknown>).heartbeat : null;
  return heartbeat && typeof heartbeat === "object" ? (heartbeat as Record<string, unknown>) : {};
}

/**
 * Agents that wake on a timer and still run when nothing has changed since
 * their last run: no new task, comment or state change. Those runs cost usage
 * and do nothing, so the Agents page offers to skip them.
 */
export function agentsRunningEmptyTimers<T extends AgentLike>(agents: readonly T[]): T[] {
  return agents.filter((agent) => {
    if (agent.status === "terminated") return false;
    const heartbeat = heartbeatOf(agent);
    return heartbeat.enabled === true && heartbeat.skipTimerWhenNothingChanged !== true;
  });
}

/** The runtime config to save so the agent skips timer runs when nothing has changed. */
export function withEmptyTimerSkip(agent: Pick<Agent, "runtimeConfig">): Record<string, unknown> {
  const runtime = (agent.runtimeConfig && typeof agent.runtimeConfig === "object" ? agent.runtimeConfig : {}) as Record<string, unknown>;
  return { ...runtime, heartbeat: { ...heartbeatOf(agent), skipTimerWhenNothingChanged: true } };
}
