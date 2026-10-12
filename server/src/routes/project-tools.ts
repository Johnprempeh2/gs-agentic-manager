import { Router } from "express";
import type { Db } from "@greatstone/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import {
  acceptMcpMessage,
  classifyMcpMessage,
  sendMcpGetNotAllowed,
  sendMcpInvalidRequest,
  sendMcpMethodNotFound,
} from "./mcp-streamable-http.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  // MCP clients probe GET for an optional SSE stream. There is none here.
  router.get("/mcp/project-tools", (_req, res) => {
    sendMcpGetNotAllowed(res);
  });
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const message = classifyMcpMessage(req.body);
    if (message.kind === "invalid") return sendMcpInvalidRequest(res);
    if (message.kind !== "request") return acceptMcpMessage(res);
    const { id, method } = message;
    const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "ping") return send({});
    const definitions = projectToolDefinitions(context.issue.workMode, true);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return sendMcpMethodNotFound(res, id);
    try {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!definitions.some(tool => tool.name === name)) throw forbidden("Tool is unavailable in this mode");
      const apiUrl = process.env.GSAM_API_URL;
      if (!apiUrl) throw new Error("GS Agentic Manager API origin is unavailable");
      const result = await callProjectTool({
        name, arguments: (params?.arguments ?? {}) as Record<string, unknown>, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        companyId: context.run.companyId, issueId: context.issue.id, agentId: context.run.agentId,
        conversation: Boolean(context.issue.conversationAgentId),
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    }
  });
  return router;
}
