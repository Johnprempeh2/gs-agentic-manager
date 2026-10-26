import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import {
  WEBSITE_COMMERCE_RESOURCES,
  WEBSITE_DATA_BRIDGE_API_ROUTES,
  WEBSITE_DATA_RESOURCES,
  createWebsiteDataBridgeKeySchema,
  websiteCommerceItemQuerySchema,
  websiteCommerceListQuerySchema,
  websiteDataListQuerySchema,
  websiteCommerceRefundRequestSchema,
  websiteCommerceWriteOperation,
  websitePaymentReportQuerySchema,
  type PermissionKey,
  type WebsiteCommerceWriteMethod,
  type WebsiteCommerceResource,
  type WebsiteDataResource,
} from "@greatstone/shared";
import { HttpError, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { websiteDataBridgeService, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";
import { commerceRefundApprovals } from "../services/website/commerce-refund-approval.js";
import { websiteActivityService } from "../services/website/activity.js";
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
  const activity = websiteActivityService(db, { read: async () => { throw new Error("Activity reads cannot pull the website"); } });

  router.use("/companies/:companyId/website/sites/:siteId/data-bridge", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/data", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/commerce", requireEntitlement(db, "enableWebsiteView"));
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
    let cursor: { occurredAt: Date; siteId: string; sequence: bigint } | undefined;
    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string" || req.query.cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(req.query.cursor)) {
        throw unprocessable("Invalid activity cursor");
      }
      try {
        const parts: unknown = JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8"));
        if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" ||
          typeof parts[1] !== "string" || typeof parts[2] !== "string" || !UUID_RE.test(parts[1]) ||
          !/^[1-9]\d*$/.test(parts[2])) throw new Error("invalid");
        const occurredAt = new Date(parts[0]);
        if (Number.isNaN(occurredAt.valueOf()) || occurredAt.toISOString() !== parts[0]) throw new Error("invalid");
        cursor = { occurredAt, siteId: parts[1], sequence: BigInt(parts[2]) };
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
    permission: Extract<PermissionKey, "website:view" | "website:publish" | "website:commerce">): Promise<SiteRow | null> {
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
        : WEBSITE_MESSAGES[permission === "website:view" ? "perm.view_none" : "perm.settings"], { code: "website_permission_missing", permission });
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

  router.get(WEBSITE_DATA_BRIDGE_API_ROUTES.commerceList, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const resource = commerceResourceOf(req);
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
