import {
  AI_ACCESS_ROUTABLE_ADAPTER_TYPES,
  AI_ACCESS_ROUTE_DEFINITIONS,
  aiAccessRouteSchema,
  type AiAccessRoute,
  type AiConnectionBinding,
} from "@greatstone/shared";
import type { Db } from "@greatstone/db";
import { unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";

// Keys only one harness reads. A Claude model, flag or command would break a
// Codex run (and the reverse), so a harness switch drops them and the target
// harness uses its own defaults. Both harnesses default to unattended runs.
const HARNESS_SPECIFIC_CONFIG_KEYS = [
  "command",
  "model",
  "args",
  "extraArgs",
  "effort",
  "modelReasoningEffort",
  "search",
  "chrome",
  "maxTurnsPerRun",
  "dangerouslySkipPermissions",
  "dangerouslyBypassApprovalsAndSandbox",
  "dangerouslyBypassSandbox",
  "engine",
  "mode",
  "agentCommand",
  "permissionMode",
  "nonInteractivePermissions",
  "stateDir",
  "warmHandleIdleMs",
  "acpAgentCommand",
  "acpMode",
  "acpPermissionMode",
  "acpNonInteractivePermissions",
  "acpStateDir",
  "acpWarmHandleIdleMs",
  "terminalResultCleanupGraceMs",
] as const;

/** The stored setting, or null when each agent keeps its own harness and connection. */
export function readAiAccessRoute(general: { aiAccessRoute?: unknown } | null | undefined): AiAccessRoute | null {
  const parsed = aiAccessRouteSchema.safeParse(general?.aiAccessRoute);
  return parsed.success ? parsed.data : null;
}

type RoutableAgent = {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
};

/**
 * The agent as a run on this route sees it. Nothing is written back: clearing
 * the setting returns every agent to its stored harness and connection. Task
 * sessions are keyed by harness, so a switch starts a fresh provider session.
 */
export function applyAiAccessRoute<T extends RoutableAgent>(agent: T, route: AiAccessRoute | null): T {
  if (!route) return agent;
  if (!(AI_ACCESS_ROUTABLE_ADAPTER_TYPES as readonly string[]).includes(agent.adapterType)) return agent;
  const definition = AI_ACCESS_ROUTE_DEFINITIONS[route];
  let adapterConfig = agent.adapterConfig ?? {};
  if (agent.adapterType !== definition.adapterType) {
    adapterConfig = { ...adapterConfig };
    for (const key of HARNESS_SPECIFIC_CONFIG_KEYS) delete adapterConfig[key];
  }
  const aiConnection: AiConnectionBinding = {
    provider: definition.provider,
    method: definition.method,
    mode: "responsible_user",
  };
  return {
    ...agent,
    adapterType: definition.adapterType,
    adapterConfig,
    runtimeConfig: { ...(agent.runtimeConfig ?? {}), aiConnection, aiAccessRoute: route },
  };
}

/** The route recorded on an agent by applyAiAccessRoute, if any. */
export function agentAiAccessRoute(agent: { runtimeConfig?: Record<string, unknown> | null }): AiAccessRoute | null {
  return readAiAccessRoute({ aiAccessRoute: agent.runtimeConfig?.aiAccessRoute });
}

/**
 * Pick the account a route run uses: the responsible user's own default for
 * the route's provider when its sign-in method matches, else a company-shared
 * account of that provider and method. Never the host's login. No account is a
 * board-owned configuration blocker with a clear message, not a retry.
 */
export async function resolveAiAccessRouteBinding(
  db: Db,
  input: { companyId: string; responsibleUserId: string | null; route: AiAccessRoute },
): Promise<AiConnectionBinding> {
  const definition = AI_ACCESS_ROUTE_DEFINITIONS[input.route];
  const missing = (detail: string) =>
    unprocessable(
      `This install uses ${definition.label} for AI access. ${detail}`,
      { code: "ai_connection_default_missing", aiAccessRoute: input.route },
    );
  if (!input.responsibleUserId)
    throw missing("This run has no responsible user, so no account can be chosen. Assign the task from a signed-in member.");
  const accounts = (await aiConnectionService(db).list(input.companyId, input.responsibleUserId)).filter(
    (account) => account.provider === definition.provider && account.method === definition.method,
  );
  const personal = accounts.find((account) => account.ownership === "personal" && account.isDefault);
  if (personal) return { provider: definition.provider, method: definition.method, mode: "responsible_user" };
  const shared = accounts.find((account) => account.ownership === "shared" && account.status === "connected")
    ?? accounts.find((account) => account.ownership === "shared");
  if (shared)
    return {
      provider: definition.provider,
      method: definition.method,
      mode: "shared",
      connectionId: shared.id,
      grantId: shared.grantId,
    };
  throw missing(`Connect a ${definition.label} account in Apps and make it your default, or connect a shared one for the company.`);
}
