import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@greatstone/db";
import {
  WEBSITE_ACCESS_API_ROUTES,
  WEBSITE_COMMERCE_RESOURCES,
  WEBSITE_DATA_BRIDGE_API_ROUTES,
  WEBSITE_DATA_RESOURCES,
  WEBSITE_PORTAL_DOCUMENT_API_ROUTES,
  WEBSITE_PORTAL_DOCUMENT_MAX_BODY_BYTES,
  createWebsiteDataBridgeKeySchema,
  websiteCommerceItemQuerySchema,
  websiteCommerceListQuerySchema,
  websiteDataListQuerySchema,
  websiteActivityEventsQuerySchema,
  websiteCommerceRefundRequestSchema,
  websiteCommercePublishRequestSchema,
  websiteCommerceWriteOperation,
  websitePaymentReportQuerySchema,
  websiteVendorActivationStepsSchema,
  websiteAccessChangeRequestSchema,
  websiteAccessChangeSchema,
  websiteClientMemberAddSchema,
  websiteClientMemberRoleSchema,
  websitePortalApproverSchema,
  websiteStaffRoleSchema,
  websitePortalDocumentApproveSchema,
  websitePortalDocumentCreateSchema,
  websitePortalDocumentEditSchema,
  websitePortalDocumentStepSchema,
  type WebsiteAccessChange,
  type WebsitePortalDocumentStep,
  type PermissionKey,
  type WebsiteCommerceWriteMethod,
  type WebsiteCommerceResource,
  type WebsiteDataResource,
} from "@greatstone/shared";
import { HttpError, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, issueApprovalService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { websiteDataBridgeService, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";
import { commerceRefundApprovals } from "../services/website/commerce-refund-approval.js";
import { commercePublishApprovals } from "../services/website/commerce-publish-approval.js";
import { websiteActivityService } from "../services/website/activity.js";
import { accessChangeLogDetails, websiteAccessService } from "../services/website/access.js";
import type { WebsiteBridgeActor } from "../services/website/data-bridge-client.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const NO_QUERY = z.object({}).strict();
/** The site takes at most 64 KiB of body. */
const MAX_WRITE_BODY_BYTES = 64 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

// Website data (GRE-2323): reads from the site's own database through the signed admin bridge. Same order of checks
// as the website module routes: company access, the website permission, then the site by (company_id, id) or 404.
export function websiteDataBridgeRoutes(db: Db, options: WebsiteDataBridgeOptions = {}) {
  const router = Router();
  const sites = websiteModuleService(db);
  const access = accessService(db);
  const bridge = websiteDataBridgeService(db, options);
  const refunds = commerceRefundApprovals(db, options);
  const publishRequests = commercePublishApprovals(db, options);
  const websiteAccess = websiteAccessService(db, options);
  const issueApprovals = issueApprovalService(db);
  const activity = websiteActivityService(db, { read: async () => { throw new Error("Activity reads cannot pull the website"); } });

  router.use("/companies/:companyId/website/sites/:siteId/data-bridge", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/data", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/commerce", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/access", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/portal-documents", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/activity/:organisationId", requireEntitlement(db, "enableWebsiteView"));

  router.get("/companies/:companyId/website/activity/:organisationId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const organisationId = req.params.organisationId as string;
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({ actor: req.actor, action: "website:view", resource: { type: "company", companyId } });
    if (!decision.allowed && decision.reason !== "deny_scope") {
      throw new HttpError(403, WEBSITE_MESSAGES["perm.view_none"], { code: "website_permission_missing", permission: "website:view" });
    }
    if (!UUID_RE.test(organisationId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    let cursor: { siteId: string; sequence: bigint } | undefined;
    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(req.query.cursor)) {
        throw unprocessable("Invalid activity cursor");
      }
      try {
        const parts: unknown = JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8"));
        if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== "string" ||
          typeof parts[1] !== "string" || !/^[1-9]\d*$/.test(parts[0]) || !UUID_RE.test(parts[1])) throw new Error("invalid");
        cursor = { siteId: parts[1], sequence: BigInt(parts[0]) };
      } catch { throw unprocessable("Invalid activity cursor"); }
    }
    const companySites = await sites.listSites(companyId);
    const visibleSiteIds: string[] = [];
    for (const site of companySites) {
      const siteDecision = await access.decide({ actor: req.actor, action: "website:view", resource: { type: "company", companyId }, scope: { siteId: site.id } });
      if (siteDecision.allowed) visibleSiteIds.push(site.id);
    }
    res.json(await activity.list(companyId, organisationId, cursor, visibleSiteIds));
  });

  async function siteFor(req: Request, res: Response,
    permission: Extract<PermissionKey, "website:view" | "website:edit" | "website:publish" | "website:commerce">): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
    // The read key is made by a person: an agent never holds website:publish.
    if (permission === "website:publish" && req.actor.type === "agent") {
      throw new HttpError(403, WEBSITE_MESSAGES["agent.publish_refused"], { code: "website_publish_agent_refused", permission });
    }
    const decision = await access.decide({ actor: req.actor, action: permission, resource: { type: "company", companyId }, scope: { siteId } });
    if (!decision.allowed && decision.reason !== "deny_scope") {
      throw new HttpError(403, permission === "website:commerce"
        ? "You do not have Commerce rights for this site. Ask an admin of this company."
        : WEBSITE_MESSAGES[permission === "website:view" ? "perm.view_none" : permission === "website:edit" ? "perm.edit_none" : "perm.settings"],
      { code: "website_permission_missing", permission });
    }
    const site = decision.allowed && UUID_RE.test(siteId) ? await sites.getSite(companyId, siteId) : null;
    if (!site) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return site;
  }

  function actorOf(req: Request): WebsiteBridgeActor {
    const info = getActorInfo(req);
    return info.actorType === "agent"
      ? { type: "agent", id: info.agentId ?? info.actorId, runId: info.runId ?? null }
      : { type: "user", id: info.actorId };
  }

  function resourceOf(req: Request): WebsiteDataResource {
    const resource = req.params.resource as string;
    if (!(WEBSITE_DATA_RESOURCES as readonly string[]).includes(resource)) {
      throw unprocessable("Unknown website data resource", { code: "website_data_resource_unknown", resources: WEBSITE_DATA_RESOURCES });
    }
    return resource as WebsiteDataResource;
  }

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.status, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await bridge.status(site));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.health, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    queryOf(NO_QUERY, req);
    res.json(await bridge.releaseHealth(site, actorOf(req)));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.activityEvents, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const query = queryOf(websiteActivityEventsQuerySchema, req);
    res.json(await bridge.activityEvents(site, query.cursor, query.limit, actorOf(req)));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.schemaProbe, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    queryOf(NO_QUERY, req);
    res.json(await bridge.schemaProbe(site, actorOf(req)));
  });

  router.post(WEBSITE_DATA_BRIDGE_API_ROUTES.key, validate(createWebsiteDataBridgeKeySchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const actor = getActorInfo(req);
    const key = await bridge.createKey(site, req.body, actor.actorType === "user" ? actor.actorId : null);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.data_bridge_key_created",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { keyId: key.keyId, capability: key.capability, environment: req.body.environment,
        replaced: key.capability === "write" ? site.dataBridgeWriteKeyId
          : key.capability === "refund_request" ? site.dataBridgeRefundKeyId : site.dataBridgeReadKeyId, url: req.body.url },
    });
    res.status(201).json(key);
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.list, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const resource = resourceOf(req);
    const query = websiteDataListQuerySchema.safeParse(req.query);
    if (!query.success) throw unprocessable(`The filters are not valid: ${query.error.issues[0]?.path.join(".") || "query"}`, { code: "website_data_filters_invalid" });
    if (resource === "enquiries" && query.data.customer) throw unprocessable("Enquiries cannot be filtered by customer", { code: "website_data_filters_invalid" });
    if (resource === "billing-lines" && !query.data.customer) throw unprocessable("Billing lines require a customer", { code: "website_data_filters_invalid" });
    res.json(await bridge.list(site, resource, query.data, actorOf(req)));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.item, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const resource = resourceOf(req);
    const itemId = req.params.itemId as string;
    if (!ITEM_ID_RE.test(itemId)) {
      res.status(404).json({ error: "The website has no such record.", code: "website_bridge_not_found" });
      return;
    }
    res.json(await bridge.get(site, resource, itemId, actorOf(req)));
  });

  // Commerce reads (GRE-2354 2c(a)): the catalogue, pricing, FX, imports and the payment report, on the same read
  // key. Read only; the write capability is a separate key and separate routes (2c(b)).
  function commerceResourceOf(req: Request): WebsiteCommerceResource {
    const resource = req.params.resource as string;
    if (!(WEBSITE_COMMERCE_RESOURCES as readonly string[]).includes(resource)) {
      throw unprocessable("Unknown website commerce resource", { code: "website_commerce_resource_unknown", resources: WEBSITE_COMMERCE_RESOURCES });
    }
    return resource as WebsiteCommerceResource;
  }

  function queryOf<T>(schema: z.ZodType<T>, req: Request): T {
    const query = schema.safeParse(req.query);
    if (!query.success) throw unprocessable(`The filters are not valid: ${query.error.issues[0]?.path.join(".") || "query"}`, { code: "website_data_filters_invalid" });
    return query.data;
  }

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceFx, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    queryOf(NO_QUERY, req);
    res.json(await bridge.commerce.fx(site, actorOf(req)));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.commercePayments, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await bridge.commerce.payments(site, queryOf(websitePaymentReportQuerySchema, req), actorOf(req)));
  });

  // ---- commerce writes and refund requests (GRE-2354 2c(b)) ----
  // website:commerce. People-only operations refuse an agent (and a board API key: a script, not a click) with 403
  // before any vault read or call to the site; the site refuses an agent again. A null key is 409
  // capability_not_configured, also with no call to the site.

  function personClickOrRefuse(req: Request, operation: string) {
    const actor = req.actor;
    if (actor.type === "board" && actor.userId && (actor.source === "session" || actor.source === "local_implicit")) return;
    throw new HttpError(403, "Only a person can do this, by clicking in GSAM. Agents draft; people publish, archive, change FX, "
      + "apply imports, issue invoices and decide refunds.", { code: "website_commerce_people_only", operation });
  }

  function idempotencyKeyOf(req: Request) {
    const raw = req.get("idempotency-key");
    if (raw === undefined) return undefined;
    if (!IDEMPOTENCY_KEY_RE.test(raw)) throw unprocessable("Idempotency-Key must be 22 base64url characters", { code: "website_commerce_idempotency_key_invalid" });
    return raw;
  }

  function writeBodyOf(req: Request, method: WebsiteCommerceWriteMethod) {
    const body: unknown = req.body;
    if (body === undefined || body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) {
      // no body: DELETE of a child row, quote convert. A versioned delete or edit sends expectedRowVersion in a body.
      return method === "PATCH" ? {} : undefined;
    }
    if (typeof body !== "object" || Array.isArray(body)) throw unprocessable("The body must be a JSON object", { code: "website_commerce_body_invalid" });
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_WRITE_BODY_BYTES) {
      throw new HttpError(413, "The change is too large for the website (64 KiB at most)", { code: "website_commerce_body_too_large" });
    }
    return body as Record<string, unknown>;
  }

  router.post(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceRefundRequests, async (req, res) => {
    const site = await siteFor(req, res, "website:commerce");
    if (!site) return;
    const input = websiteCommerceRefundRequestSchema.safeParse(req.body);
    if (!input.success) throw unprocessable(`The refund request is not valid: ${input.error.issues[0]?.path.join(".") || "body"}`, { code: "website_commerce_refund_invalid" });
    const actor = getActorInfo(req);
    const result = await refunds.request(site, input.data, {
      agentId: actor.actorType === "agent" ? actor.agentId ?? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      bridge: actorOf(req),
    }, idempotencyKeyOf(req));
    if (result.replayed) {
      res.status(200).json({ approval: result.approval, request: result.request });
      return;
    }
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.commerce_refund_requested",
      entityType: "approval", entityId: result.approval.id, agentId: actor.agentId, runId: actor.runId,
      details: { siteId: site.id, orderId: input.data.orderId, amountMinor: input.data.amountMinor, confirmed: result.confirmed,
        requestId: result.request ? String(result.request.id) : null },
    });
    // 202: the card is open, but the site's answer was lost; deciding the card records the request first.
    res.status(result.confirmed ? 201 : 202).json({ approval: result.approval, request: result.request });
  });

  // Publish requests (GRE-4089): an agent asks; a person approves on the card and GSAM publishes in their name. This
  // route makes no write call, so direct publish stays people only (website_commerce_people_only).
  router.post(WEBSITE_DATA_BRIDGE_API_ROUTES.commercePublishRequests, async (req, res) => {
    const site = await siteFor(req, res, "website:commerce");
    if (!site) return;
    const input = websiteCommercePublishRequestSchema.safeParse(req.body);
    if (!input.success) {
      throw unprocessable(`The publish request is not valid: ${input.error.issues[0]?.path.join(".") || "body"}`, { code: "website_commerce_publish_request_invalid" });
    }
    if (input.data.issueId) {
      const [issue] = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, input.data.issueId), eq(issues.companyId, site.companyId))).limit(1);
      if (!issue) throw unprocessable("No such task in this company", { code: "website_commerce_publish_request_invalid" });
    }
    const actor = getActorInfo(req);
    const result = await publishRequests.request(site, input.data, {
      agentId: actor.actorType === "agent" ? actor.agentId ?? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      bridge: actorOf(req),
    });
    if (input.data.issueId) {
      await issueApprovals.linkManyForApproval(result.approval.id, [input.data.issueId], {
        agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }
    if (result.replayed) {
      res.status(200).json({ approval: result.approval });
      return;
    }
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.commerce_publish_requested",
      entityType: "approval", entityId: result.approval.id, agentId: actor.agentId, runId: actor.runId,
      details: { siteId: site.id, resource: input.data.resource, itemId: input.data.id, action: input.data.action,
        issueId: input.data.issueId ?? null },
    });
    res.status(201).json({ approval: result.approval });
  });

  // Licence activation steps (GRE-3982), per vendor. The text is customer-facing and must never hold a licence key:
  // the site refuses one (400 licence_key_in_text). Neither the text nor the site's answer goes to the activity log,
  // and the HTTP log leaves this route's body out (http-log-policy).
  router.put(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceActivationSteps, async (req, res) => {
    const site = await siteFor(req, res, "website:commerce");
    if (!site) return;
    const vendorId = req.params.vendorId as string;
    if (!UUID_RE.test(vendorId)) {
      res.status(404).json({ error: "The website has no such record.", code: "website_bridge_not_found" });
      return;
    }
    queryOf(NO_QUERY, req);
    const input = websiteVendorActivationStepsSchema.safeParse(req.body);
    if (!input.success) {
      throw unprocessable(`The activation steps are not valid: ${input.error.issues[0]?.path.join(".") || "body"}`,
        { code: "website_commerce_activation_steps_invalid" });
    }
    const result = await bridge.commerce.putActivationSteps(site, vendorId, input.data, actorOf(req), idempotencyKeyOf(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.commerce_changed",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { operation: "vendors.activation_steps", path: `vendors/${vendorId}/activation-steps`, rowId: result.item.vendorId,
        cleared: result.item.activationSteps === null, rowVersion: result.item.rowVersion },
    });
    res.json(result);
  });

  async function commerceWrite(req: Request, res: Response, method: WebsiteCommerceWriteMethod) {
    const site = await siteFor(req, res, "website:commerce");
    if (!site) return;
    const parts = (req.params as unknown as { path: string[] }).path ?? [];
    const operation = websiteCommerceWriteOperation(method, parts);
    if (!operation) {
      // only the typed operations go to the site; reads have their own routes
      res.status(404).json({ error: "No such commerce change.", code: "website_commerce_operation_unknown" });
      return;
    }
    if (operation.peopleOnly) personClickOrRefuse(req, operation.name);
    const body = writeBodyOf(req, method);
    const idempotencyKey = idempotencyKeyOf(req);
    const result = await bridge.commerce.write(site, method, parts.map(encodeURIComponent).join("/"), body, actorOf(req), idempotencyKey);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.commerce_changed",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { operation: operation.name, path: parts.join("/"), rowId: typeof result.item.id === "string" ? result.item.id : null },
    });
    res.status(method === "POST" && /\.(create|dry_run|convert)$/.test(operation.name) ? 201 : 200).json(result);
  }

  router.post(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceWrite, (req, res) => commerceWrite(req, res, "POST"));
  router.patch(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceWrite, (req, res) => commerceWrite(req, res, "PATCH"));
  router.delete(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceWrite, (req, res) => commerceWrite(req, res, "DELETE"));

  // ---- people and access (GRE-4085) ----
  // Reads: website:view, any actor. Changes: a signed-in person with website:publish, in their own name; an agent (or
  // a board API key) gets 403 website_access_people_only before any vault read or call to the site, and asks with
  // POST access/change-requests instead (John, 5 Nov: "a person approves every access change").

  function notFound(res: Response) {
    res.status(404).json({ error: "The website has no such record.", code: "website_bridge_not_found" });
  }

  router.get(WEBSITE_ACCESS_API_ROUTES.staff, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    queryOf(NO_QUERY, req);
    res.json(await websiteAccess.reads.staff(site, actorOf(req)));
  });

  router.get(WEBSITE_ACCESS_API_ROUTES.portalApprovers, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    queryOf(NO_QUERY, req);
    res.json(await websiteAccess.reads.portalApprovers(site, actorOf(req)));
  });

  router.get(WEBSITE_ACCESS_API_ROUTES.clientMembers, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const customerId = req.params.customerId as string;
    if (!UUID_RE.test(customerId)) return notFound(res);
    queryOf(NO_QUERY, req);
    res.json(await websiteAccess.reads.clientMembers(site, customerId, actorOf(req)));
  });

  function personOrRefuseAccess(req: Request) {
    const actor = req.actor;
    if (actor.type === "board" && actor.userId && (actor.source === "session" || actor.source === "local_implicit")) return actor.userId;
    throw new HttpError(403, "Only a person can change access, by clicking in GSAM. An agent asks with a card on its task "
      + "(website_access_request_change); a person with Publish rights approves it.", { code: "website_access_people_only" });
  }

  async function accessChange<B extends Record<string, unknown>>(req: Request, res: Response, bodySchema: z.ZodType<B>,
    build: (params: Record<string, string>, body: B) => unknown) {
    assertCompanyAccess(req, req.params.companyId as string);
    const userId = personOrRefuseAccess(req);
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const params = req.params as Record<string, string>;
    for (const key of ["staffId", "customerId", "membershipId"]) if (params[key] !== undefined && !UUID_RE.test(params[key]!)) return notFound(res);
    queryOf(NO_QUERY, req);
    const body = bodySchema.safeParse(req.body ?? {});
    const parsed = body.success ? websiteAccessChangeSchema.safeParse(build(params, body.data)) : body;
    if (!parsed.success) {
      throw unprocessable(`The access change is not valid: ${parsed.error.issues[0]?.path.join(".") || "body"}`, { code: "website_access_change_invalid" });
    }
    const change = parsed.data as WebsiteAccessChange;
    const result = await websiteAccess.change(site, change, { type: "user", id: userId }, idempotencyKeyOf(req)) as Record<string, unknown>;
    const actor = getActorInfo(req);
    const item = (result.item ?? null) as { membershipId?: unknown } | null;
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.access_changed",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { ...accessChangeLogDetails(change), ...(typeof item?.membershipId === "string" ? { membershipId: item.membershipId } : {}) },
    });
    res.json(result);
  }

  // Each body is checked strictly on its own, so a body cannot name another person than the path does.
  router.patch(WEBSITE_ACCESS_API_ROUTES.staffMember, (req, res) =>
    accessChange(req, res, websiteStaffRoleSchema, (p, body) => ({ ...body, kind: "staff_role", staffId: p.staffId })));
  router.put(WEBSITE_ACCESS_API_ROUTES.portalApprover, (req, res) =>
    accessChange(req, res, websitePortalApproverSchema, (p, body) => ({ ...body, kind: "approver_set", staffId: p.staffId })));
  router.delete(WEBSITE_ACCESS_API_ROUTES.portalApprover, (req, res) =>
    accessChange(req, res, NO_QUERY, (p) => ({ kind: "approver_remove", staffId: p.staffId })));
  router.post(WEBSITE_ACCESS_API_ROUTES.clientMembers, (req, res) =>
    accessChange(req, res, websiteClientMemberAddSchema, (p, body) => ({ ...body, kind: "member_add", customerId: p.customerId })));
  router.patch(WEBSITE_ACCESS_API_ROUTES.clientMember, (req, res) =>
    accessChange(req, res, websiteClientMemberRoleSchema, (p, body) =>
      ({ ...body, kind: "member_role", customerId: p.customerId, membershipId: p.membershipId })));
  router.delete(WEBSITE_ACCESS_API_ROUTES.clientMember, (req, res) =>
    accessChange(req, res, NO_QUERY, (p) => ({ kind: "member_remove", customerId: p.customerId, membershipId: p.membershipId })));

  // An ask (agents may): opens a website_access_change card and changes nothing.
  router.post(WEBSITE_ACCESS_API_ROUTES.changeRequests, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const input = websiteAccessChangeRequestSchema.safeParse(req.body);
    if (!input.success) {
      throw unprocessable(`The access change request is not valid: ${input.error.issues[0]?.path.join(".") || "body"}`, { code: "website_access_request_invalid" });
    }
    if (input.data.issueId) {
      const [issue] = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, input.data.issueId), eq(issues.companyId, site.companyId))).limit(1);
      if (!issue) throw unprocessable("No such task in this company", { code: "website_access_request_invalid" });
    }
    const actor = getActorInfo(req);
    const result = await websiteAccess.request(site, input.data, {
      agentId: actor.actorType === "agent" ? actor.agentId ?? actor.actorId : null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      bridge: actorOf(req),
    });
    if (input.data.issueId) {
      await issueApprovals.linkManyForApproval(result.approval.id, [input.data.issueId], {
        agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }
    if (result.replayed) {
      res.status(200).json({ approval: result.approval });
      return;
    }
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.access_change_requested",
      entityType: "approval", entityId: result.approval.id, agentId: actor.agentId, runId: actor.runId,
      details: { siteId: site.id, ...accessChangeLogDetails(input.data.change), issueId: input.data.issueId ?? null },
    });
    res.status(201).json({ approval: result.approval });
  });

  // ---- portal documents (GRE-4083, contract "Portal documents") ----
  // Drafting (website:edit; agents may): create, edit a draft, submit, return to draft. Approve and publish, and withdraw
  // (website:publish): an agent gets 403 website_publish_agent_refused and a board API key 403 website_portal_people_only,
  // before any vault read or call to the site. The site refuses again: approve and publish needs a registered portal
  // approver, withdraw a person. The activity log names the document, never its content.

  function portalPersonOrRefuse(req: Request, step: WebsitePortalDocumentStep) {
    const actor = req.actor;
    if (actor.type === "board" && actor.userId && (actor.source === "session" || actor.source === "local_implicit")) return;
    throw new HttpError(403, "Only a person can approve and publish or withdraw a portal document, by clicking in GSAM. An agent "
      + "submits the draft; a portal approver publishes it.", { code: "website_portal_people_only", operation: step });
  }

  async function portalDocumentWrite(req: Request, res: Response, step: "create" | "edit" | WebsitePortalDocumentStep,
    schema: z.ZodType<Record<string, unknown>>) {
    const people = step === "approve-and-publish" || step === "withdraw";
    const site = await siteFor(req, res, people ? "website:publish" : "website:edit");
    if (!site) return;
    if (people) portalPersonOrRefuse(req, step);
    const documentId = req.params.documentId as string | undefined;
    if (documentId !== undefined && !UUID_RE.test(documentId)) return notFound(res);
    queryOf(NO_QUERY, req);
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > WEBSITE_PORTAL_DOCUMENT_MAX_BODY_BYTES) {
      throw new HttpError(413, "The document is too large for the website (1 MB at most)", { code: "website_portal_document_too_large" });
    }
    const input = schema.safeParse(req.body ?? {});
    if (!input.success) {
      const issue = input.error.issues[0];
      throw unprocessable(`The portal document change is not valid: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        { code: "website_portal_document_invalid" });
    }
    const path = step === "create" ? "" : step === "edit" ? `/${documentId}` : `/${documentId}/${step}`;
    const result = await bridge.portalDocumentWrite(site, step === "edit" ? "PATCH" : "POST", path, input.data, actorOf(req),
      idempotencyKeyOf(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.portal_document_changed",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { operation: step, documentId: result.item.id, customerId: result.item.customer_id, kind: result.item.kind,
        version: result.item.version, status: result.item.status, rowVersion: result.item.row_version,
        approvalId: result.approvalId ?? null },
    });
    res.status(step === "create" ? 201 : 200).json(result);
  }

  router.post(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.create, (req, res) => portalDocumentWrite(req, res, "create", websitePortalDocumentCreateSchema));
  router.patch(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.edit, (req, res) => portalDocumentWrite(req, res, "edit", websitePortalDocumentEditSchema));
  router.post(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.submit, (req, res) => portalDocumentWrite(req, res, "submit", websitePortalDocumentStepSchema));
  router.post(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.returnToDraft, (req, res) =>
    portalDocumentWrite(req, res, "return-to-draft", websitePortalDocumentStepSchema));
  router.post(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.approveAndPublish, (req, res) =>
    portalDocumentWrite(req, res, "approve-and-publish", websitePortalDocumentApproveSchema));
  router.post(WEBSITE_PORTAL_DOCUMENT_API_ROUTES.withdraw, (req, res) => portalDocumentWrite(req, res, "withdraw", websitePortalDocumentStepSchema));

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceList, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const resource = commerceResourceOf(req);
    if (resource === "billing-lines") {
      const query = queryOf(websiteDataListQuerySchema, req);
      if (!query.customer) throw unprocessable("Billing lines require a customer", { code: "website_data_filters_invalid" });
      res.json(await bridge.commerce.list(site, resource, query, actorOf(req)));
      return;
    }
    res.json(await bridge.commerce.list(site, resource, queryOf(websiteCommerceListQuerySchema, req), actorOf(req)));
  });

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceItem, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const resource = commerceResourceOf(req);
    const itemId = req.params.itemId as string;
    if (!ITEM_ID_RE.test(itemId)) {
      res.status(404).json({ error: "The website has no such record.", code: "website_bridge_not_found" });
      return;
    }
    // Only an import job pages (its rows); every other item takes no query.
    const pageSchema: z.ZodType<{ cursor?: string; limit?: number }> = resource === "imports" ? websiteCommerceItemQuerySchema : NO_QUERY;
    res.json(await bridge.commerce.get(site, resource, itemId, queryOf(pageSchema, req), actorOf(req)));
  });

  return router;
}
