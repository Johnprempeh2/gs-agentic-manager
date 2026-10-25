import { WEBSITE_COMMERCE_RESOURCES, WEBSITE_DATA_RESOURCES, createProjectSchema, createIssueSchema, mcpToolHints, type McpToolHints } from "@greatstone/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
// Creates take a required idempotency key, so a retry returns the same record.
const PROJECT_TOOL_HINTS: Record<string, McpToolHints> = {
  list_projects: mcpToolHints("read"),
  list_project_repositories: mcpToolHints("read"),
  create_project: mcpToolHints("write", { idempotent: true }),
  create_task: mcpToolHints("write", { idempotent: true }),
  list_website_features: mcpToolHints("read"),
  website_data_list: mcpToolHints("read"),
  website_data_get: mcpToolHints("read"),
  website_style_get: mcpToolHints("read"),
};
/** Read-only tool outside the runner catalog: the website feature registry (GRE-2325). Needs website:view. */
const WEBSITE_FEATURES_TOOL = {
  name: "list_website_features",
  description: "Read the website feature registry: each connected site's features with their route prefixes, collections, owner, lead agent, linked project and on/off state.",
  annotations: PROJECT_TOOL_HINTS.list_website_features,
  inputSchema: {
    type: "object",
    properties: { siteId: { type: "string", description: "Only this site. Leave out to read every site the agent can view." } },
    required: [],
    additionalProperties: false,
  },
};
/**
 * Read-only tools for the website's own records (GRE-2323): customers, quotes, orders, invoices, licences, portal
 * documents and acceptances, enquiries. They go through GSAM's website data route (website:view), which signs the
 * call with the site's read key and names this agent and run in the site's audit. The agent never sees the key.
 * The commerce records (GRE-2354 2c(a)) go the same way through the commerce route: the catalogue, pricing, imports,
 * and as lists with no id, `fx` (the display rate and its recent changes) and `payments` (the payment report).
 */
const WEBSITE_REPORT_RESOURCES = ["fx", "payments"] as const;
const WEBSITE_LIST_RESOURCES = [...WEBSITE_DATA_RESOURCES, ...WEBSITE_COMMERCE_RESOURCES, ...WEBSITE_REPORT_RESOURCES] as const;
const WEBSITE_GET_RESOURCES = [...WEBSITE_DATA_RESOURCES, ...WEBSITE_COMMERCE_RESOURCES] as const;
const WEBSITE_DATA_TOOLS = [
  {
    name: "website_data_list",
    description: "List records from a connected website's own database, oldest first, a page at a time. Read only. Licence keys show only their last four characters. `fx` returns the USD to GBP display rate with its last changes; `payments` returns the payment report (orders paid by Stripe, refunds, refund requests, Stripe mode) for from/to dates, with no Stripe ids.",
    annotations: PROJECT_TOOL_HINTS.website_data_list,
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The website site id (list_website_features shows them)." },
        resource: { type: "string", enum: [...WEBSITE_LIST_RESOURCES] },
        customer: { type: "string", description: "Only this customer's records (a customer id). Customer records only: not for enquiries or commerce." },
        updatedSince: { type: "string", description: "ISO time: only records changed since then." },
        cursor: { type: "string", description: "nextCursor from the previous page." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        from: { type: "string", description: "payments only: the first day, YYYY-MM-DD." },
        to: { type: "string", description: "payments only: the last day, YYYY-MM-DD." },
      },
      required: ["siteId", "resource"],
      additionalProperties: false,
    },
  },
  {
    name: "website_data_get",
    description: "Read one record from a connected website's own database by id. Read only. An import job comes with a page of its rows: pass cursor and limit for the next page.",
    annotations: PROJECT_TOOL_HINTS.website_data_get,
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
        resource: { type: "string", enum: [...WEBSITE_GET_RESOURCES] },
        id: { type: "string", description: "The record id, as a list returned it." },
        cursor: { type: "string", description: "imports only: nextCursor from the previous page of rows." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["siteId", "resource", "id"],
      additionalProperties: false,
    },
  },
];
/**
 * Read-only: a connected site's style (GRE-2520), the same answer as the Website Style tab. Colours with their
 * CSS variables, release tokens and contrast ratings, fonts and the type scale, buttons, links, cards and pills,
 * radius, spacing and motion tokens. Agents read it so a change uses the site's own tokens.
 */
const WEBSITE_STYLE_TOOL = {
  name: "website_style_get",
  description: "Read a connected website's style: its colours (CSS variable, release theme token, hex, role, where used, contrast ratings), fonts and type scale, building blocks (buttons, links, cards, pills) and radius, spacing and motion tokens, from the live stylesheet with the release theme on top. Use these tokens in any style change.",
  annotations: PROJECT_TOOL_HINTS.website_style_get,
  inputSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "The website site id (list_website_features shows them)." },
      fresh: { type: "boolean", description: "Read the site again now instead of the copy from the last ten minutes." },
    },
    required: ["siteId"],
    additionalProperties: false,
  },
};
export function projectToolDefinitions(workMode: string, includeTask = false) {
  const catalog: Array<{ name: string; description: string; annotations: McpToolHints | undefined; inputSchema: unknown }> = CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && tool.operationId === "create_task")
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    annotations: PROJECT_TOOL_HINTS[tool.operationId],
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.inputSchema,
  }));
  return workMode === "skill_test" ? catalog : [...catalog, WEBSITE_FEATURES_TOOL, ...WEBSITE_DATA_TOOLS, WEBSITE_STYLE_TOOL];
}

async function apiGet(apiUrl: string, token: string, path: string) {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Website features read failed (${response.status})`);
  return result;
}

/** Sites the agent can view, each with its features, through the normal authenticated API. */
async function listWebsiteFeatures(input: { apiUrl: string; token: string; companyId: string; siteId?: unknown }) {
  const company = encodeURIComponent(input.companyId);
  const sites = (await apiGet(input.apiUrl, input.token, `/companies/${company}/website/sites`)) as Array<{ id: string; name: string; domain: string }>;
  const wanted = typeof input.siteId === "string" && input.siteId ? sites.filter((site) => site.id === input.siteId) : sites;
  return {
    sites: await Promise.all(wanted.map(async (site) => ({
      id: site.id,
      name: site.name,
      domain: site.domain,
      features: await apiGet(input.apiUrl, input.token, `/companies/${company}/website/sites/${encodeURIComponent(site.id)}/features`),
    }))),
  };
}

/** A website data read, through GSAM's own route so its permission check and signing apply. */
async function readWebsiteData(input: { apiUrl: string; token: string; companyId: string; name: string; args: Record<string, unknown> }) {
  const args = z.object({
    siteId: z.string().uuid(), resource: z.enum(WEBSITE_LIST_RESOURCES), id: z.string().min(1).max(80).optional(),
    customer: z.string().optional(), updatedSince: z.string().optional(), cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), from: z.string().optional(), to: z.string().optional(),
  }).strict().parse(input.args);
  const site = `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(args.siteId)}`;
  const isData = (WEBSITE_DATA_RESOURCES as readonly string[]).includes(args.resource);
  const base = `${site}/${isData ? "data" : "commerce"}/${args.resource}`;
  const withQuery = (path: string, keys: ReadonlyArray<"customer" | "updatedSince" | "cursor" | "limit" | "from" | "to">) => {
    const query = new URLSearchParams();
    for (const key of keys) if (args[key] !== undefined) query.set(key, String(args[key]));
    return query.size ? `${path}?${query}` : path;
  };
  if (input.name === "website_data_get") {
    if (!args.id) throw badRequest("website_data_get needs an id");
    if ((WEBSITE_REPORT_RESOURCES as readonly string[]).includes(args.resource)) throw badRequest(`${args.resource} has no id: use website_data_list`);
    return apiGet(input.apiUrl, input.token, withQuery(`${base}/${encodeURIComponent(args.id)}`, args.resource === "imports" ? ["cursor", "limit"] : []));
  }
  if (args.resource === "fx") return apiGet(input.apiUrl, input.token, base);
  if (args.resource === "payments") return apiGet(input.apiUrl, input.token, withQuery(base, ["from", "to"]));
  return apiGet(input.apiUrl, input.token, withQuery(base, ["customer", "updatedSince", "cursor", "limit"]));
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  if (input.name === "list_website_features") {
    return listWebsiteFeatures({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, siteId: args.siteId });
  }
  if (input.name === "website_data_list" || input.name === "website_data_get") {
    return readWebsiteData({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, name: input.name, args });
  }
  if (input.name === "website_style_get") {
    const { siteId, fresh } = z.object({ siteId: z.string().uuid(), fresh: z.boolean().optional() }).strict().parse(args);
    const path = `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(siteId)}/style`;
    return apiGet(input.apiUrl, input.token, fresh ? `${path}?fresh=1` : path);
  }
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (input.name === "list_projects") { /* read projects */ }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return input.name === "list_projects" ? { projects: result } : result;
}
