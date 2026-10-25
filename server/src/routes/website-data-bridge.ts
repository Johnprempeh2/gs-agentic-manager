import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  WEBSITE_DATA_BRIDGE_API_ROUTES,
  WEBSITE_DATA_RESOURCES,
  createWebsiteDataBridgeKeySchema,
  websiteDataListQuerySchema,
  type PermissionKey,
  type WebsiteDataResource,
} from "@greatstone/shared";
import { HttpError, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { websiteDataBridgeService, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";
import type { WebsiteBridgeActor } from "../services/website/data-bridge-client.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

// Website data (GRE-2323): reads from the site's own database through the signed admin bridge. Same order of checks
// as the website module routes: company access, the website permission, then the site by (company_id, id) or 404.
export function websiteDataBridgeRoutes(db: Db, options: WebsiteDataBridgeOptions = {}) {
  const router = Router();
  const sites = websiteModuleService(db);
  const access = accessService(db);
  const bridge = websiteDataBridgeService(db, options);

  router.use("/companies/:companyId/website/sites/:siteId/data-bridge", requireEntitlement(db, "enableWebsiteView"));
  router.use("/companies/:companyId/website/sites/:siteId/data", requireEntitlement(db, "enableWebsiteView"));

  async function siteFor(req: Request, res: Response, permission: Extract<PermissionKey, "website:view" | "website:publish">): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
    // The read key is made by a person: an agent never holds website:publish.
    if (permission === "website:publish" && req.actor.type === "agent") {
      throw new HttpError(403, WEBSITE_MESSAGES["agent.publish_refused"], { code: "website_publish_agent_refused", permission });
    }
    const decision = await access.decide({ actor: req.actor, action: permission, resource: { type: "company", companyId }, scope: { siteId } });
    if (!decision.allowed && decision.reason !== "deny_scope") {
      throw new HttpError(403, WEBSITE_MESSAGES[permission === "website:view" ? "perm.view_none" : "perm.settings"], { code: "website_permission_missing", permission });
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
    const key = await bridge.createReadKey(site, req.body, actor.actorType === "user" ? actor.actorId : null);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.data_bridge_key_created",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { keyId: key.keyId, environment: req.body.environment, replaced: site.dataBridgeReadKeyId, url: req.body.url },
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

  return router;
}
