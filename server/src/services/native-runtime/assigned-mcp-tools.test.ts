import { describe, expect, it, vi } from "vitest";
import type { Db } from "@greatstone/db";
import { ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";
import { createAssignedMcpTools, getAssignedMcpGateway, registerAssignedMcpGateway } from "./assigned-mcp-tools.js";

function descriptor(name: string, risk: ToolGatewayDescriptor["risk"] = "read"): ToolGatewayDescriptor {
  return { name, displayName: name, description: `Use ${name}`, parametersSchema: { type: "object", properties: { query: { type: "string" } } }, pluginId: "fixture", providerType: "mcp_remote_http", risk };
}

function fixture(tools: ToolGatewayDescriptor[]) {
  const listToolsForNamedGateway = vi.fn().mockResolvedValue(tools);
  const executeTool = vi.fn().mockResolvedValue({ status: "completed", result: { content: [{ type: "text", text: "memory found" }] } });
  const gateway = { listToolsForNamedGateway, executeTool } as unknown as ToolGatewayService;
  return { gateway, listToolsForNamedGateway, executeTool, gatewayPublicId: "gateway-fixture", bearerToken: "private-run-token-never-project" };
}

describe("assigned MCP runner tools", () => {
  const searchName = "paperclip_search_assigned_tools";
  const callName = "paperclip_call_assigned_tool";

  it("pages through an oversized catalog and calls every tool through the original gateway", async () => {
    const f = fixture(Array.from({ length: 224 }, (_, i) => descriptor(`app.action_${i}`)));
    const assigned = await createAssignedMcpTools(f);
    const direct = assigned.definitions();
    const compact = assigned.definitions(tools => tools.length <= 200);
    expect(compact.map(tool => tool.name)).toEqual([searchName, callName]);
    expect(assigned.definitions(tools => tools.length <= 224)).toEqual(direct);
    expect(() => assigned.definitions(() => false)).toThrow("assigned_mcp_tool_catalog_capacity_exceeded");
    const seen: string[] = [];
    let offset: number | null = 0;
    do {
      const page = await assigned.execute({ tool: searchName, arguments: { query: "", offset, limit: 20 } }) as {
        tools: Array<{ name: string; inputSchema: unknown }>; nextOffset: number | null;
      };
      expect(page.tools.length).toBeLessThanOrEqual(20);
      for (const tool of page.tools) {
        seen.push(tool.name);
        expect(tool.inputSchema).toEqual(descriptor("any").parametersSchema);
        await assigned.execute({ tool: callName, arguments: { name: tool.name, arguments: { query: "fixture" } } });
      }
      offset = page.nextOffset;
    } while (offset !== null);
    expect(seen).toEqual(direct.map(tool => tool.name).sort());
    expect(f.executeTool).toHaveBeenCalledTimes(224);
    expect(new Set(f.executeTool.mock.calls.map(([call]) => call.tool)).size).toBe(224);
    for (const [call] of f.executeTool.mock.calls) {
      expect(call).toMatchObject({ gatewayPublicId: f.gatewayPublicId, sessionToken: f.bearerToken, parameters: { query: "fixture" } });
      expect(call).not.toHaveProperty("approvedActionRequestId");
    }
  });

  it("searches only pinned tools still granted by fresh discovery without projecting metadata", async () => {
    const f = fixture([descriptor("calendar.search"), descriptor("mail.search"), descriptor("calendar.remove", "write")]);
    const assigned = await createAssignedMcpTools(f);
    f.listToolsForNamedGateway.mockResolvedValue([
      { ...descriptor("calendar.search"), providerMetadata: { token: "secret-provider-token" } },
      descriptor("calendar.remove", "write"), descriptor("calendar.new_grant"),
    ]);
    const result = await assigned.execute({ tool: searchName, arguments: { query: "calendar" } }, "planning");
    expect(result).toEqual({ tools: [assigned.definitions()[0]], nextOffset: null });
    expect(JSON.stringify(result)).not.toMatch(/private-|secret-provider|gateway-fixture|new_grant/);
    f.listToolsForNamedGateway.mockRejectedValue(new Error("gateway_token_revoked"));
    await expect(assigned.execute({ tool: searchName, arguments: { query: "" } })).rejects.toThrow("gateway_token_revoked");
  });

  it("resolves a gateway name or unique display name to the assigned alias without widening authorization", async () => {
    const sql = { ...descriptor("braintrust:sql_query"), displayName: "sql_query" };
    const first = { ...descriptor("mcp.first:search"), displayName: "search" };
    const second = { ...descriptor("mcp.second:search", "write"), displayName: "search" };
    const write = { ...descriptor("braintrust:add_to_dataset", "write"), displayName: "add_to_dataset" };
    const f = fixture([sql, first, second, write]);
    const assigned = await createAssignedMcpTools(f);
    const page = await assigned.execute({ tool: searchName, arguments: { query: "sql_query" } }) as { tools: Array<{ name: string }> };
    const alias = page.tools[0]!.name;
    for (const schemaTool of [alias, sql.name, sql.displayName, ` ${sql.displayName} `]) {
      await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool } }))
        .resolves.toEqual({ name: alias, schemaJson: JSON.stringify(sql.parametersSchema), nextSchemaOffset: null });
    }
    for (const name of [sql.name, sql.displayName]) {
      await assigned.execute({ tool: callName, arguments: { name, arguments: { query: "fixture" } } });
    }
    expect(f.executeTool.mock.calls.map(([call]) => call.tool)).toEqual([sql.name, sql.name]);
    await expect(assigned.execute({ tool: callName, arguments: { name: "unassigned", arguments: {} } }))
      .rejects.toThrow("assigned_mcp_tool_unknown: name must be an exact name returned by paperclip_search_assigned_tools");
    await expect(assigned.execute({ tool: callName, arguments: { name: "search", arguments: {} } }))
      .rejects.toThrow("assigned_mcp_tool_unknown: name matches more than one assigned tool");
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: "search" } }))
      .rejects.toThrow("assigned_mcp_tool_unknown: schemaTool matches more than one assigned tool");
    await expect(assigned.execute({ tool: callName, arguments: { name: write.displayName, arguments: {} } }, "planning"))
      .rejects.toThrow("paperclip_runner_tool_mode_denied");
    f.listToolsForNamedGateway.mockResolvedValue([first]);
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: sql.name } }))
      .rejects.toThrow("assigned_mcp_tool_unknown");
    await expect(assigned.execute({ tool: callName, arguments: { name: "newly:granted", arguments: {} } }))
      .rejects.toThrow("assigned_mcp_tool_unknown");
    expect(f.executeTool).toHaveBeenCalledTimes(2);
  });

  it("rejects a name that is one tool's gateway name and another tool's display name", async () => {
    const read = { ...descriptor("sql_query"), displayName: "Read rows" };
    const write = { ...descriptor("warehouse:write_rows", "write"), displayName: "sql_query" };
    const f = fixture([read, write]);
    const assigned = await createAssignedMcpTools(f);
    await expect(assigned.execute({ tool: callName, arguments: { name: "sql_query", arguments: {} } }))
      .rejects.toThrow("assigned_mcp_tool_unknown: name matches more than one assigned tool");
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: "sql_query" } }))
      .rejects.toThrow("assigned_mcp_tool_unknown: schemaTool matches more than one assigned tool");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it("names the closest permitted assigned tools when a name is mistyped, without calling any of them", async () => {
    const read = descriptor("github_bot:read_pull_request");
    const begin = descriptor("github_bot:begin_review", "write");
    const submit = descriptor("github_bot:submit_review", "write");
    const f = fixture([read, begin, submit, ...Array.from({ length: 6 }, (_, i) => descriptor(`calendar:event_${i}`))]);
    const assigned = await createAssignedMcpTools(f);
    const page = await assigned.execute({ tool: searchName, arguments: { query: "github_bot", limit: 20 } }) as { tools: Array<{ name: string }> };
    const alias = (tool: ToolGatewayDescriptor) => page.tools.find(entry => entry.name.includes(tool.name.split(":")[1]!))!.name;
    const unknown = (name: string, mode?: "planning") =>
      assigned.execute({ tool: callName, arguments: { name, arguments: {} } }, mode).then(() => "", (error: Error) => error.message);

    const dropped = await unknown(`${alias(begin).slice(0, -6)}${alias(begin).slice(-5)}`);
    expect(dropped).toMatch(/^assigned_mcp_tool_unknown: name must be an exact name returned by paperclip_search_assigned_tools\./);
    expect(dropped).toContain(`Closest assigned names: ${alias(begin)}`);
    expect(dropped).not.toContain("calendar");

    const borrowed = await unknown(`${alias(submit).slice(0, -12)}${alias(read).slice(-12)}`);
    expect(borrowed).toContain(`Closest assigned names: ${alias(submit)}`);

    const planning = await unknown(`${alias(begin).slice(0, -1)}0`, "planning");
    expect(planning).toBe("assigned_mcp_tool_unknown: name must be an exact name returned by paperclip_search_assigned_tools. Search assigned tools again and use the returned name.");

    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: `${alias(read)}x` } }))
      .rejects.toThrow(`Closest assigned names: ${alias(read)}`);

    const oversized = `${alias(read)}${"x".repeat(8 * 1024 * 1024)}`;
    expect(await unknown(oversized)).not.toContain("Closest assigned names");
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: oversized } }))
      .rejects.toThrow("schemaTool must match an authorized inputSchemaRef. Omit schemaTool");

    f.listToolsForNamedGateway.mockResolvedValue([read, submit]);
    expect(await unknown(`${alias(begin).slice(0, -1)}0`)).not.toContain(alias(begin));

    f.listToolsForNamedGateway.mockRejectedValue(new Error("gateway_token_revoked"));
    expect(await unknown(`${alias(read).slice(0, -1)}0`)).toBe("assigned_mcp_tool_unknown: name must be an exact name returned by paperclip_search_assigned_tools. Search assigned tools again and use the returned name.");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it.each(["planning", "ask"] as const)("preserves pinned and fresh %s restrictions through the call wrapper", async mode => {
    const f = fixture([descriptor("read"), descriptor("write", "write")]);
    const assigned = await createAssignedMcpTools(f);
    const restricted = await createAssignedMcpTools({ ...f, workMode: mode });
    const call = { tool: callName, arguments: { name: assigned.definitions()[1]!.name, arguments: {} } };
    await expect(assigned.execute(call, mode)).rejects.toThrow("paperclip_runner_tool_mode_denied");
    await expect(restricted.execute(call, "standard")).rejects.toThrow("paperclip_runner_tool_mode_denied");
    expect(f.executeTool).not.toHaveBeenCalled();
    const discovery = await restricted.execute({ tool: searchName, arguments: { query: "" } }, "standard");
    expect(discovery).toEqual({ tools: [assigned.definitions()[0]], nextOffset: null });
  });

  it.each(["approval_required", "connection_revoked", "tool_error"])("preserves %s through the call wrapper", async reason => {
    const f = fixture([descriptor("write", "write")]);
    const assigned = await createAssignedMcpTools(f);
    const error = new ToolGatewayHttpError(403, "Denied", reason);
    f.executeTool.mockRejectedValue(error);
    await expect(assigned.execute({ tool: callName, arguments: { name: assigned.definitions()[0]!.name, arguments: {} } })).rejects.toBe(error);
  });

  it("bounds search pages by bytes and rejects invalid wrapper arguments and unassigned targets", async () => {
    const f = fixture(Array.from({ length: 4 }, (_, i) => ({
      ...descriptor(`large_${i}`),
      parametersSchema: { type: "object", description: "x".repeat(250 * 1024) },
    })));
    const assigned = await createAssignedMcpTools(f);
    const page = await assigned.execute({ tool: searchName, arguments: { query: "", limit: 20 } }) as { tools: unknown[]; nextOffset: number };
    expect(page.tools).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    for (const args of [null, [], { query: "x".repeat(201) }, { query: "", offset: -1 }, { query: "", limit: 21 }, { query: "", offset: 0.5 }]) {
      await expect(assigned.execute({ tool: searchName, arguments: args })).rejects.toThrow("assigned_mcp_tool_invalid_arguments");
    }
    for (const name of ["unassigned", searchName, callName]) {
      await expect(assigned.execute({ tool: callName, arguments: { name, arguments: {} } })).rejects.toThrow("assigned_mcp_tool_unknown");
    }
    await expect(assigned.execute({ tool: callName, arguments: { name: "unassigned", arguments: [] } })).rejects.toThrow("assigned_mcp_tool_invalid_arguments");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it("keeps individually oversized schemas and later tools discoverable with bounded schema chunks", async () => {
    const schema = { type: "object", description: "\u0000🙂".repeat(150_000), properties: {} };
    const f = fixture([{ ...descriptor("a_large"), parametersSchema: schema }, descriptor("z_small")]);
    const assigned = await createAssignedMcpTools(f);
    const large = assigned.definitions()[0]!.name as string;
    const page = await assigned.execute({ tool: searchName, arguments: { query: "", limit: 1 } }) as {
      tools: Array<Record<string, unknown>>; nextOffset: number;
    };
    expect(page.tools).toEqual([{ name: large, description: "a_large: Use a_large", inputSchemaRef: large }]);
    expect(page.nextOffset).toBe(1);
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", offset: page.nextOffset } }))
      .resolves.toEqual({ tools: [assigned.definitions()[1]], nextOffset: null });
    let schemaOffset: number | null = 0;
    let serialized = "";
    do {
      const chunk = await assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: large, schemaOffset } }) as {
        schemaJson: string; nextSchemaOffset: number | null;
      };
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(640 * 1024);
      serialized += chunk.schemaJson;
      schemaOffset = chunk.nextSchemaOffset;
    } while (schemaOffset !== null);
    expect(JSON.parse(serialized)).toEqual(schema);
    await assigned.execute({ tool: callName, arguments: { name: large, arguments: {} } });
    expect(f.executeTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool: "a_large" }));
    f.listToolsForNamedGateway.mockResolvedValue([descriptor("z_small")]);
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaTool: large } })).rejects.toThrow("assigned_mcp_tool_unknown");
    await expect(assigned.execute({ tool: searchName, arguments: { query: "", schemaOffset: 1 } })).rejects.toThrow("assigned_mcp_tool_invalid_arguments");
  });

  it("requires a configured gateway registered for the exact database instance", () => {
    const firstDb = {} as Db;
    const secondDb = {} as Db;
    const first = fixture([]).gateway;
    const second = fixture([]).gateway;
    expect(() => getAssignedMcpGateway(firstDb)).toThrow("assigned_mcp_gateway_unavailable");
    registerAssignedMcpGateway(firstDb, first);
    expect(getAssignedMcpGateway(firstDb)).toBe(first);
    expect(() => getAssignedMcpGateway(secondDb)).toThrow("assigned_mcp_gateway_unavailable");
    registerAssignedMcpGateway(secondDb, second);
    expect(getAssignedMcpGateway(secondDb)).toBe(second);
    expect(getAssignedMcpGateway(firstDb)).toBe(first);
    registerAssignedMcpGateway(firstDb, second);
    expect(getAssignedMcpGateway(firstDb)).toBe(second);
  });

  it("projects only authorized gateway tools with stable bounded collision-resistant names", async () => {
    const names = ["memory.search", "memory-search", "x".repeat(120), "🧠"];
    const f = fixture(names.map(name => descriptor(name)));
    const first = await createAssignedMcpTools(f);
    const reversed = await createAssignedMcpTools({ ...f, gateway: fixture([...names].reverse().map(name => descriptor(name))).gateway });
    const projected = first.definitions().map(tool => tool.name as string);
    expect(new Set(projected).size).toBe(names.length);
    for (const name of projected) {
      expect(name).toMatch(/^app_[a-zA-Z0-9_]+_[a-f0-9]{12}$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(first.has(name)).toBe(true);
    }
    expect(reversed.definitions().map(tool => tool.name)).toEqual([...projected].reverse());
    expect(f.listToolsForNamedGateway).toHaveBeenCalledWith({ gatewayPublicId: f.gatewayPublicId, bearerToken: f.bearerToken });
  });

  it("keeps the provider and action readable for fully namespaced gateway tools", async () => {
    const prefix = "mcp.app-gallery-mem0-60062edb-c211-4aae-a787-b4fa12a5ea24-f4ece062";
    const tools = ["add-memory", "search-memories", "delete-memory"].map(action => ({
      ...descriptor(`${prefix}:${action}`), displayName: `Mem0 ${action}`,
    }));
    const assigned = await createAssignedMcpTools(fixture(tools));
    for (const [index, definition] of assigned.definitions().entries()) {
      const name = definition.name as string;
      expect(name).toContain("mem0");
      expect(name).toContain(tools[index]!.name.split(":").at(-1)!.replaceAll("-", "_"));
      expect(name.length).toBeLessThanOrEqual(64);
      expect(definition.description).toBe(`${tools[index]!.displayName}: ${tools[index]!.description}`);
    }
    const long = await createAssignedMcpTools(fixture([descriptor(`${prefix}:${"long-action-".repeat(10)}`)]));
    expect((long.definitions()[0]!.name as string).length).toBeLessThanOrEqual(64);
  });

  it("does not project gateway secrets, URLs, or provider metadata and returns only the tool result", async () => {
    const tool = { ...descriptor("recall"), providerMetadata: { token: "private-provider-token", url: "https://private-gateway.example" } };
    const f = fixture([tool]);
    f.executeTool.mockResolvedValue({ status: "completed", invocationId: "internal", result: { memories: [] } });
    const assigned = await createAssignedMcpTools(f);
    const definitions = assigned.definitions();
    expect(Object.keys(definitions[0]!)).toEqual(["name", "description", "inputSchema"]);
    expect(JSON.stringify(definitions)).not.toMatch(/private-|gateway-fixture|https:/);
    const args = { query: "synthetic memory" };
    expect(await assigned.execute({ tool: definitions[0]!.name as string, arguments: args })).toEqual({ memories: [] });
    expect(f.executeTool).toHaveBeenCalledExactlyOnceWith({ gatewayPublicId: f.gatewayPublicId, sessionToken: f.bearerToken, tool: "recall", parameters: args });
    (definitions[0]!.inputSchema as Record<string, unknown>).type = "string";
    expect(assigned.definitions()[0]!.inputSchema).toEqual(tool.parametersSchema);
  });

  it("rejects unknown names without invoking the gateway", async () => {
    const f = fixture([descriptor("recall")]);
    const assigned = await createAssignedMcpTools(f);
    expect(assigned.has("unassigned")).toBe(false);
    await expect(assigned.execute({ tool: "unassigned", arguments: {} })).rejects.toThrow("assigned_mcp_tool_unknown");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it.each(["planning", "ask"] as const)("exposes and permits only read tools in %s mode", async workMode => {
    const f = fixture([descriptor("read"), descriptor("remember", "write"), descriptor("forget", "destructive")]);
    const standard = await createAssignedMcpTools(f);
    const restricted = await createAssignedMcpTools({ ...f, workMode });
    expect(restricted.definitions()).toEqual([standard.definitions()[0]]);
    for (const tool of standard.definitions().slice(1)) {
      await expect(restricted.execute({ tool: tool.name as string, arguments: {} })).rejects.toThrow("paperclip_runner_tool_mode_denied");
    }
    expect(f.executeTool).not.toHaveBeenCalled();
    await restricted.execute({ tool: restricted.definitions()[0]!.name as string, arguments: {} });
    expect(f.executeTool).toHaveBeenCalledOnce();
  });

  it("uses the gateway for write and destructive tools under standard mode without approval overrides", async () => {
    const f = fixture([descriptor("remember", "write"), descriptor("forget", "destructive")]);
    const assigned = await createAssignedMcpTools(f);
    for (const tool of assigned.definitions()) await assigned.execute({ tool: tool.name as string, arguments: {} });
    expect(f.executeTool).toHaveBeenCalledTimes(2);
    for (const [call] of f.executeTool.mock.calls) expect(call).not.toHaveProperty("approvedActionRequestId");
  });

  it.each(["planning", "ask"] as const)("enforces fresh %s mode without relaxing the pinned mode", async currentMode => {
    const f = fixture([descriptor("read"), descriptor("remember", "write")]);
    const standard = await createAssignedMcpTools(f);
    const restricted = await createAssignedMcpTools({ ...f, workMode: currentMode });
    const write = { tool: standard.definitions()[1]!.name as string, arguments: {} };
    await expect(standard.execute(write, currentMode)).rejects.toThrow("paperclip_runner_tool_mode_denied");
    await expect(restricted.execute(write, "standard")).rejects.toThrow("paperclip_runner_tool_mode_denied");
    expect(f.executeTool).not.toHaveBeenCalled();
    await standard.execute({ tool: standard.definitions()[0]!.name as string, arguments: {} }, currentMode);
    expect(f.executeTool).toHaveBeenCalledOnce();
  });

  it.each(["tool_error", "approval_required", "connection_revoked"])("propagates %s without converting it to success", async reason => {
    const f = fixture([descriptor("recall")]);
    const error = new ToolGatewayHttpError(403, "Gateway refused execution", reason);
    f.executeTool.mockRejectedValue(error);
    const assigned = await createAssignedMcpTools(f);
    await expect(assigned.execute({ tool: assigned.definitions()[0]!.name as string, arguments: {} })).rejects.toBe(error);
  });

  it("propagates discovery denial", async () => {
    const f = fixture([]);
    const error = new Error("gateway_token_revoked");
    f.listToolsForNamedGateway.mockRejectedValue(error);
    await expect(createAssignedMcpTools(f)).rejects.toBe(error);
  });

  it("rejects error payloads and incomplete outcomes, and accepts successful replay", async () => {
    const f = fixture([descriptor("recall")]);
    const assigned = await createAssignedMcpTools(f);
    const call = { tool: assigned.definitions()[0]!.name as string, arguments: {} };
    f.executeTool.mockResolvedValueOnce({ status: "completed", result: { isError: true, content: [] } });
    await expect(assigned.execute(call)).rejects.toMatchObject({ reasonCode: "tool_error" });
    f.executeTool.mockResolvedValueOnce({ status: "pending", result: {} });
    await expect(assigned.execute(call)).rejects.toThrow("assigned_mcp_tool_execution_incomplete");
    f.executeTool.mockResolvedValueOnce({ status: "replayed", result: { memory: "synthetic" } });
    await expect(assigned.execute(call)).resolves.toEqual({ memory: "synthetic" });
  });
});
