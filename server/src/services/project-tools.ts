import { createHash } from "node:crypto";
import {
  WEBSITE_COMMERCE_CATALOGUE_RESOURCES,
  WEBSITE_COMMERCE_RESOURCES,
  WEBSITE_DATA_RESOURCES,
  WEBSITE_CLIENT_MEMBER_ROLES,
  WEBSITE_STAFF_ROLES,
  WEBSITE_PORTAL_DOCUMENT_ACTIONS,
  WEBSITE_PORTAL_DOCUMENT_KINDS,
  createProjectSchema,
  createIssueSchema,
  mcpToolHints,
  websiteCommerceRefundRequestSchema,
  websiteCommercePublishRequestSchema,
  websiteCommerceWriteOperation,
  websiteAccessChangeRequestSchema,
  websitePortalDocumentCreateSchema,
  websitePortalDocumentEditSchema,
  websitePortalDocumentStepSchema,
  websiteRedirectInputSchema,
  renameWebsiteMediaSchema,
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
  // GRE-4089: opens a card only; the same open ask returns the same card.
  commerce_request_publish: mcpToolHints("write", { idempotent: true }),
  // GRE-4085: people and access. Reads are open; a change is only ever an ask (a card), and the same ask returns it.
  website_access_list: mcpToolHints("read"),
  website_access_request_change: mcpToolHints("write", { idempotent: true }),
  // GRE-4083: portal document drafts. Each takes an idempotency key, so a retry writes once.
  portal_document_create: mcpToolHints("write", { idempotent: true }),
  portal_document_edit: mcpToolHints("write", { idempotent: true }),
  portal_document_submit: mcpToolHints("write", { idempotent: true }),
  portal_document_return_to_draft: mcpToolHints("write", { idempotent: true }),
  // GRE-4785: redirects and media. A save or delete is a draft change; a person approves and publishes it.
  website_redirect_list: mcpToolHints("read"),
  website_redirect_save: mcpToolHints("write", { idempotent: true }),
  website_redirect_delete: mcpToolHints("destructive", { idempotent: true }),
  website_media_list: mcpToolHints("read"),
  website_media_rename: mcpToolHints("write", { idempotent: true }),
  website_media_delete: mcpToolHints("destructive", { idempotent: true }),
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
 * Catalogue rows an agent makes stay draft until a person publishes them. GRE-4089 (John, 5 Nov): an agent may ask to
 * publish or archive one with commerce_request_publish, which opens a card; a person's approval publishes it.
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
  {
    name: "commerce_request_publish",
    description: "Ask a person to publish or archive one catalogue record on a connected website (a vendor, category, offering or pricing rule). This publishes nothing: it opens an approval card on your task with the record as it is now. A person with Commerce rights approves it and GSAM publishes it in their name. If the record changes before they decide, the card is void and you must ask again. Asking twice for the same record and version returns the same card. Needs website:commerce.",
    annotations: PROJECT_TOOL_HINTS.commerce_request_publish,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        resource: { type: "string", enum: [...WEBSITE_COMMERCE_CATALOGUE_RESOURCES] },
        id: { type: "string" },
        action: { type: "string", enum: ["publish", "archive"] },
        note: { type: "string", minLength: 1, maxLength: 2000, description: "Why, for the person who decides." },
      },
      required: ["siteId", "resource", "id", "action"],
      additionalProperties: false,
    },
  },
];

/**
 * People and access (GRE-4085): a connected site's staff roles, portal approvers and client company members. John
 * (5 Nov): "a person approves every access change". So an agent reads, and asks: website_access_request_change opens
 * a card on its task and changes nothing; a person with Publish rights approves it and GSAM makes the change in their
 * name. No tool calls a change route; those routes refuse an agent with 403 website_access_people_only.
 */
const WEBSITE_ACCESS_LISTS = ["staff", "portal-approvers", "client-members"] as const;
const WEBSITE_ACCESS_KINDS = ["staff_role", "approver_set", "approver_remove", "member_add", "member_role", "member_remove"] as const;
const WEBSITE_ACCESS_TOOLS = [
  {
    name: "website_access_list",
    description: "Read who has access on a connected website: `staff` (each staff member's role, whether they can sign in, whether they are a portal approver), `portal-approvers` (who may approve portal documents, with their label), or `client-members` (the people of one client company, by its customer id, with their role). Read only.",
    annotations: PROJECT_TOOL_HINTS.website_access_list,
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The website site id (list_website_features shows them)." },
        list: { type: "string", enum: [...WEBSITE_ACCESS_LISTS] },
        customerId: { type: "string", description: "client-members only: the client company's customer id (website_data_list customers shows them)." },
      },
      required: ["siteId", "list"],
      additionalProperties: false,
    },
  },
  {
    name: "website_access_request_change",
    description: "Ask a person to change access on a connected website. This changes nothing: it opens an approval card on your task with the person's access as it is now. A person with Publish rights approves it and GSAM makes the change in their name. If that person's access changes before they decide, the card is void and you must ask again. Asking twice for the same change returns the same card. Kinds: staff_role (staffId, role), approver_set (staffId, label), approver_remove (staffId), member_add (customerId, email, name, role), member_role (customerId, membershipId, role), member_remove (customerId, membershipId). The site keeps one active owner.",
    annotations: PROJECT_TOOL_HINTS.website_access_request_change,
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The website site id (list_website_features shows them)." },
        kind: { type: "string", enum: [...WEBSITE_ACCESS_KINDS] },
        staffId: { type: "string", description: "staff_role, approver_set, approver_remove: the staff id from website_access_list staff." },
        customerId: { type: "string", description: "member_*: the client company's customer id." },
        membershipId: { type: "string", description: "member_role, member_remove: from website_access_list client-members." },
        role: { type: "string", enum: [...new Set([...WEBSITE_STAFF_ROLES, ...WEBSITE_CLIENT_MEMBER_ROLES])],
          description: "staff_role: owner, admin, editor, sales or viewer. member_add, member_role: admin or member." },
        label: { type: "string", minLength: 1, maxLength: 100, description: "approver_set: how the approver is shown, e.g. \"Finance lead\"." },
        email: { type: "string", description: "member_add: the person's email. They sign in from the email the website sends." },
        name: { type: "string", minLength: 1, maxLength: 200, description: "member_add: the person's name." },
        note: { type: "string", minLength: 1, maxLength: 2000, description: "Why, for the person who decides." },
      },
      required: ["siteId", "kind"],
      additionalProperties: false,
    },
  },
];

/** Reads through GSAM's access routes (website:view); an ask through change-requests. Never a change route. */
async function accessToolCall(input: { apiUrl: string; token: string; companyId: string; agentId: string; issueId: string | null;
  name: string; args: Record<string, unknown> }) {
  const uuid = z.string().uuid();
  const site = (siteId: string) => `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(siteId)}/access`;
  if (input.name === "website_access_list") {
    const args = z.object({ siteId: uuid, list: z.enum(WEBSITE_ACCESS_LISTS), customerId: uuid.optional() }).strict().parse(input.args);
    if ((args.list === "client-members") !== Boolean(args.customerId)) throw badRequest("customerId goes with client-members, and only with it");
    return apiGet(input.apiUrl, input.token, args.list === "client-members"
      ? `${site(args.siteId)}/clients/${encodeURIComponent(args.customerId!)}/members` : `${site(args.siteId)}/${args.list}`);
  }
  const { siteId, note, ...change } = z.object({ siteId: uuid, note: z.string().optional() }).passthrough().parse(input.args);
  const ask = websiteAccessChangeRequestSchema.parse({ change, ...(note ? { note } : {}),
    ...(input.issueId && uuid.safeParse(input.issueId).success ? { issueId: input.issueId } : {}) });
  return apiSend(input.apiUrl, input.token, "POST", `${site(siteId)}/change-requests`, ask,
    commerceKey(input.agentId, input.name, createHash("sha256").update(JSON.stringify(ask.change)).digest("hex")));
}

const ACCESS_TOOL_NAMES = new Set(WEBSITE_ACCESS_TOOLS.map((tool) => tool.name));

/**
 * Portal documents (GRE-4083): a client's engagement pack, NDA, terms and the rest on the website's client portal. An
 * agent drafts through GSAM's portal document routes (website:edit), signed with the site's write key; the site's audit
 * names this agent and run. No tool approves and publishes or withdraws: those are a person's click, and the routes
 * refuse an agent with 403 website_publish_agent_refused before any call to the site.
 */
const documentIdProperty = { type: "string", description: "The portal document id (website_data_list portal-documents shows them)." };
const rowVersionProperty = { type: "integer", minimum: 0, description: "row_version of the document as you last read it. A stale one is refused with the current document: read it again." };
const portalFieldProperties = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  summary: { type: ["string", "null"], maxLength: 2000 },
  body: {
    type: ["object", "null"],
    description: "{ sections: [{ id, title, html }] }: up to 60 sections; id is 1 to 64 letters, digits, - or _; html up to 100000 characters, only the tags p h2 h3 h4 h5 h6 ul ol li strong em b i a br blockquote code pre span hr, links to https:// or mailto:, and a plain class. Anything else is refused, not rewritten.",
  },
  demos: { type: ["array", "null"], maxItems: 20, items: { type: "object" }, description: "[{ label, url (https), note, afterSection (a section id) }]." },
  action: { type: ["string", "null"], enum: [...WEBSITE_PORTAL_DOCUMENT_ACTIONS, null], description: "What the client does with it. accept and agree_in_principle need confirmationText before submit." },
  confirmationText: { type: ["string", "null"], maxLength: 1000, description: "The words the client confirms." },
  signatoryEmail: { type: ["string", "null"], description: "Who signs for the client." },
};
const WEBSITE_PORTAL_TOOLS = [
  {
    name: "portal_document_create",
    description: "Create a draft portal document for one client on a connected website: an engagement pack, NDA, GITA, terms, pre-read, north star, investigation plan or GDXP. It stays draft and the client does not see it. series starts the next version of an existing document of the same client. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.portal_document_create,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        customerId: { type: "string", description: "The client's customer id (website_data_list customers shows them)." },
        kind: { type: "string", enum: [...WEBSITE_PORTAL_DOCUMENT_KINDS] },
        series: { type: "string", description: "The series id of the client's document this is the next version of." },
        ...portalFieldProperties,
        idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "customerId", "kind", "title", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "portal_document_edit",
    description: "Change a draft portal document on a connected website at the row version you read. Only a draft changes; a published document changes by a new version (portal_document_create with its series). null clears a field. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.portal_document_edit,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty, documentId: documentIdProperty, expectedRowVersion: rowVersionProperty,
        ...portalFieldProperties, idempotencyKey: idempotencyKeyProperty,
      },
      required: ["siteId", "documentId", "expectedRowVersion", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "portal_document_submit",
    description: "Send a draft portal document for approval: it goes to pending_approval and the site freezes its content. A portal approver (a person) approves and publishes it; no agent can. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.portal_document_submit,
    inputSchema: {
      type: "object",
      properties: { siteId: siteIdProperty, documentId: documentIdProperty, expectedRowVersion: rowVersionProperty, idempotencyKey: idempotencyKeyProperty },
      required: ["siteId", "documentId", "expectedRowVersion", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "portal_document_return_to_draft",
    description: "Take a portal document that waits for approval back to draft, so it can be changed. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.portal_document_return_to_draft,
    inputSchema: {
      type: "object",
      properties: { siteId: siteIdProperty, documentId: documentIdProperty, expectedRowVersion: rowVersionProperty, idempotencyKey: idempotencyKeyProperty },
      required: ["siteId", "documentId", "expectedRowVersion", "idempotencyKey"],
      additionalProperties: false,
    },
  },
];

/** Through GSAM's portal document routes, so the permission and people-only checks apply. Never approve or withdraw. */
async function portalToolCall(input: { apiUrl: string; token: string; companyId: string; agentId: string; name: string;
  args: Record<string, unknown> }) {
  const { siteId, documentId, idempotencyKey, ...fields } = z.object({ siteId: z.string().uuid(), documentId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(200) }).passthrough().parse(input.args);
  const base = `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(siteId)}/portal-documents`;
  const key = commerceKey(input.agentId, input.name, idempotencyKey);
  if (input.name === "portal_document_create") {
    if (documentId) throw badRequest("A new document has no documentId");
    return apiSend(input.apiUrl, input.token, "POST", base, websitePortalDocumentCreateSchema.parse(fields), key);
  }
  if (!documentId) throw badRequest(`${input.name} needs a documentId`);
  const doc = `${base}/${encodeURIComponent(documentId)}`;
  if (input.name === "portal_document_edit") {
    return apiSend(input.apiUrl, input.token, "PATCH", doc, websitePortalDocumentEditSchema.parse(fields), key);
  }
  const step = websitePortalDocumentStepSchema.parse(fields);
  return apiSend(input.apiUrl, input.token, "POST", `${doc}/${input.name === "portal_document_submit" ? "submit" : "return-to-draft"}`, step, key);
}

const PORTAL_TOOL_NAMES = new Set(WEBSITE_PORTAL_TOOLS.map((tool) => tool.name));

/**
 * Redirects and media (GRE-4785, GRE-4079 step 5d), through GSAM's Website module routes (website:edit for changes).
 * A redirect an agent saves is a draft; with sendForReview it waits for a person, who approves it, and it goes live
 * with the next Publish, which is a person's click. A deleted redirect or media entry leaves the site at that Publish
 * too. No tool approves or publishes: those routes refuse an agent.
 */
const entryIdProperty = { type: "string", description: "The entry id, as website_redirect_list or website_media_list shows it." };
const WEBSITE_REDIRECT_MEDIA_TOOLS = [
  {
    name: "website_redirect_list",
    description: "List a connected website's redirects: old path, new address, status code (301 permanent, 302 or 307 temporary, 308 permanent), state (draft, review, approved, published) and latestRevisionId.",
    annotations: PROJECT_TOOL_HINTS.website_redirect_list,
    inputSchema: { type: "object", properties: { siteId: siteIdProperty }, required: ["siteId"], additionalProperties: false },
  },
  {
    name: "website_redirect_save",
    description: "Add a redirect, or change one (give entryId and the baseRevisionId you read). It is saved as a draft; sendForReview asks a person to approve it, and it goes live with the next Publish. One redirect per old path; a path a page uses now, or a loop, is refused. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.website_redirect_save,
    inputSchema: {
      type: "object",
      properties: {
        siteId: siteIdProperty,
        entryId: { ...entryIdProperty, description: "Only to change a redirect. Leave out to add one." },
        baseRevisionId: { type: "string", description: "With entryId: latestRevisionId of the redirect as you read it. A stale one is refused: read the list again." },
        from: { type: "string", description: "The old path on this site, starting with /, with no ? or #." },
        to: { type: "string", description: "A path on this site starting with /, or an https:// address." },
        status: { type: "integer", enum: [301, 302, 307, 308], description: "301 (default) for a page that moved for good." },
        sendForReview: { type: "boolean", description: "Send it to a person to approve after the save." },
      },
      required: ["siteId", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "website_redirect_delete",
    description: "Delete a redirect. It leaves the site at the next Publish; its history stays. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.website_redirect_delete,
    inputSchema: { type: "object", properties: { siteId: siteIdProperty, entryId: entryIdProperty }, required: ["siteId", "entryId"], additionalProperties: false },
  },
  {
    name: "website_media_list",
    description: "List a connected website's media: each entry's id, name (entryKey), alt text, caption, file type and size.",
    annotations: PROJECT_TOOL_HINTS.website_media_list,
    inputSchema: { type: "object", properties: { siteId: siteIdProperty }, required: ["siteId"], additionalProperties: false },
  },
  {
    name: "website_media_rename",
    description: "Rename a media entry. Only the name changes: the file and the pages that use it stay as they are. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.website_media_rename,
    inputSchema: {
      type: "object",
      properties: { siteId: siteIdProperty, entryId: entryIdProperty, name: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["siteId", "entryId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "website_media_delete",
    description: "Delete a media entry. It leaves the site at the next Publish; the file stays in the company's files. Refused while a page or entry uses it: the error names them. Needs website:edit.",
    annotations: PROJECT_TOOL_HINTS.website_media_delete,
    inputSchema: { type: "object", properties: { siteId: siteIdProperty, entryId: entryIdProperty }, required: ["siteId", "entryId"], additionalProperties: false },
  },
];

/** Through the Website module routes, so the company check, website:edit and the redirect checks apply. */
async function redirectMediaToolCall(input: { apiUrl: string; token: string; companyId: string; agentId: string; name: string;
  args: Record<string, unknown> }) {
  const uuid = z.string().uuid();
  const { siteId } = z.object({ siteId: uuid }).passthrough().parse(input.args);
  const site = `/companies/${encodeURIComponent(input.companyId)}/website/sites/${encodeURIComponent(siteId)}`;
  const key = (body: unknown) => commerceKey(input.agentId, input.name, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
  if (input.name === "website_redirect_list") return { redirects: await apiGet(input.apiUrl, input.token, `${site}/redirects`) };
  if (input.name === "website_media_list") return { media: await apiGet(input.apiUrl, input.token, `${site}/media`) };
  if (input.name === "website_redirect_save") {
    const args = z.object({ siteId: uuid, entryId: uuid.optional(), baseRevisionId: uuid.optional(), sendForReview: z.boolean().optional() })
      .passthrough().parse(input.args);
    if (Boolean(args.entryId) !== Boolean(args.baseRevisionId)) throw badRequest("entryId and baseRevisionId go together");
    const { siteId: _site, entryId, baseRevisionId, sendForReview, ...fields } = args;
    const redirect = websiteRedirectInputSchema.parse(fields);
    const saved = entryId
      ? await apiSend(input.apiUrl, input.token, "PATCH", `${site}/redirects/${encodeURIComponent(entryId)}`, { ...redirect, baseRevisionId }, key({ entryId, baseRevisionId, redirect }))
      : await apiSend(input.apiUrl, input.token, "POST", `${site}/redirects`, redirect, key(redirect));
    if (!sendForReview || saved.state === "review") return saved;
    const submitted = await apiSend(input.apiUrl, input.token, "POST", `${site}/entries/${encodeURIComponent(saved.entryId)}/submit`, {}, key({ submit: saved.entryId, revision: saved.latestRevisionId }));
    return { ...saved, state: submitted.status };
  }
  const args = z.object({ siteId: uuid, entryId: uuid, name: z.string().optional() }).strict().parse(input.args);
  const entry = encodeURIComponent(args.entryId);
  if (input.name === "website_media_rename") {
    const body = renameWebsiteMediaSchema.parse({ name: args.name });
    return apiSend(input.apiUrl, input.token, "PATCH", `${site}/media/${entry}`, body, key({ entryId: args.entryId, ...body }));
  }
  if (args.name !== undefined) throw badRequest(`${input.name} takes no name`);
  const path = input.name === "website_media_delete" ? `${site}/media/${entry}` : `${site}/redirects/${entry}`;
  return apiSend(input.apiUrl, input.token, "DELETE", path, undefined, key({ entryId: args.entryId }));
}

const REDIRECT_MEDIA_TOOL_NAMES = new Set(WEBSITE_REDIRECT_MEDIA_TOOLS.map((tool) => tool.name));

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
  return workMode === "skill_test" ? catalog : [...catalog, WEBSITE_FEATURES_TOOL, ...WEBSITE_DATA_TOOLS, WEBSITE_STYLE_TOOL, ...WEBSITE_COMMERCE_TOOLS, ...WEBSITE_ACCESS_TOOLS, ...WEBSITE_PORTAL_TOOLS,
    ...WEBSITE_REDIRECT_MEDIA_TOOLS, ...INTERVIEW_TOOLS];
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
async function commerceToolCall(input: { apiUrl: string; token: string; companyId: string; agentId: string; issueId: string | null;
  name: string; args: Record<string, unknown> }) {
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
  if (input.name === "commerce_request_publish") {
    const args = z.object({ siteId: uuid, resource: z.enum(WEBSITE_COMMERCE_CATALOGUE_RESOURCES), id: uuid,
      action: z.enum(["publish", "archive"]), note: z.string().optional() }).strict().parse(input.args);
    const ask = websiteCommercePublishRequestSchema.parse({ resource: args.resource, id: args.id, action: args.action,
      ...(args.note ? { note: args.note } : {}), ...(input.issueId && uuid.safeParse(input.issueId).success ? { issueId: input.issueId } : {}) });
    return apiSend(input.apiUrl, input.token, "POST", `${site(args.siteId)}/publish-requests`, ask,
      commerceKey(input.agentId, input.name, `${args.resource}:${args.id}:${args.action}`));
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
    return commerceToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, agentId: input.agentId,
      issueId: input.conversation ? null : input.issueId, name: input.name, args });
  }
  if (ACCESS_TOOL_NAMES.has(input.name)) {
    return accessToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, agentId: input.agentId,
      issueId: input.conversation ? null : input.issueId, name: input.name, args });
  }
  if (PORTAL_TOOL_NAMES.has(input.name)) {
    return portalToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, agentId: input.agentId, name: input.name, args });
  }
  if (REDIRECT_MEDIA_TOOL_NAMES.has(input.name)) {
    return redirectMediaToolCall({ apiUrl: input.apiUrl, token: input.token, companyId: input.companyId, agentId: input.agentId, name: input.name, args });
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
