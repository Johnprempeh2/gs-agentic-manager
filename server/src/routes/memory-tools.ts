import { Router } from "express";
import type { Db } from "@greatstone/db";
import { HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { MEMORY_DISABLED_MESSAGE, memoryGatewayService } from "../services/memory-gateway/service.js";
import { callMemoryTool, memoryToolDefinitions } from "../services/memory-tools.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { assertCompanyAccess } from "./authz.js";
import {
  acceptMcpMessage,
  classifyMcpMessage,
  sendMcpGetNotAllowed,
  sendMcpInvalidRequest,
  sendMcpMethodNotFound,
} from "./mcp-streamable-http.js";

/**
 * Agent memory tools over MCP (GRE-672): memory_recall, memory_contribute and
 * memory_get. Only an authenticated, task-bound agent run may call them, and
 * the run's identity is the caller. While the company setting is off the
 * endpoint answers 404 to everything.
 */
export function memoryToolRoutes(db: Db, options: { engine?: MemoryEngine; engineTimeoutMs?: number } = {}) {
  const router = Router();
  const gateway = memoryGatewayService(db, options);

  router.get("/mcp/memory-tools", (_req, res) => {
    sendMcpGetNotAllowed(res);
  });

  router.post("/mcp/memory-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor, false, "Memory");
    const companyId = context.run.companyId;
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
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return sendMcpMethodNotFound(res, id);

    try {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!definitions.some((tool) => tool.name === name)) throw notFound("Unknown memory tool");
      const result = await callMemoryTool({
        name,
        arguments: (params?.arguments ?? {}) as Record<string, unknown>,
        gateway,
        caller: {
          companyId,
          actorType: "agent",
          actorId: context.run.agentId,
          agentId: context.run.agentId,
          userId: null,
          runId: context.run.id,
          isBoardAdmin: false,
        },
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      if (!(error instanceof HttpError)) logger.error({ err: error, runId: context.run.id }, "memory tool failed");
      const text = error instanceof HttpError ? error.message : "Memory tool failed";
      return send({ isError: true, content: [{ type: "text", text }] });
    }
  });

  return router;
}
