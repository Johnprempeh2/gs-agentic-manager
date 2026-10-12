import type { RequestHandler } from "express";
import type { Db } from "@greatstone/db";
import { strategyBoardChatService } from "../services/strategy-board-chat.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_LIMIT = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

type ServedChat = { id: string; identifier: string | null } | null;

/**
 * Board question chats are questions only (GRE-1186). A run that serves one
 * may read anything its agent can read, but its only write is the reply on
 * that chat: no tasks, goals, readings, agent settings, wakeups or
 * interactions. This holds even when the responsible-user rules run in shadow
 * mode, so it does not rest on the board member being a viewer.
 */
export function boardQuestionRunGuard(db: Db): RequestHandler {
  const chats = strategyBoardChatService(db);
  const cache = new Map<string, { chat: ServedChat; at: number }>();

  async function servedChat(companyId: string, agentId: string, runId: string): Promise<ServedChat> {
    const key = `${companyId}:${agentId}:${runId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.chat;
    const chat = await chats.boardChatForRun(companyId, agentId, runId);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, { chat, at: Date.now() });
    return chat;
  }

  return async (req, res, next) => {
    try {
      if (req.actor.type !== "agent" || SAFE_METHODS.has(req.method.toUpperCase())) return next();
      const { agentId, companyId, runId } = req.actor;
      if (!agentId || !companyId || !runId || !UUID_RE.test(runId)) return next();
      const chat = await servedChat(companyId, agentId, runId);
      if (!chat) return next();
      if (isReplyOnChat(req.method, req.path, chat)) return next();
      res.status(403).json({
        error: "This run answers a board member's questions. It may only reply on its chat; it cannot change tasks, goals or agents.",
        code: "board_question_read_only",
      });
    } catch (err) {
      next(err);
    }
  };
}

/** `POST /issues/<chat id or identifier>/comments` is the one write a board question run may make. */
export function isReplyOnChat(method: string, path: string, chat: { id: string; identifier: string | null }) {
  if (method.toUpperCase() !== "POST") return false;
  const match = /^\/issues\/([^/]+)\/comments\/?$/.exec(path);
  if (!match) return false;
  const ref = decodeURIComponent(match[1]!);
  return ref === chat.id || (chat.identifier != null && ref.toUpperCase() === chat.identifier.toUpperCase());
}
