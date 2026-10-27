import type { Request, RequestHandler } from "express";
import { and, eq, ne } from "drizzle-orm";
import { agents, companyMemberships, type Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { memoryLinkPerson } from "../services/memory-gateway/service.js";

export const MEMORY_ONLY_KEY_DENIED_MESSAGE = "This key may only call the organization memory routes";
export const MEMORY_KEY_NOT_LINKED_CODE = "MEMORY_KEY_NOT_LINKED";
export const MEMORY_KEY_NOT_LINKED_MESSAGE =
  "This memory key does not belong to a person in this company. Connect the app again from Memory > Claude and ChatGPT.";

// The company memory REST routes and the memory MCP endpoint. Matched on the
// raw path, so an encoded or dotted segment cannot reach another router.
const MEMORY_PATHS = [
  /^\/api\/companies\/[^/]+\/memory(\/[^/]+)*\/?$/i,
  /^\/api\/mcp\/memory-tools\/?$/i,
];

export const MEMORY_KEY_NETWORK_CODE = "MEMORY_KEY_TAILNET_ONLY";
export const MEMORY_KEY_NETWORK_MESSAGE =
  "Memory keys work only over the tailnet (or on this PC), never through Tailscale Funnel or the public internet.";

/**
 * Where a memory key may come from (GRE-2668): this PC, or the tailnet. A
 * request through Tailscale Funnel carries `Tailscale-Funnel-Request`, set by
 * tailscaled, and is refused whatever its address (Funnel proxies from
 * 127.0.0.1). `GSAM_MEMORY_KEYS_ANY_NETWORK=true` lifts the address check for
 * a hosted instance; Funnel stays refused.
 */
export function memoryKeyNetworkRefusal(
  req: Pick<Request, "headers"> & { socket?: { remoteAddress?: string | null } | null },
  env: NodeJS.ProcessEnv = process.env,
): "funnel" | "not_tailnet" | null {
  if (req.headers["tailscale-funnel-request"] !== undefined) return "funnel";
  if (env.GSAM_MEMORY_KEYS_ANY_NETWORK === "true") return null;
  const address = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "").toLowerCase();
  if (address === "127.0.0.1" || address === "::1") return null;
  // Tailscale addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) return null;
  if (address.startsWith("fd7a:115c:a1e0:")) return null;
  return "not_tailnet";
}

export function isMemoryOnlyActor(actor: Request["actor"]) {
  return actor.type === "agent" && actor.keyScope?.kind === "memory_only";
}

export function isMemoryPath(path: string) {
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path)) return false;
  return MEMORY_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Whether a memory key's agent is one person's app link (GRE-1081) and that
 * person is still an active member. Read on every call, so removing the
 * person cuts the app off on its next call, like revoking the key does.
 */
export async function isLiveMemoryLink(db: Db, companyId: string, agentId: string) {
  const agent = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), ne(agents.status, "terminated")))
    .then((rows) => rows[0] ?? null);
  const userId = agent ? memoryLinkPerson(agent.metadata) : null;
  if (!userId) return false;
  const member = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return member !== null;
}

/**
 * A `memory_only` agent key (GRE-958) is refused on every route except
 * organization memory. It runs right after the actor is resolved, so no
 * other router ever sees such a key. On the memory routes the key must
 * belong to one person's app link (GRE-1081): the old shared key, on an
 * agent tied to nobody, is refused.
 */
export function memoryOnlyKeyGuard(db: Db): RequestHandler {
  return (req, _res, next) => {
    if (!isMemoryOnlyActor(req.actor)) {
      next();
      return;
    }
    if (!isMemoryPath(req.path)) {
      next(forbidden(MEMORY_ONLY_KEY_DENIED_MESSAGE, { code: "MEMORY_ONLY_KEY" }));
      return;
    }
    const network = memoryKeyNetworkRefusal(req);
    if (network) {
      next(forbidden(MEMORY_KEY_NETWORK_MESSAGE, { code: MEMORY_KEY_NETWORK_CODE, reason: network }));
      return;
    }
    const { agentId, companyId } = req.actor;
    if (!agentId || !companyId) {
      next(forbidden(MEMORY_KEY_NOT_LINKED_MESSAGE, { code: MEMORY_KEY_NOT_LINKED_CODE }));
      return;
    }
    isLiveMemoryLink(db, companyId, agentId).then(
      (live) => next(live ? undefined : forbidden(MEMORY_KEY_NOT_LINKED_MESSAGE, { code: MEMORY_KEY_NOT_LINKED_CODE })),
      next,
    );
  };
}
