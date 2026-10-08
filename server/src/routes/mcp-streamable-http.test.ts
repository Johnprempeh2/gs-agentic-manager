import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@greatstone/db";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";
import { classifyMcpMessage } from "./mcp-streamable-http.js";

const runtime = vi.hoisted(() => ({
  claims: { sub: "agent-1", company_id: "company-1", run_id: "run-1", responsible_user_id: "user-1" } as Record<string, string> | null,
  validate: vi.fn(async () => ({})),
  search: vi.fn(async () => ({ status: "available" })),
  request: vi.fn(async () => ({ status: "requested" })),
}));
vi.mock("../runtime-tools-token.js", () => ({ verifyRuntimeToolsToken: () => runtime.claims }));
vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => ({ validate: runtime.validate, search: runtime.search, request: runtime.request }),
}));

const project = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../services/project-tool-context.js", () => ({ projectToolContext: project.context }));

const { runtimeConnectionIntentRoutes } = await import("./connection-intents.js");
const { projectToolRoutes } = await import("./project-tools.js");
const { mcpGatewayProtocolRoutes } = await import("./tool-gateway.js");

const db = {} as Db;
const agentActor = {
  type: "agent", source: "agent_jwt", agentId: "agent-1", companyId: "company-1", runId: "run-1",
} as unknown as Express.Request["actor"];

function app(router: express.Router, actor?: Express.Request["actor"]) {
  const instance = express();
  instance.use(express.json());
  if (actor) instance.use((req, _res, next) => { req.actor = actor; next(); });
  instance.use(router);
  instance.use(errorHandler);
  return instance;
}

describe("classifyMcpMessage", () => {
  it("separates requests, notifications, client responses and invalid bodies", () => {
    expect(classifyMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .toEqual({ kind: "request", id: 1, method: "tools/list", params: undefined });
    expect(classifyMcpMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } }))
      .toEqual({ kind: "notification", method: "notifications/cancelled" });
    expect(classifyMcpMessage({ jsonrpc: "2.0", id: 9, method: "notifications/initialized" }).kind).toBe("notification");
    expect(classifyMcpMessage({ jsonrpc: "2.0", id: 2, result: {} }).kind).toBe("response");
    for (const body of [null, [], [{ jsonrpc: "2.0", id: 1, method: "ping" }], {}, { id: 1 }, { id: {}, method: "ping" }, "ping"]) {
      expect(classifyMcpMessage(body).kind).toBe("invalid");
    }
  });
});

describe("runtime tools MCP endpoint", () => {
  const routes = () => app(runtimeConnectionIntentRoutes(db));
  beforeEach(() => {
    runtime.claims = { sub: "agent-1", company_id: "company-1", run_id: "run-1", responsible_user_id: "user-1" };
    runtime.validate.mockReset().mockResolvedValue({});
  });

  it("answers GET with 405 and Allow: POST once the token is valid", async () => {
    const res = await request(routes()).get("/mcp/runtime-tools").set("authorization", "Bearer runtime").expect(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.body.error.code).toBe(-32000);
    expect(runtime.validate).toHaveBeenCalledTimes(1);
  });

  it("keeps the business refusals on GET and POST", async () => {
    runtime.validate.mockRejectedValue(conflict("Connection requests cannot be created on a closed task"));
    await request(routes()).get("/mcp/runtime-tools").set("authorization", "Bearer runtime").expect(409);
    await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(409);
    // The run is revalidated before a notification is accepted too.
    await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", method: "notifications/initialized" }).expect(409);
    runtime.validate.mockRejectedValue(unprocessable("Connection requests require a task-bound heartbeat run"));
    await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" }).expect(422);
  });

  it("refuses a missing or invalid token before anything else", async () => {
    runtime.claims = null;
    await request(routes()).post("/mcp/runtime-tools").send({ jsonrpc: "2.0", method: "notifications/initialized" }).expect(401);
    await request(routes()).get("/mcp/runtime-tools").expect(401);
    expect(runtime.validate).not.toHaveBeenCalled();
  });

  it("accepts every notification with 202 and no body", async () => {
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]) {
      const res = await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
        .send({ jsonrpc: "2.0", method, params: {} }).expect(202);
      expect(res.text).toBe("");
    }
  });

  it("answers unknown methods and unknown tools with JSON-RPC errors in an HTTP 200", async () => {
    const discover = await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} }).expect(200);
    expect(discover.body).toEqual({ jsonrpc: "2.0", id: "server-discover-probe-1", error: { code: -32601, message: "Method not found" } });
    const tool = await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delete_everything" } }).expect(200);
    expect(tool.body.error).toEqual({ code: -32602, message: "Unknown tool: delete_everything" });
    const ping = await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send({ jsonrpc: "2.0", id: 6, method: "ping" }).expect(200);
    expect(ping.body).toEqual({ jsonrpc: "2.0", id: 6, result: {} });
    await request(routes()).post("/mcp/runtime-tools").set("authorization", "Bearer runtime")
      .send([{ jsonrpc: "2.0", id: 7, method: "ping" }]).expect(400);
  });
});

describe("project tools MCP endpoint", () => {
  beforeEach(() => {
    project.context.mockReset().mockResolvedValue({
      run: { companyId: "company-1", agentId: "agent-1" },
      issue: { id: "issue-1", workMode: "standard", conversationAgentId: null },
    });
  });

  it("answers GET with 405 and Allow: POST", async () => {
    const res = await request(app(projectToolRoutes(db), agentActor)).get("/mcp/project-tools").expect(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("accepts notifications with 202 and answers unknown methods with -32601", async () => {
    const routes = app(projectToolRoutes(db), agentActor);
    const cancelled = await request(routes).post("/mcp/project-tools")
      .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }).expect(202);
    expect(cancelled.text).toBe("");
    const discover = await request(routes).post("/mcp/project-tools")
      .send({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover" }).expect(200);
    expect(discover.body.error.code).toBe(-32601);
  });

  it("still refuses a caller without a task-bound agent run", async () => {
    project.context.mockRejectedValue(forbidden("Project tools require an authenticated agent run"));
    await request(app(projectToolRoutes(db), agentActor)).post("/mcp/project-tools")
      .send({ jsonrpc: "2.0", method: "notifications/initialized" }).expect(403);
    await request(app(projectToolRoutes(db), agentActor)).post("/mcp/project-tools")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(403);
  });
});

describe("MCP gateway protocol endpoint", () => {
  const runTokenActions = ["tools/list", "tools/call"] as const;
  function fakeGateway(allowedActions: readonly string[]) {
    const deny = (action: string) => {
      if (!allowedActions.includes(action)) {
        throw new ToolGatewayHttpError(403, "Gateway bearer token is not allowed to perform this MCP action", "gateway_token_action_denied", { requestedAction: action });
      }
    };
    const calls: string[] = [];
    const service = {
      async initializeNamedGatewayProtocol() { calls.push("initialize"); return { gatewayTokenAllowedActions: [...allowedActions] }; },
      async discoverNamedGatewayTools() {
        calls.push("tools/list");
        deny("tools/list");
        return { tools: [{ name: "github:get_me", displayName: "Get me", description: "Who am I", parametersSchema: null }], allowedActions: [...allowedActions] };
      },
      async executeContextForNamedGateway(input: { method: string }) {
        calls.push(input.method);
        deny(input.method);
        return input.method === "resources/list" ? { resources: [] } : { prompts: [] };
      },
      async executeTool() { calls.push("tools/call"); deny("tools/call"); return { result: { content: "ok" } }; },
    };
    return { service: service as unknown as ToolGatewayService, calls };
  }
  const endpoint = "/mcp/gateways/gw_0123456789abcdef0123456789abcdef";

  it("answers GET with 405 and Allow: POST", async () => {
    const res = await request(app(mcpGatewayProtocolRoutes(fakeGateway(runTokenActions).service))).get(endpoint).expect(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("accepts notifications with 202 without touching the gateway, but still needs a bearer", async () => {
    const { service, calls } = fakeGateway(runTokenActions);
    const routes = app(mcpGatewayProtocolRoutes(service));
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]) {
      const res = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
        .send({ jsonrpc: "2.0", method }).expect(202);
      expect(res.text).toBe("");
    }
    expect(calls).toEqual([]);
    await request(routes).post(endpoint).send({ jsonrpc: "2.0", method: "notifications/initialized" }).expect(401);
  });

  it("answers server/discover with -32601 in an HTTP 200", async () => {
    const res = await request(app(mcpGatewayProtocolRoutes(fakeGateway(runTokenActions).service))).post(endpoint)
      .set("authorization", "Bearer pcgw_run")
      .send({ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} }).expect(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: "server-discover-probe-1", error: { code: -32601, message: "Method not found" } });
  });

  it("advertises only what a run-scoped token may use, and still refuses the rest", async () => {
    const { service } = fakeGateway(runTokenActions);
    const routes = app(mcpGatewayProtocolRoutes(service));
    const init = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
      .send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }).expect(200);
    expect(init.body.result.capabilities).toEqual({ tools: {} });
    const listed = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["github:get_me"]);
    for (const method of ["resources/list", "prompts/list"]) {
      const refused = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
        .send({ jsonrpc: "2.0", id: 2, method }).expect(403);
      expect(refused.body.error.data.reasonCode).toBe("gateway_token_action_denied");
    }
    await request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paperclip_list_resources" } }).expect(403);
  });

  // GRE-1039: the client reads any HTTP 404 as "session expired" and refuses
  // every later call on the server, so one failed call stranded the run.
  it("returns a failed tool call as a tool result, so the next call on the session still works", async () => {
    const failures = [
      new ToolGatewayHttpError(504, "Remote MCP tool call timed out after 60 seconds. The app may still finish the job.", "tool_timeout"),
      new ToolGatewayHttpError(404, "Tool \"higgsfield:job_status\" not found", "tool_not_found"),
      new ToolGatewayHttpError(502, "The app is rate limiting requests.", "mcp_remote_status"),
    ];
    const service = {
      async executeTool() {
        const failure = failures.shift();
        if (failure) throw failure;
        return { result: { content: "job done" } };
      },
    } as unknown as ToolGatewayService;
    const routes = app(mcpGatewayProtocolRoutes(service));
    const call = (id: number) => request(routes).post(endpoint).set("authorization", "Bearer pcgw_run")
      .send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "higgsfield:job_status", arguments: {} } });

    const timedOut = await call(1).expect(200);
    expect(timedOut.body.result.isError).toBe(true);
    expect(timedOut.body.result.content[0].text).toContain("may still finish");
    expect(timedOut.body.result.content[0].text).toContain("tool_timeout");
    const missing = await call(2).expect(200);
    expect(missing.body.result).toMatchObject({ isError: true });
    const limited = await call(3).expect(200);
    expect(limited.body.result).toMatchObject({ isError: true });
    const next = await call(4).expect(200);
    expect(next.body.result).toEqual({ content: [{ type: "text", text: "job done" }], structuredContent: null, isError: false });
  });

  it("never answers a request with HTTP 404", async () => {
    const service = {
      async executeContextForNamedGateway() {
        throw new ToolGatewayHttpError(404, "Assigned MCP resource was not found", "mcp_resource_not_found");
      },
    } as unknown as ToolGatewayService;
    const res = await request(app(mcpGatewayProtocolRoutes(service))).post(endpoint).set("authorization", "Bearer pcgw_full")
      .send({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "x://gone" } }).expect(200);
    expect(res.body).toEqual({
      jsonrpc: "2.0", id: 7,
      error: { code: -32602, message: "Assigned MCP resource was not found", data: { reasonCode: "mcp_resource_not_found" } },
    });
  });

  it("keeps resources, prompts and their helper tools for a token allowed to use them", async () => {
    const routes = app(mcpGatewayProtocolRoutes(fakeGateway([
      "tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get",
    ]).service));
    const init = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_full")
      .send({ jsonrpc: "2.0", id: 0, method: "initialize" }).expect(200);
    expect(init.body.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    const listed = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_full")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "github:get_me", "paperclip_list_resources", "paperclip_read_resource", "paperclip_list_prompts", "paperclip_get_prompt",
    ]);
    const resources = await request(routes).post(endpoint).set("authorization", "Bearer pcgw_full")
      .send({ jsonrpc: "2.0", id: 2, method: "resources/list" }).expect(200);
    expect(resources.body.result).toEqual({ resources: [] });
  });
});
