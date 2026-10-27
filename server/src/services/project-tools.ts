import { createHash } from "node:crypto";
import {
  WEBSITE_COMMERCE_CATALOGUE_RESOURCES,
  WEBSITE_COMMERCE_RESOURCES,
  WEBSITE_DATA_RESOURCES,
  createProjectSchema,
  createIssueSchema,
  mcpToolHints,
  websiteCommerceRefundRequestSchema,
  websiteCommerceWriteOperation,
  type McpToolHints,
} from "@greatstone/shared";
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
  // Commerce drafts (GRE-2354 2c(b)): each takes an idempotency key, so a retry writes once.
  commerce_draft_create: mcpToolHints("write", { idempotent: true }),
  commerce_draft_edit: mcpToolHints("write", { idempotent: true }),
  commerce_draft_delete: mcpToolHints("destructive", { idempotent: true }),
  commerce_convert_quote: mcpToolHints("write", { idempotent: true }),
  commerce_import_dry_run: mcpToolHints("write", { idempotent: true }),
  commerce_request_refund: mcpToolHints("write", { idempotent: true }),
  interview_round_get: mcpToolHints("read"),
  interview_synthesis_get: mcpToolHints("read"),
  interview_set_draft: mcpToolHints("write"),
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
/**
 * Commerce drafts (GRE-2354 2c(b), Everest's answer to design Q5 on GRE-2550: agents may draft). They go through
 * GSAM's commerce routes (website:commerce, which a person must grant), signed with the site's write or refund key,
 * and the site's audit names this agent and run. No tool can publish, archive, change FX, apply an import, issue an
 * invoice or decide a refund: those are people only, and the route refuses an agent before any call to the site.
 * Catalogue rows an agent makes stay draft until a person publishes them.
 */
const COMMERCE_CHILDREN = ["variants", "specs", "media", "targets"] as const;
const COMMERCE_EDIT_RESOURCES = [...WEBSITE_COMMERCE_CATALOGUE_RESOURCES, "quotes", "invoices"] as const;
const idempotencyKeyProperty = {
  type: "string", minLength: 1, maxLength: 200,
  description: "Your own key for this change, e.g. the task id and a step name. The same key again makes no second change.",
};
const siteIdProperty = { type: "string", description: "The website site id (list_website_features shows them)." };
const fieldsProperty = {
  type: "object",
  description: "The record's fields in the site's camelCase names (e.g. slug, name, description, basePriceMinor). The site checks each one and refuses an unknown name.",
};
const WEBSITE_COMMERCE_TOOLS = [
  {
    name: "commerce_draft_create",
    description: "Create a draft catalogue record on a connected website: a vendor, category, offering or pricing rule, or a child row of one (an offering's variants, specs or media; a pricing rule's targets). It stays draft; a person publishes it. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_draft_create,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        resource: { type: "string", enum: [...WEBSITE_COMMERCE_CATALOGUE_RESOURCES] },
        parentId: { type: "string", description: "With child: the offering's or pricing rule's id." },
        child: { type: "string", enum: [...COMMERCE_CHILDREN], description: "variants, specs and media belong to offerings; targets to pricing-rules." },
        fields: fieldsProperty,
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "resource", "fields", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "commerce_draft_edit",
    description: "Change a record on a connected website at the row version you read: a catalogue record or an offering variant, a quote (status, poReference, quotedTotalMinor, validUntil) or a draft invoice that has no number yet (poReference, totals, lines). A stale expectedRowVersion is refused with the current row: read it again. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_draft_edit,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        resource: { type: "string", enum: [...COMMERCE_EDIT_RESOURCES] },
        id: { type: "string" },
        child: { type: "string", enum: ["variants"] },
        childId: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 1 },
        fields: fieldsProperty,
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "resource", "id", "expectedRowVersion", "fields", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "commerce_draft_delete",
    description: "Remove a catalogue record on a connected website: a vendor, category, offering, pricing rule or variant is soft deleted at the row version you read; an offering's spec or media row, or a pricing rule's target, is deleted. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_draft_delete,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        resource: { type: "string", enum: [...WEBSITE_COMMERCE_CATALOGUE_RESOURCES] },
        id: { type: "string" },
        child: { type: "string", enum: [...COMMERCE_CHILDREN] },
        childId: { type: "string" },
        expectedRowVersion: { type: "integer", minimum: 1, description: "Needed for a record or a variant; not for a spec, media row or target." },
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "resource", "id", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "commerce_convert_quote",
    description: "Turn a quote on a connected website into a draft invoice: an order in pending with no invoice number. A person issues it. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_convert_quote,
    inputSchema: {
      type: "object",
      properties: { siteId: siteIdProperty, quoteId: { type: "string" }, idempotencyKey: idempotencyKeyProperty },
      required: ["siteId", "quoteId", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "commerce_import_dry_run",
    description: "Make an import job on a connected website as a dry run: the rows as you planned them (rowNumber, raw, mapped, action insert|update|noop|skip|error, errors). Nothing in the catalogue changes; a person applies a validated job. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_import_dry_run,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        filename: { type: "string" },
        type: { type: "string", enum: ["offerings", "variants", "pricing", "vendors", "categories", "mixed"] },
        rows: { type: "array", minItems: 1, maxItems: 2000, items: { type: "object" } },
        columnMapping: { type: "object" },
        sourceChecksum: { type: "string" },
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "filename", "type", "rows", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "commerce_request_refund",
    description: "Ask for a refund on a website order. The site records the request and a person with Commerce rights decides it on a GSAM card. This moves no money: a person refunds in Stripe. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_request_refund,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        orderId: { type: "string" },
        amountMinor: { type: "integer", minimum: 1, description: "In the order's currency, minor units (pence, cents)." },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "orderId", "amountMinor", "reason", "idempotencyKey"],
      additionalProperties: false,
    },
  },
];

/**
 * Parallel Interview (GRE-2667): agents read a round's status and synthesis, and draft question sets for a person to
 * approve. No tool approves a set, decides a proposal, releases or withdraws: those routes answer an agent with 403,
 * and these tools never call them.
 */
const roundIdProperty = { type: "string", description: "The interview round id (interview_round_get shows it)." };
const INTERVIEW_TOOLS = [
  {
    name: "interview_round_get",
    description: "Read this company's Parallel Interview round: its status, mode, question sets (draft or approved) with who drafted and approved each, how many people are invited, started, completed, abandoned or declined per team, and what the client sees now. No names, emails or interview answers.",
    annotations: PROJECT_TOOL_HINTS.interview_round_get,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "interview_synthesis_get",
    description: "Read a round's synthesis: each proposed theme, quote and role with what a person decided, whether it is reviewed enough to release (and what still blocks it), and what the client sees now. Release is a person's action in GSAM.",
    annotations: PROJECT_TOOL_HINTS.interview_synthesis_get,
    inputSchema: { type: "object", properties: { roundId: roundIdProperty }, required: ["roundId"], additionalProperties: false },
  },
  {
    name: "interview_set_draft",
    description: "Draft the question set for one team (per-team round) or one person (per-person round) from what the Deep Dive knows now. It stays Draft; a person approves it before anyone is invited. Only while the round is in setup.",
    annotations: PROJECT_TOOL_HINTS.interview_set_draft,
    inputSchema: {
      type: "object",
      properties: {
        roundId: roundIdProperty,
        unitId: { type: "string", description: "Per-team round: the team's id on the organisation board." },
        personId: { type: "string", description: "Per-person round: the person's id on the organisation board." },
      },
      required: ["roundId"],
      additionalProperties: false,
    },
  },
];

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
  return workMode === "skill_test" ? catalog : [...catalog, WEBSITE_FEATURES_TOOL, ...WEBSITE_DATA_TOOLS, WEBSITE_STYLE_TOOL, ...WEBSITE_COMMERCE_TOOLS, ...INTERVIEW_TOOLS];
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

async function apiSend(apiUrl: string, token: string, method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, idempotencyKey: string) {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const current = result?.details?.current ? ` The row now: ${JSON.stringify(result.details.current)}` : "";
    throw new Error(`${typeof result.error === "string" ? result.error : `Commerce change failed (${response.status})`}${current}`);
  }
  return result;
}

/** The site's 22-character key from the agent's own: the same agent, tool and key always give the same one. */
function commerceKey(agentId: string, tool: string, key: string) {
  return createHash("sha256").update(`commerce-tool:${agentId}:${tool}:${key}`).digest().subarray(0, 16).toString("base64url");
}

/** A commerce draft, through GSAM's commerce route, so the permission, people-only and fail-closed checks apply. */
async function commerceToolCall(input: { apiUrl: string; token: string; companyId: string; agentId: string; name: string; args: Record<string, unknown> }) {
  const uuid = z.string().uuid();
  const common = { siteId: uuid, idempotencyKey: z.string().min(1).max(200) };
  const fields = z.record(z.string(), z.unknown());
  const site = (siteId: string) => `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(siteId)}/commerce`;
  let method: "POST" | "PATCH" | "DELETE";
  let parts: string[];
  let body: unknown;
  let siteId: string;
  let key: string;
  if (input.name === "commerce_request_refund") {
    const args = z.object({ ...common, orderId: uuid, amountMinor: z.number().int().positive(), reason: z.string() }).strict().parse(input.args);
    const refund = websiteCommerceRefundRequestSchema.parse({ orderId: args.orderId, amountMinor: args.amountMinor, reason: args.reason });
    return apiSend(input.apiUrl, input.token, "POST", `${site(args.siteId)}/refund-requests`, refund, commerceKey(input.agentId, input.name, args.idempotencyKey));
  }
  if (input.name === "commerce_draft_create") {
    const args = z.object({ ...common, resource: z.enum(WEBSITE_COMMERCE_CATALOGUE_RESOURCES), parentId: uuid.optional(),
      child: z.enum(COMMERCE_CHILDREN).optional(), fields }).strict().parse(input.args);
    if (Boolean(args.child) !== Boolean(args.parentId)) throw badRequest("child and parentId go together");
    if ("status" in args.fields) throw badRequest("A draft has no status: a person publishes it");
    ({ siteId, idempotencyKey: key } = args);
    method = "POST";
    parts = args.child ? [args.resource, args.parentId!, args.child] : [args.resource];
    body = args.fields;
  } else if (input.name === "commerce_draft_edit") {
    const args = z.object({ ...common, resource: z.enum(COMMERCE_EDIT_RESOURCES), id: uuid, child: z.enum(["variants"]).optional(),
      childId: uuid.optional(), expectedRowVersion: z.number().int().min(1), fields }).strict().parse(input.args);
    if (Boolean(args.child) !== Boolean(args.childId)) throw badRequest("child and childId go together");
    ({ siteId, idempotencyKey: key } = args);
    method = "PATCH";
    parts = args.child ? [args.resource, args.id, args.child, args.childId!] : [args.resource, args.id];
    body = { ...args.fields, expectedRowVersion: args.expectedRowVersion };
  } else if (input.name === "commerce_draft_delete") {
    const args = z.object({ ...common, resource: z.enum(WEBSITE_COMMERCE_CATALOGUE_RESOURCES), id: uuid,
      child: z.enum(COMMERCE_CHILDREN).optional(), childId: uuid.optional(), expectedRowVersion: z.number().int().min(1).optional() })
      .strict().parse(input.args);
    if (Boolean(args.child) !== Boolean(args.childId)) throw badRequest("child and childId go together");
    ({ siteId, idempotencyKey: key } = args);
    method = "DELETE";
    parts = args.child ? [args.resource, args.id, args.child, args.childId!] : [args.resource, args.id];
    body = args.expectedRowVersion === undefined ? undefined : { expectedRowVersion: args.expectedRowVersion };
  } else if (input.name === "commerce_convert_quote") {
    const args = z.object({ ...common, quoteId: uuid }).strict().parse(input.args);
    ({ siteId, idempotencyKey: key } = args);
    method = "POST";
    parts = ["quotes", args.quoteId, "convert"];
  } else {
    const args = z.object({ ...common, filename: z.string(), type: z.string(), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
      columnMapping: fields.optional(), sourceChecksum: z.string().optional() }).strict().parse(input.args);
    ({ siteId, idempotencyKey: key } = args);
    method = "POST";
    parts = ["imports"];
    body = { filename: args.filename, type: args.type, rows: args.rows,
      ...(args.columnMapping ? { columnMapping: args.columnMapping } : {}), ...(args.sourceChecksum ? { sourceChecksum: args.sourceChecksum } : {}) };
  }
  // the same table the route checks: a tool can only ask for an operation an agent may do
  const operation = websiteCommerceWriteOperation(method, parts);
  if (!operation || operation.peopleOnly) throw badRequest("That commerce change is not one an agent can make");
  return apiSend(input.apiUrl, input.token, method, `${site(siteId)}/${parts.map(encodeURIComponent).join("/")}`, body,
    commerceKey(input.agentId, input.name, key));
}

const COMMERCE_TOOL_NAMES = new Set(WEBSITE_COMMERCE_TOOLS.map((tool) => tool.name));

/** Through the normal interview routes, so the company check, the entitlement and the people-only rules apply. */
async function interviewToolCall(input: { apiUrl: string; token: string; companyId: string; name: string; args: Record<string, unknown> }) {
  const uuid = z.string().uuid();
  if (input.name === "interview_round_get") {
    z.object({}).strict().parse(input.args);
    const company = `/companies/${encodeURIComponent(input.companyId)}/deep-dive/interview-round`;
    const view = await apiGet(input.apiUrl, input.token, company);
    const round = view.round as { id: string; status: string } | null;
    if (!round || round.status === "setup") return { ...view, progress: null, release: null };
    const [progress, release] = await Promise.all([
      apiGet(input.apiUrl, input.token, `${company}/progress`),
      apiGet(input.apiUrl, input.token, `/deep-dive/interview-rounds/${encodeURIComponent(round.id)}/synthesis/release`),
    ]);
    // Counts only: names and emails stay on the progress page.
    const { people: _people, ...counts } = progress as { people?: unknown };
    return { ...view, progress: counts, release };
  }
  if (input.name === "interview_synthesis_get") {
    const { roundId } = z.object({ roundId: uuid }).strict().parse(input.args);
    const round = `/deep-dive/interview-rounds/${encodeURIComponent(roundId)}/synthesis`;
    const [proposals, release] = await Promise.all([
      apiGet(input.apiUrl, input.token, `${round}/proposals`),
      apiGet(input.apiUrl, input.token, `${round}/release`),
    ]);
    return { ...proposals, release };
  }
  const args = z.object({ roundId: uuid, unitId: uuid.optional(), personId: uuid.optional() }).strict().parse(input.args);
  if (Boolean(args.unitId) === Boolean(args.personId)) throw badRequest("Give a unitId or a personId");
  const target = args.unitId ? { unitId: args.unitId } : { personId: args.personId };
  // A draft only: approving is a person's action, and no tool calls it.
  return apiSend(input.apiUrl, input.token, "POST", `/deep-dive/interview-rounds/${encodeURIComponent(args.roundId)}/sets`, target,
    createHash("sha256").update(`interview-set-draft:${args.roundId}:${args.unitId ?? args.personId}`).digest("base64url").slice(0, 22));
}

const INTERVIEW_TOOL_NAMES = new Set(INTERVIEW_TOOLS.map((tool) => tool.name));

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
  if (COMMERCE_TOOL_NAMES.has(input.name)) {
    return commerceToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, agentId: input.agentId, name: input.name, args });
  }
  if (INTERVIEW_TOOL_NAMES.has(input.name)) {
    return interviewToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, name: input.name, args });
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
