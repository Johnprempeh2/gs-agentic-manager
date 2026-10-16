import {
  isToolConnectionAttentionHealth,
  type AgentAccessAgentSummary,
  type AgentAccessItem,
  type AgentAccessItemState,
  type AgentAccessSummary,
  type ConnectionGrantKind,
  type ConnectionGrantStatus,
  type ToolConnectionCredentialPolicy,
  type ToolConnectionHealthStatus,
} from "@greatstone/shared";

/**
 * Pure derivation of the per-agent Access summary. `listAgentAccess` in
 * `tool-access.ts` loads the rows in a fixed number of bulk queries and hands
 * them here, so the state rules can be tested without a database.
 *
 * The output is an explicit allow-list: no provider tenant data, no secret
 * ids or values and no token hashes ever leave this function.
 */

/** Same window the credential rotation check in `tool-access.ts` uses. */
export const AGENT_ACCESS_EXPIRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

type DateLike = Date | string | null | undefined;

export interface AgentAccessAgentInput {
  id: string;
  name: string;
}

export interface AgentAccessConnectionInput {
  id: string;
  name: string;
  healthStatus: ToolConnectionHealthStatus;
  credentialPolicy: ToolConnectionCredentialPolicy;
  credentialSecretRefs: ReadonlyArray<{ expiresAt?: string | null }>;
}

export interface AgentAccessInstallInput {
  connectionId: string;
  targetType: string;
  targetId: string;
}

export interface AgentAccessGrantInput {
  id: string;
  connectionId: string;
  kind: ConnectionGrantKind;
  subjectAgentId: string | null;
  status: ConnectionGrantStatus;
  isDefault?: boolean;
  lastUsedAt?: DateLike;
  refreshTokenExpiresAt?: string | null;
  webhookHealth?: "pending" | "healthy" | "unhealthy" | null;
  credentialSecretRefs?: ReadonlyArray<{ expiresAt?: string | null }>;
}

export interface AgentAccessDelegationInput {
  grantId: string;
  agentId: string;
}

export interface AgentAccessMcpTokenInput {
  id: string;
  name: string;
  subjectId: string | null;
  expiresAt?: DateLike;
  lastUsedAt?: DateLike;
}

export interface AgentAccessSecretBindingInput {
  id: string;
  agentId: string;
  configPath: string;
  label: string | null;
  required: boolean;
  secretName: string | null;
  secretStatus: string | null;
  secretDeletedAt?: DateLike;
  secretLastResolvedAt?: DateLike;
}

export interface AgentAccessChannelInput {
  id: string;
  connectionId: string;
  provider: string;
  assignedAgentId: string;
  status: string;
  label: string | null;
  lastEventAt?: DateLike;
}

export interface AgentAccessInput {
  now: Date;
  agents: ReadonlyArray<AgentAccessAgentInput>;
  connections: ReadonlyArray<AgentAccessConnectionInput>;
  installs: ReadonlyArray<AgentAccessInstallInput>;
  grants: ReadonlyArray<AgentAccessGrantInput>;
  delegations: ReadonlyArray<AgentAccessDelegationInput>;
  mcpTokens: ReadonlyArray<AgentAccessMcpTokenInput>;
  secretBindings: ReadonlyArray<AgentAccessSecretBindingInput>;
  channels: ReadonlyArray<AgentAccessChannelInput>;
}

function toIso(value: DateLike): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTime(value: DateLike): number | null {
  const iso = toIso(value);
  return iso ? Date.parse(iso) : null;
}

function latest(values: DateLike[]): string | null {
  let best: number | null = null;
  for (const value of values) {
    const time = toTime(value);
    if (time !== null && (best === null || time > best)) best = time;
  }
  return best === null ? null : new Date(best).toISOString();
}

/** "Expires within a day", "Expires in 1 day" or "Expires in 5 days". */
export function expiresInLabel(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining < DAY_MS) return "Expires within a day";
  const days = Math.floor(remaining / DAY_MS);
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

type Expiry = { state: "failing" | "expiring"; reason: string; expiresAt: string };

/** Earliest expiry inside the 14 day window; an expiry in the past is a failure. */
function soonestExpiry(dates: DateLike[], now: number, expiredReason: string): Expiry | null {
  let soonest: number | null = null;
  for (const value of dates) {
    const time = toTime(value);
    if (time === null) continue;
    if (time > now + AGENT_ACCESS_EXPIRY_WINDOW_MS) continue;
    if (soonest === null || time < soonest) soonest = time;
  }
  if (soonest === null) return null;
  const expiresAt = new Date(soonest).toISOString();
  if (soonest <= now) return { state: "failing", reason: expiredReason, expiresAt };
  return { state: "expiring", reason: expiresInLabel(soonest, now), expiresAt };
}

function healthFailureReason(status: ToolConnectionHealthStatus): string {
  if (status === "missing_secret") return "The key it needs is missing";
  if (status === "degraded") return "Working, but with problems. Check the app";
  return "Not working. It may need to be reconnected";
}

function grantFailureReason(status: ConnectionGrantStatus): string {
  if (status === "expired") return "The sign-in has expired";
  if (status === "revoked") return "Access was removed. It needs to be reconnected";
  if (status === "suspended") return "Access is paused";
  return "Needs to be reconnected";
}

/**
 * The grants that decide whether `agentId` can use `connection`, following
 * the run-time selection in `tool-access.ts`:
 * - `per_agent`: only that agent's own grant.
 * - `per_user`: personal grants delegated to the agent, or an organisation grant.
 * - `shared` and `per_user_with_fallback`: organisation grants. A missing
 *   default organisation grant is created on first use, so it is never "missing".
 */
function relevantGrants(
  connection: AgentAccessConnectionInput,
  agentId: string,
  grantsByConnection: Map<string, AgentAccessGrantInput[]>,
  delegatedGrantIds: Set<string>,
): AgentAccessGrantInput[] {
  const grants = grantsByConnection.get(connection.id) ?? [];
  if (connection.credentialPolicy === "per_agent") {
    return grants.filter((grant) => grant.kind === "agent" && grant.subjectAgentId === agentId);
  }
  if (connection.credentialPolicy === "per_user") {
    return grants.filter(
      (grant) =>
        grant.kind === "organization" ||
        (grant.kind === "user" && delegatedGrantIds.has(grant.id)),
    );
  }
  return grants.filter((grant) => grant.kind === "organization");
}

function connectionItem(
  connection: AgentAccessConnectionInput,
  agentId: string,
  grantsByConnection: Map<string, AgentAccessGrantInput[]>,
  delegatedGrantIds: Set<string>,
  now: number,
): AgentAccessItem {
  const grants = relevantGrants(connection, agentId, grantsByConnection, delegatedGrantIds);
  const activeGrants = grants.filter((grant) => grant.status === "active");
  const inForce = activeGrants.length > 0 ? activeGrants : grants;
  const base = {
    kind: "connection" as const,
    id: connection.id,
    label: connection.name,
    connectionId: connection.id,
    lastUsedAt: latest(grants.map((grant) => grant.lastUsedAt)),
    expiresAt: null as string | null,
  };
  const result = (state: AgentAccessItemState, reason: string | null, expiresAt?: string | null): AgentAccessItem => ({
    ...base,
    state,
    reason,
    expiresAt: expiresAt ?? null,
  });

  if (isToolConnectionAttentionHealth(connection.healthStatus)) {
    return result("failing", healthFailureReason(connection.healthStatus));
  }

  if (connection.credentialPolicy === "per_agent" && grants.length === 0) {
    return result("missing", "No sign-in set up for this agent");
  }
  if (connection.credentialPolicy === "per_user" && grants.length === 0) {
    // At run time a personal app uses the sign-in of the person responsible
    // for the work, which this summary cannot see, so it is not called missing.
    return result("unchecked", "Uses the sign-in of the person responsible for the work");
  }
  if (activeGrants.length === 0 && grants.length > 0) {
    const preferred = grants.find((grant) => grant.isDefault) ?? grants[0]!;
    return result("failing", grantFailureReason(preferred.status));
  }
  if (inForce.some((grant) => grant.webhookHealth === "unhealthy")) {
    return result("failing", "GitHub has stopped sending updates. Reconnect it");
  }

  const expiry = soonestExpiry(
    [
      ...inForce.map((grant) => grant.refreshTokenExpiresAt),
      ...connection.credentialSecretRefs.map((ref) => ref.expiresAt),
      ...inForce.flatMap((grant) => (grant.credentialSecretRefs ?? []).map((ref) => ref.expiresAt)),
    ],
    now,
    "The sign-in has expired",
  );
  if (expiry) return result(expiry.state, expiry.reason, expiry.expiresAt);

  if (connection.healthStatus === "unknown" || connection.healthStatus === "unchecked") {
    return result("unchecked", "Not checked yet");
  }
  return result("ok", null);
}

function mcpTokenItem(token: AgentAccessMcpTokenInput, now: number): AgentAccessItem {
  const expiry = soonestExpiry([token.expiresAt], now, "This key has expired");
  return {
    kind: "mcp_token",
    id: token.id,
    label: token.name,
    connectionId: null,
    state: expiry?.state ?? "ok",
    reason: expiry?.reason ?? null,
    lastUsedAt: toIso(token.lastUsedAt),
    expiresAt: toIso(token.expiresAt),
  };
}

function secretItem(binding: AgentAccessSecretBindingInput): AgentAccessItem {
  const label = binding.label?.trim() || binding.secretName?.trim() || binding.configPath;
  const deleted = !binding.secretStatus || Boolean(toIso(binding.secretDeletedAt));
  const inactive = !deleted && binding.secretStatus !== "active";
  let state: AgentAccessItemState = "ok";
  let reason: string | null = null;
  if (deleted || inactive) {
    const what = deleted ? "has been deleted" : "is turned off";
    if (binding.required) {
      state = "missing";
      reason = `The secret it needs ${what}`;
    } else {
      reason = `Optional. The secret it points to ${what}`;
    }
  }
  return {
    kind: "secret",
    id: binding.id,
    label,
    connectionId: null,
    state,
    reason,
    lastUsedAt: toIso(binding.secretLastResolvedAt),
    expiresAt: null,
  };
}

const CHANNEL_PROVIDER_LABELS: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "Email",
  "imessage-photon": "iMessage",
};

function channelItem(channel: AgentAccessChannelInput): AgentAccessItem {
  const providerLabel = CHANNEL_PROVIDER_LABELS[channel.provider] ?? channel.provider;
  const label = channel.label?.trim() ? `${providerLabel}: ${channel.label.trim()}` : providerLabel;
  let state: AgentAccessItemState = "ok";
  let reason: string | null = null;
  if (channel.status === "attention") {
    state = "failing";
    reason = "This channel needs attention";
  } else if (channel.status === "revoked") {
    state = "failing";
    reason = "Access to this channel was removed";
  } else if (channel.status === "draft") {
    state = "unchecked";
    reason = "Setup is not finished";
  } else if (channel.status === "verifying") {
    state = "unchecked";
    reason = "Still being checked";
  } else if (channel.status === "paused") {
    reason = "Paused";
  }
  return {
    kind: "channel",
    id: channel.id,
    label,
    connectionId: channel.connectionId,
    state,
    reason,
    lastUsedAt: toIso(channel.lastEventAt),
    expiresAt: null,
  };
}

const STATE_ORDER: Record<AgentAccessItemState, number> = {
  failing: 0,
  missing: 1,
  expiring: 2,
  unchecked: 3,
  ok: 4,
};

/** Items that need attention first, then by label. */
export function sortAgentAccessItems(items: AgentAccessItem[]): AgentAccessItem[] {
  return [...items].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.label.localeCompare(b.label),
  );
}

export function deriveAgentAccess(input: AgentAccessInput): AgentAccessSummary {
  const now = input.now.getTime();
  const connectionsById = new Map(input.connections.map((connection) => [connection.id, connection]));

  const companyWideConnectionIds = new Set<string>();
  const agentConnectionIds = new Map<string, Set<string>>();
  for (const install of input.installs) {
    if (!connectionsById.has(install.connectionId)) continue;
    if (install.targetType === "company") {
      companyWideConnectionIds.add(install.connectionId);
    } else if (install.targetType === "agent") {
      const set = agentConnectionIds.get(install.targetId) ?? new Set<string>();
      set.add(install.connectionId);
      agentConnectionIds.set(install.targetId, set);
    }
  }

  const grantsByConnection = new Map<string, AgentAccessGrantInput[]>();
  for (const grant of input.grants) {
    const list = grantsByConnection.get(grant.connectionId) ?? [];
    list.push(grant);
    grantsByConnection.set(grant.connectionId, list);
  }
  const delegatedGrantIdsByAgent = new Map<string, Set<string>>();
  for (const delegation of input.delegations) {
    const set = delegatedGrantIdsByAgent.get(delegation.agentId) ?? new Set<string>();
    set.add(delegation.grantId);
    delegatedGrantIdsByAgent.set(delegation.agentId, set);
  }

  const agents: AgentAccessAgentSummary[] = input.agents.map((agent) => {
    const connectionIds = new Set([
      ...companyWideConnectionIds,
      ...(agentConnectionIds.get(agent.id) ?? []),
    ]);
    const delegatedGrantIds = delegatedGrantIdsByAgent.get(agent.id) ?? new Set<string>();
    const items: AgentAccessItem[] = [
      ...[...connectionIds].map((connectionId) =>
        connectionItem(connectionsById.get(connectionId)!, agent.id, grantsByConnection, delegatedGrantIds, now),
      ),
      ...input.mcpTokens.filter((token) => token.subjectId === agent.id).map((token) => mcpTokenItem(token, now)),
      ...input.secretBindings.filter((binding) => binding.agentId === agent.id).map(secretItem),
      ...input.channels.filter((channel) => channel.assignedAgentId === agent.id).map(channelItem),
    ];
    const counts = { missing: 0, failing: 0, expiring: 0 };
    for (const item of items) {
      if (item.state === "missing" || item.state === "failing" || item.state === "expiring") {
        counts[item.state] += 1;
      }
    }
    return { agentId: agent.id, name: agent.name, items: sortAgentAccessItems(items), counts };
  });

  return { generatedAt: input.now.toISOString(), agents };
}
