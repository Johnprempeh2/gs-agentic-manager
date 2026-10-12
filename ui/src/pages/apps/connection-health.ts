import { isToolConnectionAttentionHealth, type ToolConnection } from "@greatstone/shared";
import { toolsApi } from "@/api/tools";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { timeAgo } from "@/lib/timeAgo";

/** The one health badge a connection shows on the Connectors page (GRE-342). */
export type ConnectionHealthBadge = {
  /** `StatusBadge` status key, so the colours come from the shared status tokens. */
  status: "ok" | "warning" | "error" | "unchecked";
  label: "Works" | "Warning" | "Needs reconnect" | "Not tested";
};

/**
 * Maps the server's health record to Works / Warning / Needs reconnect.
 * `needsAttention` lets the caller fold in signals the health status alone
 * does not carry (an expired AI token, a retired connector).
 */
export function connectionHealthBadge(
  connection: Pick<ToolConnection, "healthStatus">,
  needsAttention = false,
): ConnectionHealthBadge {
  if (connection.healthStatus === "degraded") return { status: "warning", label: "Warning" };
  if (needsAttention || isToolConnectionAttentionHealth(connection.healthStatus)) {
    return { status: "error", label: "Needs reconnect" };
  }
  if (connection.healthStatus === "ok" || connection.healthStatus === "healthy") {
    return { status: "ok", label: "Works" };
  }
  return { status: "unchecked", label: "Not tested" };
}

/** "Checked 5m ago" or "Not checked yet". */
export function connectionCheckedLabel(
  connection: Pick<ToolConnection, "healthCheckedAt">,
): string {
  return connection.healthCheckedAt
    ? `Checked ${timeAgo(connection.healthCheckedAt)}`
    : "Not checked yet";
}

/**
 * Sends the user to the provider sign-in to reconnect an OAuth connection.
 * Personal-only connections put the new token back on the signed-in user's
 * grant; shared connections keep using the organization slot.
 */
export async function startOAuthReconnect(
  connection: Pick<ToolConnection, "id" | "credentialPolicy">,
): Promise<void> {
  const start = connection.credentialPolicy === "per_user"
    ? await toolsApi.startOAuth(connection.id, { asCurrentUser: true })
    : await toolsApi.startOAuth(connection.id);
  const target = await prepareOAuthNavigation(start);
  if (target.kind === "reauthentication" && start.handoff) {
    savePendingCloudHandoff(start.handoff.session);
  }
  navigateTopLevel(target.url);
}
