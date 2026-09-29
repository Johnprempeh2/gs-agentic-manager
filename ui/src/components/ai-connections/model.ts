/** Redacted presentation contracts shared with the production API. */
import { aiCredentialExpiryState } from "@greatstone/shared";
import type { AiProvider, AiAuthMethod, AiManagedConnectionSummary, AiConnectionBinding, AiCredentialInfo } from "@greatstone/shared";
export type { AiProvider, AiAuthMethod, AiConnectionBinding } from "@greatstone/shared";
export type AiConnectionStatus = AiManagedConnectionSummary["status"];

export const AI_PROVIDERS: Record<
  AiProvider,
  { name: string; subscriptionName?: string; logo?: string }
> = {
  anthropic: {
    name: "Claude",
    subscriptionName: "Claude subscription",
    logo: "/brands/claude-color.svg",
  },
  openai: {
    name: "OpenAI",
    subscriptionName: "ChatGPT subscription",
    logo: "/brands/codex-color.svg",
  },
  openrouter: { name: "OpenRouter", logo: "/brands/apps/openrouter.svg" },
  xai: {
    name: "Grok",
    subscriptionName: "Grok subscription",
    logo: "/brands/adapters/grok.svg",
  },
};

export type AiConnectionSummary = Omit<AiManagedConnectionSummary, "isDefault"> & { isDefault?: boolean };

export interface AiConnectionRequirement {
  companyId: string;
  provider: AiProvider;
  method?: AiAuthMethod;
}

export const AI_CONNECTION_STATUS: Record<AiConnectionStatus, string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  expired: "Expired",
  revoked: "Revoked",
};

export function aiMethodLabel(provider: AiProvider, method: AiAuthMethod) {
  return method === "subscription"
    ? (AI_PROVIDERS[provider].subscriptionName ?? "Subscription unavailable")
    : "API key";
}

export function matchesAiRequirement(
  connection: AiConnectionSummary,
  requirement: AiConnectionRequirement,
) {
  return (
    connection.companyId === requirement.companyId &&
    connection.provider === requirement.provider &&
    (requirement.method === undefined || connection.method === requirement.method)
  );
}

export function personalAiDefault(
  connections: AiConnectionSummary[],
  requirement: AiConnectionRequirement,
  userId: string,
) {
  // Never choose another account because the declared default is unhealthy.
  return connections.find(
    (connection) =>
      matchesAiRequirement(connection, { ...requirement, method: undefined }) &&
      connection.ownership === "personal" &&
      connection.ownerUserId === userId &&
      connection.isDefault,
  );
}

export function aiConnectionProblem(connection?: AiConnectionSummary) {
  if (!connection)
    return "No connection selected. Connect an account to continue.";
  return (
    connection.unavailableReason ??
    (connection.status === "connected"
      ? null
      : `${AI_CONNECTION_STATUS[connection.status]}. Reconnect this account to continue.`)
  );
}

export function bindingProblem(
  binding: AiConnectionBinding,
  requirement: AiConnectionRequirement,
  connections: AiConnectionSummary[],
  userId: string,
  _agentId: string,
) {
  if (
    binding.provider !== requirement.provider ||
    (binding.mode !== "responsible_user" && requirement.method !== undefined && binding.method !== requirement.method)
  )
    return "Choose a connection compatible with this provider and sign-in method.";
  if (binding.mode === "responsible_user")
    return aiConnectionProblem(
      personalAiDefault(connections, requirement, userId),
    );
  const connection = connections.find(
    (item) =>
      item.id === binding.connectionId &&
      item.grantId === binding.grantId &&
      item.method === binding.method &&
      matchesAiRequirement(item, requirement),
  );
  if (!connection)
    return "This connection is no longer available for this agent. Choose another connection.";
  if (binding.mode === "shared" && connection.ownership !== "shared")
    return "Choose a company-shared connection.";
  if (
    binding.mode === "delegated" &&
    (connection.ownership !== "personal" ||
      connection.ownerUserId !== userId)
  )
    return "This credential is not shared with you. Choose a connection you can use.";
  return aiConnectionProblem(connection);
}

/** Where to put a `claude setup-token` value: the Reconnect paste option. */
export const AI_SETUP_TOKEN_ADVICE =
  "For a token that lasts about a year, run claude setup-token in a terminal, then choose Reconnect and \"Paste a long-lived token\".";

/**
 * Plain wording for how long a stored credential lasts. An imported Claude
 * login is a short-lived access token; `claude setup-token` lasts about a year.
 * Returns null when there is nothing to say (API keys, non-Claude logins).
 * A Claude subscription saved before credential records existed has no record,
 * so nothing can warn before its token stops; say so and how to fix it.
 */
export function describeAiCredentialLifetime(
  credential: AiCredentialInfo | undefined,
  now = new Date(),
  connection?: { provider: AiProvider; method: AiAuthMethod },
): { tone: "muted" | "warning" | "danger"; text: string } | null {
  if (!credential) {
    if (connection?.provider !== "anthropic" || connection.method !== "subscription") return null;
    return {
      tone: "warning",
      text: `Token expiry unknown: this connection was saved before expiry tracking, so you will not be warned before it stops. ${AI_SETUP_TOKEN_ADVICE}`,
    };
  }
  const state = aiCredentialExpiryState(credential.expiresAt, now);
  if (credential.source === "setup_token") {
    if (state === "unknown") return { tone: "muted", text: "Long-lived token from claude setup-token. It lasts about a year." };
    const until = new Date(credential.expiresAt!).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    if (state === "expired")
      return { tone: "danger", text: `This token expired on ${until}. Runs using it stop until you reconnect. ${AI_SETUP_TOKEN_ADVICE}` };
    return { tone: state === "expiring_soon" ? "warning" : "muted", text: `Long-lived token from claude setup-token. It expires on ${until}.` };
  }
  if (credential.source !== "imported_login") return null;
  const renewal = AI_SETUP_TOKEN_ADVICE;
  if (state === "unknown")
    return { tone: "warning", text: `Short-lived token copied from your Claude login. Its expiry is unknown. ${renewal}` };
  const when = new Date(credential.expiresAt!).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  if (state === "expired")
    return { tone: "danger", text: `This token expired on ${when}. Runs using it stop until you reconnect. ${renewal}` };
  return {
    tone: state === "expiring_soon" ? "warning" : "muted",
    text: `Short-lived token copied from your Claude login. It expires on ${when}; you will be warned an hour before. ${renewal}`,
  };
}
