import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  WEBSITE_FEATURES_API_ROUTES,
  createWebsiteFeatureSchema,
  updateWebsiteFeatureSchema,
  type PermissionKey,
} from "@greatstone/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { toWebsiteFeature, websiteFeaturesService, type FeatureRow } from "../services/website/features.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type Permission = Extract<PermissionKey, "website:view" | "website:publish">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Website feature registry routes (GRE-2325). Same order of checks as the rest
// of the website: company access, then the permission, then a lookup by
// (company_id, id); anything outside the company or the caller's site scope
// answers 404. Reads need website:view; changing the registry needs
// website:publish, which agents never hold, so agents read it only.
export function websiteFeaturesRoutes(db: Db) {
  const router = Router();
  const sites = websiteModuleService(db);
  const features = websiteFeaturesService(db);
  const access = accessService(db);

  router.use(WEBSITE_FEATURES_API_ROUTES.features, requireEntitlement(db, "enableWebsiteView"));
  router.use(WEBSITE_FEATURES_API_ROUTES.featureCards, requireEntitlement(db, "enableWebsiteView"));

  async function allowed(req: Request, companyId: string, permission: Permission, siteId: string) {
    if (permission === "website:publish" && req.actor.type === "agent") {
      throw new HttpError(403, "Agents can read the feature registry; a person changes it.", { code: "website_feature_agent_refused", permission });
    }
    const decision = await access.decide({ actor: req.actor, action: permission, resource: { type: "company", companyId }, scope: { siteId } });
    if (decision.allowed) return true;
    if (decision.reason === "deny_scope") return false;
    throw new HttpError(403, WEBSITE_MESSAGES[permission === "website:view" ? "perm.view_none" : "perm.publish_none"], {
      code: "website_permission_missing",
      permission,
    });
  }

  async function siteFor(req: Request, res: Response, permission: Permission): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
    const idsValid = ["siteId", "featureId"].every((key) => req.params[key] === undefined || UUID_RE.test(req.params[key] as string));
    const site = (await allowed(req, companyId, permission, siteId)) && idsValid ? await sites.getSite(companyId, siteId) : null;
    if (!site) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return site;
  }

  async function featureFor(req: Request, res: Response, permission: Permission): Promise<{ site: SiteRow; row: FeatureRow } | null> {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const row = await features.getRow(site.companyId, site.id, req.params.featureId as string);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return { site, row };
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "website_feature",
      entityId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  router.get(WEBSITE_FEATURES_API_ROUTES.features, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json((await features.list(site.companyId, site.id)).map(toWebsiteFeature));
  });

  router.get(WEBSITE_FEATURES_API_ROUTES.featureCards, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await features.cards(site));
  });

  router.post(WEBSITE_FEATURES_API_ROUTES.features, validate(createWebsiteFeatureSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const row = await features.create(site, req.body);
    await log(req, site.companyId, "website.feature_created", row.id, { siteId: site.id, key: row.key, name: row.name });
    res.status(201).json(toWebsiteFeature(row));
  });

  router.get(WEBSITE_FEATURES_API_ROUTES.feature, async (req, res) => {
    const found = await featureFor(req, res, "website:view");
    if (!found) return;
    res.json(await features.detail(found.site, found.row));
  });

  router.patch(WEBSITE_FEATURES_API_ROUTES.feature, validate(updateWebsiteFeatureSchema), async (req, res) => {
    const found = await featureFor(req, res, "website:publish");
    if (!found) return;
    const row = await features.update(found.row, req.body);
    const action = req.body.enabled === undefined || req.body.enabled === found.row.enabled
      ? "website.feature_updated"
      : req.body.enabled ? "website.feature_switched_on" : "website.feature_switched_off";
    await log(req, found.site.companyId, action, row.id, { siteId: found.site.id, key: row.key, fields: Object.keys(req.body) });
    res.json(toWebsiteFeature(row));
  });

  router.delete(WEBSITE_FEATURES_API_ROUTES.feature, async (req, res) => {
    const found = await featureFor(req, res, "website:publish");
    if (!found) return;
    await features.archive(found.row);
    await log(req, found.site.companyId, "website.feature_removed", found.row.id, { siteId: found.site.id, key: found.row.key });
    res.status(204).end();
  });

  return router;
}
