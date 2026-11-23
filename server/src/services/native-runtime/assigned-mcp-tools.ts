import { createHash } from "node:crypto";
import type { Db } from "@greatstone/db";
import { ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";

type WorkMode = "standard" | "planning" | "ask";
type ToolDefinition = Record<string, unknown>;

const SEARCH_TOOL = "paperclip_search_assigned_tools";
const CALL_TOOL = "paperclip_call_assigned_tool";
// A single valid runner schema can be 512 KiB. Leave room for its description
// while keeping the complete result below the 768 KiB provider-result bound.
const SEARCH_PAGE_BYTES = 640 * 1024;
const SCHEMA_CHUNK_CHARACTERS = 64 * 1024;
const ON_DEMAND_TOOLS: ToolDefinition[] = [
  {
    name: SEARCH_TOOL,
    description: "Search your assigned app tools by name or description and read their input schemas. Use an empty query to browse. Pass nextOffset to fetch the next page. A large definition returns inputSchemaRef: set schemaTool to that name with an empty query, then pass nextSchemaOffset until null. Concatenate schemaJson chunks and parse JSON. Use paperclip_call_assigned_tool with a returned name and arguments matching its inputSchema.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        schemaTool: { type: "string", description: "Exact inputSchemaRef from a search result." },
        schemaOffset: { type: "integer", minimum: 0 },
      },
      required: ["query"],
    },
  },
  {
    name: CALL_TOOL,
    description: "Call an assigned app tool discovered with paperclip_search_assigned_tools. Use its exact returned name and arguments matching its inputSchema. The same permissions, approvals, and audit rules apply as for direct app tools.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"],
    },
  },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assigned_mcp_tool_invalid_arguments");
  }
  return value as Record<string, unknown>;
}

function definition(name: string, tool: ToolGatewayDescriptor): ToolDefinition {
  return { name, description: `${tool.displayName}: ${tool.description}`, inputSchema: structuredClone(tool.parametersSchema) };
}

// Execution must use the app's configured gateway, including deployment
// restrictions, OAuth refresh, and approval delivery. Never fall back to an
// isolated gateway whose defaults differ from the running instance.
const assignedMcpGateways = new WeakMap<Db, ToolGatewayService>();

export function registerAssignedMcpGateway(db: Db, gateway: ToolGatewayService): void {
  assignedMcpGateways.set(db, gateway);
}

export function getAssignedMcpGateway(db: Db): ToolGatewayService {
  const gateway = assignedMcpGateways.get(db);
  if (!gateway) throw new Error("assigned_mcp_gateway_unavailable");
  return gateway;
}

function assignedToolName(name: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const separator = name.lastIndexOf(":");
  const readable = separator >= 0
    ? `${sanitize(name.slice(0, separator)).slice(0, 20) || "tool"}_${sanitize(name.slice(separator + 1)).slice(-26) || "action"}`
    : sanitize(name).slice(0, 47) || "tool";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `app_${readable}_${digest}`;
}

/** Server-owned MCP bindings projected into the runner's existing tool channel. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(current[rightIndex - 1]! + 1, previous[rightIndex]! + 1, previous[rightIndex - 1]! + substitutionCost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

function closestNames(reference: string, names: string[]): string {
  const target = reference.trim().toLowerCase();
  const closest = names
    .map(name => ({ name, limit: Math.floor(Math.max(target.length, name.length) / 3) }))
    .filter(({ name, limit }) => Math.abs(target.length - name.length) <= limit)
    .map(({ name, limit }) => ({ name, limit, distance: editDistance(target, name.toLowerCase()) }))
    .filter(({ distance, limit }) => distance <= limit)
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3)
    .map(({ name }) => name);
  return closest.length > 0 ? ` Closest assigned names: ${closest.join(", ")}.` : "";
}

export async function createAssignedMcpTools(input: {
  gateway: ToolGatewayService;
  gatewayPublicId: string;
  bearerToken: string;
  workMode?: WorkMode;
}) {
  const listed = await input.gateway.listToolsForNamedGateway({
    gatewayPublicId: input.gatewayPublicId,
    bearerToken: input.bearerToken,
  });
  const tools = new Map<string, ToolGatewayDescriptor>();
  for (const descriptor of listed) {
    const name = assignedToolName(descriptor.name);
    if (tools.has(name)) throw new Error("assigned_mcp_tool_name_collision");
    tools.set(name, descriptor);
  }
  const permits = (tool: ToolGatewayDescriptor, mode: WorkMode = input.workMode ?? "standard") => mode === "standard" || tool.risk === "read";

  function resolveAssignedName(reference: string, argument: "name" | "schemaTool"): string | undefined {
    const trimmed = reference.trim();
    if (tools.has(trimmed)) return trimmed;
    const matches = [...tools].filter(([, tool]) => tool.name === trimmed || tool.displayName === trimmed);
    if (matches.length > 1) {
      throw new Error(`assigned_mcp_tool_unknown: ${argument} matches more than one assigned tool. Use the exact ${argument === "name" ? "name" : "inputSchemaRef"} returned by paperclip_search_assigned_tools.`);
    }
    return matches[0]?.[0];
  }

  // Intersect fresh grants with this session's pinned catalog. Revocations
  // take effect immediately; newly assigned tools require a new session.
  async function authorizedTools(currentWorkMode?: WorkMode) {
    const current = new Map((await input.gateway.listToolsForNamedGateway({
      gatewayPublicId: input.gatewayPublicId, bearerToken: input.bearerToken,
    })).map(tool => [tool.name, tool]));
    return [...tools].filter(([, tool]) => {
      const fresh = current.get(tool.name);
      return fresh && permits(tool) && permits(tool, currentWorkMode) &&
        permits(fresh) && permits(fresh, currentWorkMode);
    });
  }

  async function search(argumentsValue: unknown, currentWorkMode?: WorkMode) {
    const args = object(argumentsValue);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 5;
    const schemaOffset = args.schemaOffset ?? 0;
    if (typeof args.query !== "string" || args.query.length > 200 ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (args.schemaTool !== undefined && typeof args.schemaTool !== "string") ||
      typeof schemaOffset !== "number" || !Number.isSafeInteger(schemaOffset) || schemaOffset < 0 ||
      (args.schemaOffset !== undefined && args.schemaTool === undefined)) {
      throw new Error("assigned_mcp_tool_invalid_arguments");
    }
    const terms = args.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const authorized = await authorizedTools(currentWorkMode);
    if (typeof args.schemaTool === "string") {
      const reference = resolveAssignedName(args.schemaTool, "schemaTool");
      const selected = authorized.find(([name]) => name === reference);
      if (!selected) {
        throw new Error(`assigned_mcp_tool_unknown: schemaTool must match an authorized inputSchemaRef.${closestNames(args.schemaTool, authorized.map(([name]) => name))} Omit schemaTool to search assigned tools, then use an exact inputSchemaRef from the results.`);
      }
      const schema = JSON.stringify(selected[1].parametersSchema);
      const end = schemaOffset + SCHEMA_CHUNK_CHARACTERS;
      return {
        name: selected[0], schemaJson: schema.slice(schemaOffset, end),
        nextSchemaOffset: end < schema.length ? end : null,
      };
    }
    const matches = authorized.filter(([name, tool]) =>
      terms.every(term => `${name} ${tool.displayName} ${tool.description}`.toLowerCase().includes(term)))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const page: ToolDefinition[] = [];
    for (const [name, tool] of matches.slice(offset, offset + limit)) {
      let next = definition(name, tool);
      if (Buffer.byteLength(JSON.stringify([next]), "utf8") > SEARCH_PAGE_BYTES) {
        // One large schema must not block browsing the tools after it. Expose
        // a reference whose schema can be fetched in bounded, reauthorized
        // chunks, without weakening the gateway's argument validation.
        next = { name, description: String(next.description).slice(0, 2000), inputSchemaRef: name };
      }
      if (Buffer.byteLength(JSON.stringify([...page, next]), "utf8") > SEARCH_PAGE_BYTES) {
        break;
      }
      page.push(next);
    }
    return { tools: page, nextOffset: offset + page.length < matches.length ? offset + page.length : null };
  }

  return {
    definitions(fits?: (definitions: ToolDefinition[]) => boolean): ToolDefinition[] {
      const direct = [...tools].filter(([, tool]) => permits(tool)).map(([name, tool]) => definition(name, tool));
      if (!fits || fits(direct)) return direct;
      const compact = structuredClone(ON_DEMAND_TOOLS);
      if (!fits(compact)) throw new Error("assigned_mcp_tool_catalog_capacity_exceeded");
      return compact;
    },
    has(name: string): boolean {
      return tools.has(name) || name === SEARCH_TOOL || name === CALL_TOOL;
    },
    async execute(call: { tool: string; arguments: unknown }, currentWorkMode?: WorkMode): Promise<unknown> {
      if (call.tool === SEARCH_TOOL) return search(call.arguments, currentWorkMode);
      let name = call.tool;
      let parameters = call.arguments;
      if (name === CALL_TOOL) {
        const args = object(parameters);
        if (typeof args.name !== "string") throw new Error("assigned_mcp_tool_invalid_arguments");
        parameters = object(args.arguments);
        const resolved = resolveAssignedName(args.name, "name");
        if (!resolved) {
          const authorized = await authorizedTools(currentWorkMode).then(entries => entries.map(([candidate]) => candidate), () => []);
          throw new Error(`assigned_mcp_tool_unknown: name must be an exact name returned by paperclip_search_assigned_tools.${closestNames(args.name, authorized)} Search assigned tools again and use the returned name.`);
        }
        name = resolved;
      }
      const descriptor = tools.get(name);
      if (!descriptor) throw new Error("assigned_mcp_tool_unknown");
      if (!permits(descriptor) || !permits(descriptor, currentWorkMode)) throw new Error("paperclip_runner_tool_mode_denied");
      // Reauthorize through the existing gateway on every call. Discovery is
      // not a grant: revocation, policy, approval, and audit remain server-owned.
      const result = await input.gateway.executeTool({
        gatewayPublicId: input.gatewayPublicId,
        sessionToken: input.bearerToken,
        tool: descriptor.name,
        parameters,
      });
      if (result.status !== "completed" && result.status !== "replayed") {
        throw new Error("assigned_mcp_tool_execution_incomplete");
      }
      // The gateway normally throws provider errors. Keep a malformed or older
      // provider response from being reported as successful through PRP.
      if (result.result && typeof result.result === "object" && "isError" in result.result && result.result.isError === true) {
        throw new ToolGatewayHttpError(502, "The assigned tool returned an error.", "tool_error");
      }
      return result.result;
    },
  };
}
