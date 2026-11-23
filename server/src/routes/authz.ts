import type { Request, Response } from "express";
import type { SecretBindingTargetType } from "@greatstone/shared";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { responsibleUserAuthzShadowMode } from "../services/authorization.js";
import { isCompanyOwnerOrAdminRole } from "../services/company-member-roles.js";
import { getHiddenSettings } from "../services/settings-visibility.js";

export const OWNER_OR_ADMIN_REQUIRED_MESSAGE = "Owner or admin role required";
export const OWNER_OR_ADMIN_REQUIRED_CODE = "owner_or_admin_required";

function throwOrShadowResponsibleUserCompanyAccessDeny(
  req: Request,
  companyId: string,
  code: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE",
  message: string,
) {
  logger.warn({
    authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
    code,
    action: "company_access",
    companyId,
    actorAgentId: req.actor.agentId ?? null,
    responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    method: req.method,
  }, "responsible-user company access intersection denied");
  if (responsibleUserAuthzShadowMode()) return;
  throw new HttpError(403, message, { code });
}

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export const BOARD_ACCESS_REQUIRED_CODE = "board_access_required";

// Agent API subresources whose controls live on their own profile tab.
const AGENT_PROFILE_TABS: Record<string, [string, string]> = {
  keys: ["API keys", "api-keys"],
  permissions: ["permissions", "permissions"],
  identity: ["instructions", "instructions"],
  "instructions-bundle": ["instructions", "instructions"],
  "instructions-path": ["instructions", "instructions"],
  configuration: ["harness settings", "runtime"],
  "runtime-state": ["harness settings", "runtime"],
};

const ENVIRONMENT_ROUTE = /^\/(?:companies\/[^/]+\/)?environments(?:\/|$)|^\/environment-(?:leases|custom-image-setup-sessions)(?:\/|$)/;

// The board page that holds the control behind a board-only API route, when one
// is known. Paths keep <prefix> for the agent to fill from its own task identifier.
const BOARD_CONTROL_PAGES: Array<[RegExp, (match: RegExpExecArray) => [string, string] | null]> = [
  [/^\/(?:companies\/[^/]+\/)?secrets?(?:[-/]|$)/, () => ["company secrets", "/<prefix>/company/settings/secrets"]],
  [/^\/companies\/[^/]+\/(?:budgets|budget-incidents)(?:\/|$)/, () => ["budgets", "/<prefix>/activity/budgets"]],
  // Cost recording controls (such as retrying a run's saved-usage cost) are on the Costs page, not Budgets.
  [/^\/companies\/[^/]+\/costs(?:\/|$)/, () => ["costs", "/<prefix>/activity/costs"]],
  [/^\/companies\/[^/]+\/(?:members|invites|join-requests)(?:\/|$)/, () => ["company members", "/<prefix>/company/settings/members"]],
  [/^\/companies\/[^/]+\/(?:tools\/)?gateways(?:\/|$)|^\/tool-gateway\//, () => ["tool gateways", "/<prefix>/apps/gateways"]],
  [/^\/approvals\/([^/]+)/, match => ["the approval", `/<prefix>/approvals/${match[1]}`]],
  [/^\/agents\/([0-9a-f-]{36})(?:\/([^/]+))?(?:\/|$)/i, match => {
    const tab = match[2] && Object.hasOwn(AGENT_PROFILE_TABS, match[2]) ? AGENT_PROFILE_TABS[match[2]] : undefined;
    return tab ? [`the agent's ${tab[0]}`, `/<prefix>/agents/${match[1]}/${tab[1]}`] : ["the agent's profile", `/<prefix>/agents/${match[1]}`];
  }],
  [/^\/companies\/[^/]+(?:\/(?:archive|branding|settings))?\/?$/, () => ["company settings", "/<prefix>/company/settings"]],
  // An operator can hide a settings page, so link it only while it is visible.
  [ENVIRONMENT_ROUTE, () => getHiddenSettings().has("instance.environments")
    ? null : ["environment settings", "/<prefix>/company/settings/instance/environments"]],
  [/^\/instance\/settings\/experimental\/?$/, () => getHiddenSettings().has("instance.experimental")
    ? null : ["Experimental settings", "/<prefix>/company/settings/instance/experimental"]],
];

// Some board-only areas have no agent route at all. A denial on one of their
// routes (often the list an agent reads first) also answers the area's other steps.
const PLUGIN_ROUTE = /^\/plugins(?:\/|$)/;
const PLUGIN_ADMINISTRATION_SCOPE = "Plugin management is board-only throughout: listing, installing, configuring (including choosing a secret for a plugin setting), enabling, disabling, upgrading and removing plugins have no agent route either.";
const ENVIRONMENT_ADMINISTRATION_SCOPE = "Execution environments are board-only throughout: listing computers, reading which coding harnesses they support, testing (probing) them and changing them have no agent route either.";

function deniedApiPath(req: Request) {
  return (req.originalUrl ?? "").split("?")[0]!.replace(/^\/api(?=\/)/, "");
}

function boardControlPage(req: Request) {
  const path = deniedApiPath(req);
  for (const [pattern, page] of BOARD_CONTROL_PAGES) {
    const match = pattern.exec(path);
    if (match) return page(match);
  }
  return null;
}

/**
 * A board-only denial. Agents get a final, actionable remediation so they hand the
 * action to the person instead of searching other routes for one that does not exist.
 */
export function boardAccessRequired(req: Request) {
  if (req.actor.type !== "agent") return forbidden("Board access required");
  const page = boardControlPage(req);
  const deniedPath = deniedApiPath(req);
  const scope = PLUGIN_ROUTE.test(deniedPath) ? `${PLUGIN_ADMINISTRATION_SCOPE} `
    : ENVIRONMENT_ROUTE.test(deniedPath) ? `${ENVIRONMENT_ADMINISTRATION_SCOPE} ` : "";
  const where = page
    ? `They do it in the GS Agentic Manager web app. Link [Open ${page[0]}](${page[1]}) and put this conversation's company prefix in place of <prefix>.`
    : "They do it in the GS Agentic Manager web app or with their own board credentials. Link a page only if you already know its route. Do not search for one.";
  return forbidden("Board access required", {
    code: BOARD_ACCESS_REQUIRED_CODE,
    remediation: `Only a board user can do this action. This denial is final: no agent credential, tool or other API route can do it. Do not search for one. Tell the person that a board user must do it. ${scope}${where}`,
  });
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw boardAccessRequired(req);
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

/**
 * The hosting operator of this instance (GRE-1363): an instance admin or the
 * implicit local board. A client's board log-in is a company owner, not this.
 */
export function isHostingOperator(req: Request) {
  return req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true);
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

/**
 * `boardChatWrite`: the caller has proved this write is a message on a board
 * question chat (GRE-1186) by the board member who owns it, or the reply of
 * its agent. Only then may a viewer (or an agent acting for one) write.
 */
export function assertCompanyAccess(req: Request, companyId: string, opts: { boardChatWrite?: boolean } = {}) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "agent" && req.actor.onBehalfOfUserId?.trim()) {
    const membership = req.actor.onBehalfOfMemberships?.find(
      (item) => item.companyId === companyId && item.status === "active",
    );
    if (!membership) {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAVAILABLE",
        "Responsible user is unavailable for this company",
      );
      return;
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && membership.membershipRole === "viewer" && !opts.boardChatWrite) {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAUTHORIZED",
        "Responsible user is not authorized for write access",
      );
    }
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer" && !opts.boardChatWrite) {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

/**
 * True when a board actor may take company-wide actions in `companyId`:
 * the implicit local board (`local_trusted`), an instance admin, or an active
 * member whose role is owner or admin. Agents are never true. This does not
 * check company access on its own; `assertCompanyOwnerOrAdmin` does both.
 */
export function hasCompanyOwnerOrAdminRole(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = req.actor.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return isCompanyOwnerOrAdminRole(membership?.membershipRole);
}

/**
 * True when a board actor sits on the company's board for the strategy
 * cascade: the implicit local board, an instance admin, or an active member
 * with the owner role. Admins (Exco), operators, viewers and agents are false.
 * Used for the top strategy layers (vision, values, CSFs), see GRE-1132.
 */
export function hasCompanyBoardRole(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = req.actor.memberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return membership?.membershipRole === "owner";
}

/**
 * Guard for company-wide actions: company access first (so another company's
 * user and viewers keep their existing errors), then a board actor, then the
 * owner or admin role. Operators get 403 "Owner or admin role required".
 */
export function assertCompanyOwnerOrAdmin(req: Request, companyId: string) {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  if (hasCompanyOwnerOrAdminRole(req, companyId)) return;
  throw forbidden(OWNER_OR_ADMIN_REQUIRED_MESSAGE, { code: OWNER_OR_ADMIN_REQUIRED_CODE });
}

/**
 * The person a request speaks for: the signed-in board user, or the user an
 * agent run acts for. Null for the local board, an instance admin and agents
 * acting for nobody (those keep their own rules).
 */
function personForRequest(req: Request, companyId: string): { userId: string; role: string | null } | null {
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
    const membership = req.actor.memberships?.find((item) => item.companyId === companyId && item.status === "active");
    return { userId: req.actor.userId ?? "", role: membership?.membershipRole ?? null };
  }
  const onBehalfOf = req.actor.type === "agent" ? req.actor.onBehalfOfUserId?.trim() : null;
  if (!onBehalfOf) return null;
  const membership = req.actor.onBehalfOfMemberships?.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  return { userId: onBehalfOf, role: membership?.membershipRole ?? null };
}

/**
 * Owner-or-admin work (company export, secrets, budgets, hard deletes): a
 * person needs the owner or admin role, and so does an agent acting for one.
 * Agents acting for nobody keep the rules of the route that calls this.
 */
export function assertOwnerOrAdminForPerson(req: Request, companyId: string) {
  assertCompanyAccess(req, companyId);
  const person = personForRequest(req, companyId);
  if (!person || isCompanyOwnerOrAdminRole(person.role)) return;
  throw forbidden(OWNER_OR_ADMIN_REQUIRED_MESSAGE, { code: OWNER_OR_ADMIN_REQUIRED_CODE });
}

/**
 * Agent chats are private to the person who started them, plus the owner and
 * admins. Returns the user id whose chats this request may see, or null when
 * it may see every chat.
 */
export function privateChatViewerUserId(req: Request, companyId: string): string | null {
  const person = personForRequest(req, companyId);
  if (!person || isCompanyOwnerOrAdminRole(person.role)) return null;
  return person.userId;
}

export function canSeeAgentChat(
  req: Request,
  issue: { companyId: string; conversationAgentId?: string | null; conversationUserId?: string | null },
) {
  if (!issue.conversationAgentId || !issue.conversationUserId) return true;
  const viewer = privateChatViewerUserId(req, issue.companyId);
  return viewer === null || viewer === issue.conversationUserId;
}

/**
 * Non-throwing access check for routes that look up a resource by id
 * before responding. Prefer this over `assertCompanyAccess` whenever the
 * route can reach the access check only after a successful `getById`
 * (i.e. after confirming the resource exists).
 *
 * Using `assertCompanyAccess` in that position leaks resource existence
 * across tenants: a 404 means "no such resource" while a 403 means "exists
 * in another tenant". Any authenticated user can enumerate IDs and
 * distinguish the two responses.
 *
 * Most routes should use `getAccessibleResource` below, which wraps the
 * whole pattern. When composing manually (bespoke not-found responses),
 * the shape is:
 *
 *     const issue = await svc.getById(id);
 *     if (!issue || !hasCompanyAccess(req, issue.companyId)) {
 *       res.status(404).json({ error: "Issue not found" });
 *       return;
 *     }
 *
 * so both "does not exist" and "exists but cross-tenant" return the same
 * 404, removing the oracle.
 *
 * Note: this intentionally does not replicate the write-path membership
 * checks in `assertCompanyAccess` (active membership, viewer read-only).
 * Routes that need those checks for authorized tenants should still call
 * `assertCompanyAccess` after the 404 gate — the oracle concern is only
 * about the existence check.
 *
 * The company-scope semantics must stay in lockstep with
 * `assertCompanyAccess`: in particular, signed-in instance admins do NOT
 * get blanket access to companies they are not a member of.
 */
export function hasCompanyAccess(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") return req.actor.companyId === companyId;
  if (req.actor.source === "local_implicit") return true;
  return (req.actor.companyIds ?? []).includes(companyId);
}

/**
 * Preferred way to fetch a company-scoped resource by id inside a route
 * handler. Wraps the two-step pattern described on `hasCompanyAccess` so
 * new routes cannot accidentally reintroduce the existence oracle:
 *
 *   - missing resource          → 404 `{ error: notFoundMessage }`, returns null
 *   - exists but cross-tenant   → identical 404, returns null
 *   - accessible                → runs `assertCompanyAccess` (write-path
 *     membership checks on non-safe methods) and returns the resource
 *
 * Usage:
 *
 *     const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
 *     if (!goal) return;
 *
 * Routes with bespoke not-found behavior (legacy `200 []` contracts,
 * audit-logged denials) should still compose `hasCompanyAccess` directly.
 */
export async function getAccessibleResource<T extends { companyId: string }>(
  req: Request,
  res: Response,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
  opts: { boardChatWrite?: boolean } = {},
): Promise<T | null> {
  const resolved = await resource;
  if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  assertCompanyAccess(req, resolved.companyId, opts);
  // Someone else's agent chat answers like a missing one (read and write).
  if (!canSeeAgentChat(req, resolved as { companyId: string; conversationAgentId?: string | null; conversationUserId?: string | null })) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  return resolved;
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    sessionId: string | null;
    agentId: null;
    runId: string | null;
    agentApiKeyId: null;
    actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  }
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    const actorSource = req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key";
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      agentApiKeyId: req.actor.keyId ?? null,
      actorSource,
    };
  }

  const actorSource =
    req.actor.source === "local_implicit" ||
      req.actor.source === "board_key" ||
      req.actor.source === "cloud_tenant"
      ? req.actor.source
      : "session";

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    sessionId: req.actor.sessionId ?? null,
    agentId: null,
    runId: req.actor.runId ?? null,
    agentApiKeyId: null,
    actorSource,
  };
}

/**
 * The actor-scoped fields of a secret-binding context, keyed to a caller-supplied
 * consumer identity. Structurally matches `SecretConsumerContext` in
 * `services/secrets.ts` (whose types are not exported), so the return value slots
 * into `resolveAdapterConfigForRuntime`'s 3rd argument
 * (`Omit<SecretBindingContext, "configPath">`) unchanged.
 */
export type ActorSecretContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  actorType: "agent" | "user";
  actorId: string | null;
  actorSource: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
  responsibleUserId: string | null;
};

/**
 * Build the actor-scoped portion of a secret-binding context from `req.actor`,
 * taking the consumer identity as parameters. The responsible user is derived
 * server-side (`req.actor.userId ?? req.actor.onBehalfOfUserId ?? null`) and is
 * never request-body-controllable; a `null` result surfaces downstream as the
 * intended `responsible_user_missing` loud failure for a required user secret.
 *
 * `consumerType` is a parameter (not hardcoded `"agent"`) so callers can record an
 * honest consumer — `agent` for a persisted agent, `environment`/`system` for a
 * prospective config with no persisted consumer.
 *
 * Never sets `configPath` (the resolver injects it) or `allowedBindingIds`.
 */
export function buildActorSecretContext(
  req: Request,
  params: { consumerType: SecretBindingTargetType; consumerId: string },
): ActorSecretContext {
  const info = getActorInfo(req);
  return {
    consumerType: params.consumerType,
    consumerId: params.consumerId,
    actorType: info.actorType,
    actorId: info.actorId,
    actorSource: info.actorSource,
    responsibleUserId: req.actor.userId ?? req.actor.onBehalfOfUserId ?? null,
  };
}
