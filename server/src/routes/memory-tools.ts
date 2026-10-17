import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import { forbidden, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  isLiveMemoryLink,
  isMemoryOnlyActor,
  MEMORY_KEY_NOT_LINKED_CODE,
  MEMORY_KEY_NOT_LINKED_MESSAGE,
} from "../middleware/memory-only-key-guard.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { memoryCardService } from "../services/memory-gateway/card-writes.js";
import { memoryReviewService } from "../services/memory-gateway/review.js";
import { isExternalApp, MEMORY_DISABLED_MESSAGE, memoryGatewayService } from "../services/memory-gateway/service.js";
import { memoryStewardService } from "../services/memory-gateway/steward-actions.js";
import { callMemoryTool, memoryToolDefinitions } from "../services/memory-tools.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { assertCompanyAccess } from "./authz.js";
import { memoryCallerApp } from "./memory.js";
import {
  acceptMcpMessage,
  classifyMcpMessage,
  sendMcpGetNotAllowed,
  sendMcpInvalidRequest,
  sendMcpMethodNotFound,
} from "./mcp-streamable-http.js";

/**
 * Agent memory tools over MCP (GRE-672): recall, contribute, get and link,
 * and since GRE-1081 history, revise, confirm, dispute and retire. Only an authenticated, task-bound agent run or a memory_only key
 * (GRE-958) may call them, and that identity is the caller. While the company
 * setting is off the endpoint answers 404 to everything.
 */
export function memoryToolRoutes(
  db: Db,
  options: {
    engine?: MemoryEngine;
    engineTimeoutMs?: number;
    /** Answers a call with no key at all, pointing the app at the memory sign-in. */
    signInChallenge?: (req: Request, res: Response) => void;
  } = {},
) {
  const router = Router();
  const gateway = memoryGatewayService(db, options);
  const reviews = memoryReviewService(db, gateway);
  const cards = memoryCardService(db, gateway, reviews, memoryStewardService(db, gateway, reviews));

  /**
   * The caller is the authenticated run, or the agent behind a memory_only key
   * (GRE-958: John's Claude and Codex, which have no run). Never the body.
   */
  async function memoryToolIdentity(req: Request) {
    const actor = req.actor;
    if (isMemoryOnlyActor(actor) && actor.source === "agent_key" && actor.agentId && actor.companyId) {
      // The app guard checks this first on the real app; kept here so the tools never run for a key tied to nobody.
      if (!(await isLiveMemoryLink(db, actor.companyId, actor.agentId))) {
        throw forbidden(MEMORY_KEY_NOT_LINKED_MESSAGE, { code: MEMORY_KEY_NOT_LINKED_CODE });
      }
      return { companyId: actor.companyId, agentId: actor.agentId, runId: null, ...memoryCallerApp(actor, null) };
    }
    const context = await projectToolContext(db, actor, false, "Memory");
    return {
      companyId: context.run.companyId,
      agentId: context.run.agentId,
      runId: context.run.id,
      ...memoryCallerApp(actor, context.run.id),
    };
  }

  router.get("/mcp/memory-tools", (_req, res) => {
    sendMcpGetNotAllowed(res);
  });

  router.post("/mcp/memory-tools", async (req, res) => {
    if (req.actor.type === "none" && options.signInChallenge) return options.signInChallenge(req, res);
    const { companyId, agentId, runId, app, sessionId } = await memoryToolIdentity(req);
    assertCompanyAccess(req, companyId);
    if (!(await gateway.getSettings(companyId)).enabled) throw notFound(MEMORY_DISABLED_MESSAGE);

    const message = classifyMcpMessage(req.body);
    if (message.kind === "invalid") return sendMcpInvalidRequest(res);
    if (message.kind !== "request") return acceptMcpMessage(res);
    const { id, method } = message;
    const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return send({
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paperclip-memory-tools", version: "1" },
      });
    }
    if (method === "ping") return send({});
    const definitions = memoryToolDefinitions();
    if (method === "tools/list") return send({ tools: memoryToolDefinitions({ externalApp: isExternalApp({ app }) }) });
    if (method !== "tools/call") return sendMcpMethodNotFound(res, id);

    try {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!definitions.some((tool) => tool.name === name)) throw notFound("Unknown memory tool");
      const result = await callMemoryTool({
        name,
        arguments: (params?.arguments ?? {}) as Record<string, unknown>,
        gateway,
        reviews,
        cards,
        caller: {
          companyId,
          actorType: "agent",
          actorId: agentId,
          agentId,
          userId: null,
          runId,
          isBoardAdmin: false,
          app,
          sessionId,
        },
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      if (!(error instanceof HttpError)) logger.error({ err: error, agentId, runId }, "memory tool failed");
      const text = error instanceof HttpError ? error.message : "Memory tool failed";
      return send({ isError: true, content: [{ type: "text", text }] });
    }
  });

  return router;
}
