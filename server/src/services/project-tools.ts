import { createProjectSchema, createIssueSchema, mcpToolHints, type McpToolHints } from "@greatstone/shared";
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
  list_website_modules: mcpToolHints("read"),
};
/** Read-only tool outside the runner catalog: the website module registry (GRE-2325). Needs website:view. */
const WEBSITE_MODULES_TOOL = {
  name: "list_website_modules",
  description: "Read the website module registry: each connected site's modules with their route prefixes, collections, owner, lead agent, linked project and on/off state.",
  annotations: PROJECT_TOOL_HINTS.list_website_modules,
  inputSchema: {
    type: "object",
    properties: { siteId: { type: "string", description: "Only this site. Leave out to read every site the agent can view." } },
    required: [],
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
  return workMode === "skill_test" ? catalog : [...catalog, WEBSITE_MODULES_TOOL];
}

async function apiGet(apiUrl: string, token: string, path: string) {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Website modules read failed (${response.status})`);
  return result;
}

/** Sites the agent can view, each with its modules, through the normal authenticated API. */
async function listWebsiteModules(input: { apiUrl: string; token: string; companyId: string; siteId?: unknown }) {
  const company = encodeURIComponent(input.companyId);
  const sites = (await apiGet(input.apiUrl, input.token, `/companies/${company}/website/sites`)) as Array<{ id: string; name: string; domain: string }>;
  const wanted = typeof input.siteId === "string" && input.siteId ? sites.filter((site) => site.id === input.siteId) : sites;
  return {
    sites: await Promise.all(wanted.map(async (site) => ({
      id: site.id,
      name: site.name,
      domain: site.domain,
      modules: await apiGet(input.apiUrl, input.token, `/companies/${company}/website/sites/${encodeURIComponent(site.id)}/modules`),
    }))),
  };
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  if (input.name === "list_website_modules") {
    return listWebsiteModules({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, siteId: args.siteId });
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
