import type {
  ToolConnectionAgentCheckReason,
  ToolConnectionAgentCheckResult,
} from "@greatstone/shared";
import type { toolAccessService } from "./tool-access.js";
import type { createToolGatewayService } from "./tool-gateway.js";
import { HttpError } from "../errors.js";
import { ToolGatewayHttpError } from "./tool-gateway.js";

type ToolAccess = Pick<ReturnType<typeof toolAccessService>, "checkHealth">;
type ActorInfo = Parameters<ToolAccess["checkHealth"]>[1];
type ToolGateway = Pick<
  ReturnType<typeof createToolGatewayService>,
  "summarizeConnectionAccessForAgent" | "resolveAgentConnectionCredential"
>;

const NO_GRANT_CODES = new Set([
  "agent_authorization_required",
  "user_authorization_required",
  "organization_authorization_required",
  "grant_audience_denied",
  "grant_owner_membership_inactive",
  "grant_owner_missing",
  "ambiguous_personal_grant",
  "github_identity_unavailable",
]);
const EXPIRED_TOKEN_CODES = new Set([
  "oauth_challenge",
  "oauth_refresh_missing",
  "oauth_refresh_failed",
  "oauth_reauthorization_required",
  "needs_reauthorization",
  "grant_credential_invalid",
  "user_secret_missing",
  "missing_secret",
  "mcp_remote_missing_secret",
  "secret_missing",
  "binding_missing",
  "secret_deleted",
  "secret_inactive",
  "version_missing",
  "memory_api_key_rejected",
  "vercel_connect_authorization_required",
]);
const SCOPE_MISSING_CODES = new Set([
  "slack_mcp_access_disabled",
  "github_access_changed",
  "insufficient_scope",
]);

function errorParts(error: unknown): { code: string; message: string; upstreamStatus: number | null } {
  if (error instanceof ToolGatewayHttpError) {
    return { code: error.reasonCode, message: error.message, upstreamStatus: null };
  }
  if (error instanceof HttpError) {
    const details = (error.details ?? {}) as Record<string, unknown>;
    const upstream = details.upstreamStatus ?? details.status;
    return {
      code: typeof details.code === "string" ? details.code : "service_error",
      message: error.message,
      upstreamStatus: typeof upstream === "number" ? upstream : null,
    };
  }
  return {
    code: "service_error",
    message: error instanceof Error ? error.message.slice(0, 240) : "The connection check failed.",
    upstreamStatus: null,
  };
}

export function classifyAgentCheckFailure(error: unknown): {
  reason: ToolConnectionAgentCheckReason;
  code: string;
  message: string;
} {
  const { code, message, upstreamStatus } = errorParts(error);
  if (NO_GRANT_CODES.has(code)) return { reason: "no_grant", code, message };
  if (EXPIRED_TOKEN_CODES.has(code) || upstreamStatus === 401) {
    return { reason: "expired_token", code, message };
  }
  if (SCOPE_MISSING_CODES.has(code) || upstreamStatus === 403) {
    return { reason: "scope_missing", code, message };
  }
  return { reason: "service_error", code, message };
}

const REASON_PREFIX: Record<ToolConnectionAgentCheckReason, string> = {
  no_access: "No access",
  no_grant: "No grant",
  expired_token: "Expired token",
  scope_missing: "Scope missing",
  service_error: "Service error",
};

/**
 * "Test as agent" (GRE-341): check one connection with one agent's effective
 * access — tool profile and policies, its grant, and that grant's credential —
 * using the GRE-335 health probe (`tools/list`, read-only). It starts no run,
 * calls no model, and does not save the result as the connection's health.
 */
export function connectionAgentCheckService(deps: { toolAccess: ToolAccess; toolGateway: ToolGateway }) {
  return {
    async check(input: {
      companyId: string;
      connectionId: string;
      agentId: string;
      userId: string;
      actor?: ActorInfo;
    }): Promise<ToolConnectionAgentCheckResult> {
      const summary = await deps.toolGateway.summarizeConnectionAccessForAgent({
        companyId: input.companyId,
        connectionId: input.connectionId,
        agentId: input.agentId,
      });
      const access = {
        toolCount: summary.toolCount,
        allowedCount: summary.allowedCount,
        askFirstCount: summary.askFirstCount,
        offCount: summary.offCount,
      };
      const base = { agentId: input.agentId, connectionId: input.connectionId, access };
      const fail = (
        failure: { reason: ToolConnectionAgentCheckReason; code: string; message: string },
        grantKind: ToolConnectionAgentCheckResult["grantKind"] = null,
      ): ToolConnectionAgentCheckResult => ({
        ...base,
        ok: false,
        reason: failure.reason,
        code: failure.code,
        message: `${REASON_PREFIX[failure.reason]}: ${failure.message}`,
        grantKind,
        checkedAt: new Date().toISOString(),
      });

      // An empty catalog says nothing about this agent; the probe below finds
      // the real cause. A catalog with every action off is this agent's limit.
      if (summary.toolCount > 0 && summary.allowedCount + summary.askFirstCount === 0) {
        const reasonCode = summary.tools.find((tool) => tool.reasonCode)?.reasonCode ?? "all_actions_off";
        return fail({
          reason: "no_access",
          code: String(reasonCode),
          message: "This agent's tool profile or policies turn off every action in this app.",
        });
      }

      let credential: Awaited<ReturnType<ToolGateway["resolveAgentConnectionCredential"]>>;
      try {
        credential = await deps.toolGateway.resolveAgentConnectionCredential({
          companyId: input.companyId,
          connectionId: input.connectionId,
          agentId: input.agentId,
          userId: input.userId,
        });
      } catch (error) {
        return fail(classifyAgentCheckFailure(error));
      }

      try {
        await deps.toolAccess.checkHealth(input.connectionId, input.actor, {
          asAgent: {
            agentId: input.agentId,
            grantId: credential.grantId,
            credentialHeaders: credential.credentialHeaders,
            endpoint: credential.endpoint,
          },
        });
      } catch (error) {
        return fail(classifyAgentCheckFailure(error), credential.grantKind);
      }

      return {
        ...base,
        ok: true,
        reason: null,
        code: null,
        message: `The app answered with this agent's access. ${access.allowedCount} actions allowed, ${access.askFirstCount} ask first, ${access.offCount} off.`,
        grantKind: credential.grantKind,
        checkedAt: new Date().toISOString(),
      };
    },
  };
}
