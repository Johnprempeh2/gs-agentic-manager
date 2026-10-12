import type { Request, RequestHandler } from "express";
import { forbidden } from "../errors.js";

export const MEMORY_ONLY_KEY_DENIED_MESSAGE = "This key may only call the organization memory routes";

// The company memory REST routes and the memory MCP endpoint. Matched on the
// raw path, so an encoded or dotted segment cannot reach another router.
const MEMORY_PATHS = [
  /^\/api\/companies\/[^/]+\/memory(\/[^/]+)*\/?$/i,
  /^\/api\/mcp\/memory-tools\/?$/i,
];

export function isMemoryOnlyActor(actor: Request["actor"]) {
  return actor.type === "agent" && actor.keyScope?.kind === "memory_only";
}

export function isMemoryPath(path: string) {
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path)) return false;
  return MEMORY_PATHS.some((pattern) => pattern.test(path));
}

/**
 * A `memory_only` agent key (GRE-958, John's Claude and Codex) is refused on
 * every route except organization memory. It runs right after the actor is
 * resolved, so no other router ever sees such a key.
 */
export function memoryOnlyKeyGuard(): RequestHandler {
  return (req, _res, next) => {
    if (!isMemoryOnlyActor(req.actor) || isMemoryPath(req.path)) {
      next();
      return;
    }
    next(forbidden(MEMORY_ONLY_KEY_DENIED_MESSAGE, { code: "MEMORY_ONLY_KEY" }));
  };
}
