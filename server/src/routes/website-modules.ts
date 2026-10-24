import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  WEBSITE_MODULES_API_ROUTES,
  createWebsiteModuleSchema,
  updateWebsiteModuleSchema,
  type PermissionKey,
} from "@greatstone/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { toWebsiteModule, websiteModulesService, type ModuleRow } from "../services/website/modules.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type Permission = Extract<PermissionKey, "website:view" | "website:publish">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Website module registry routes (GRE-2325). Same order of checks as the rest
// of the website: company access, then the permission, then a lookup by
// (company_id, id); anything outside the company or the caller's site scope
// answers 404. Reads need website:view; changing the registry needs
// website:publish, which agents never hold, so agents read it only.
export function websiteModulesRoutes(db: Db) {
  const router = Router();
  const sites = websiteModuleService(db);
  const modules = websiteModulesService(db);
  const access = accessService(db);

  router.use(WEBSITE_MODULES_API_ROUTES.modules, requireEntitlement(db, "enableWebsiteView"));
  router.use(WEBSITE_MODULES_API_ROUTES.moduleCards, requireEntitlement(db, "enableWebsiteView"));

  async function allowed(req: Request, companyId: string, permission: Permission, siteId: string) {
    if (permission === "website:publish" && req.actor.type === "agent") {
      throw new HttpError(403, "Agents can read the module registry; a person changes it.", { code: "website_module_agent_refused", permission });
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
    const idsValid = ["siteId", "moduleId"].every((key) => req.params[key] === undefined || UUID_RE.test(req.params[key] as string));
    const site = (await allowed(req, companyId, permission, siteId)) && idsValid ? await sites.getSite(companyId, siteId) : null;
    if (!site) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    return site;
  }

  async function moduleFor(req: Request, res: Response, permission: Permission): Promise<{ site: SiteRow; row: ModuleRow } | null> {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const row = await modules.getRow(site.companyId, site.id, req.params.moduleId as string);
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
      entityType: "website_module",
      entityId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  router.get(WEBSITE_MODULES_API_ROUTES.modules, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json((await modules.list(site.companyId, site.id)).map(toWebsiteModule));
  });

  router.get(WEBSITE_MODULES_API_ROUTES.moduleCards, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await modules.cards(site));
  });

  router.post(WEBSITE_MODULES_API_ROUTES.modules, validate(createWebsiteModuleSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const row = await modules.create(site, req.body);
    await log(req, site.companyId, "website.module_created", row.id, { siteId: site.id, key: row.key, name: row.name });
    res.status(201).json(toWebsiteModule(row));
  });

  router.post(WEBSITE_MODULES_API_ROUTES.moduleSeed, async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const { added, modules: all } = await modules.addStartingSet(site);
    for (const row of added) {
      await log(req, site.companyId, "website.module_created", row.id, { siteId: site.id, key: row.key, name: row.name, startingSet: true });
    }
    res.status(added.length ? 201 : 200).json(all.map(toWebsiteModule));
  });

  router.get(WEBSITE_MODULES_API_ROUTES.module, async (req, res) => {
    const found = await moduleFor(req, res, "website:view");
    if (!found) return;
    res.json(await modules.detail(found.site, found.row));
  });

  router.patch(WEBSITE_MODULES_API_ROUTES.module, validate(updateWebsiteModuleSchema), async (req, res) => {
    const found = await moduleFor(req, res, "website:publish");
    if (!found) return;
    const row = await modules.update(found.row, req.body);
    const action = req.body.enabled === undefined || req.body.enabled === found.row.enabled
      ? "website.module_updated"
      : req.body.enabled ? "website.module_switched_on" : "website.module_switched_off";
    await log(req, found.site.companyId, action, row.id, { siteId: found.site.id, key: row.key, fields: Object.keys(req.body) });
    res.json(toWebsiteModule(row));
  });

  router.delete(WEBSITE_MODULES_API_ROUTES.module, async (req, res) => {
    const found = await moduleFor(req, res, "website:publish");
    if (!found) return;
    await modules.archive(found.row);
    await log(req, found.site.companyId, "website.module_removed", found.row.id, { siteId: found.site.id, key: found.row.key });
    res.status(204).end();
  });

  return router;
}
