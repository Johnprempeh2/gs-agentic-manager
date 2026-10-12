// AI access route and board approval for new agents (GRE-667). Both are set
// by the script, never by hand: the route at every start, the approval flag
// once at create. `verify` checks both.

import { AI_ACCESS_ROUTES, type AiAccessRoute } from "../../packages/shared/src/ai-connections.js";

/** GRE-142: the route that is clearly allowed for unattended agents. */
export const DEFAULT_AI_ROUTE: AiAccessRoute = "claude_api_key";

export function parseAiRoute(raw: string | undefined): AiAccessRoute {
  if (raw === undefined) return DEFAULT_AI_ROUTE;
  if (!(AI_ACCESS_ROUTES as readonly string[]).includes(raw)) {
    throw new Error(`--ai-route must be one of: ${AI_ACCESS_ROUTES.join(", ")}`);
  }
  return raw as AiAccessRoute;
}

export function parseBoardApproval(raw: string | undefined): boolean {
  if (raw === undefined || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error("--board-approval must be on or off");
}

export interface AccessCheck {
  ok: boolean;
  line: string;
}

/** The route the server reports in GET /api/instance/settings/general. */
export function aiRouteCheck(expected: AiAccessRoute | undefined, general: { aiAccessRoute?: unknown }): AccessCheck {
  const actual = general.aiAccessRoute ?? null;
  if (!expected) {
    return { ok: false, line: `AI access route: none in client-instance.json (server has ${String(actual)}); set one with ai-route` };
  }
  return { ok: actual === expected, line: `AI access route is ${expected} (server has ${String(actual)})` };
}

/** The company flag in GET /api/companies/:id. */
export function boardApprovalCheck(expected: boolean | undefined, company: { requireBoardApprovalForNewAgents?: unknown }): AccessCheck {
  const actual = company.requireBoardApprovalForNewAgents;
  const want = expected ?? true;
  return {
    ok: actual === want,
    line: `board approval for new agents is ${want ? "on" : "off"} (company has ${actual === true ? "on" : actual === false ? "off" : "nothing"})`,
  };
}
