import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { websiteProperties } from "@greatstone/db";
import {
  WEBSITE_MODULE_API_ROUTES,
  createWebsiteEntrySchema,
  createWebsitePageSchema,
  createWebsiteSiteSchema,
  checkWebsiteEditorOrigin,
  parseWebsiteEditorOrigin,
  restoreWebsiteRevisionSchema,
  saveWebsiteContentSchema,
  updateWebsiteEntrySchema,
  updateWebsitePageSchema,
  updateWebsiteSiteSchema,
  type PermissionKey,
  type WebsiteSaveResult,
} from "@greatstone/shared";
import { HttpError, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import {
  toWebsiteEntry,
  toWebsitePage,
  toWebsiteSite,
  websiteModuleService,
  type PageRow,
  type SiteRow,
  type WebsiteActor,
} from "../services/website/module.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type WebsitePermission = Extract<PermissionKey, "website:view" | "website:edit" | "website:publish">;

const NOT_FOUND = "Not found";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebsiteModuleRouteOptions {
  /** Origins GSAM is served from (public URL, allowed hostnames). The editor frame may never be one of them (rule C1.1). */
  gsamOrigins?: readonly string[];
  /** Allow an `http://localhost` editor frame origin (development and sandboxes only). */
  allowLocalhostEditor?: boolean;
}

/** Every origin GSAM may be served from: its public URL, and each allowed hostname over https and http. */
export function gsamServedOrigins(publicBaseUrl: string | undefined, allowedHostnames: readonly string[]): string[] {
  const origins = new Set<string>();
  if (publicBaseUrl) {
    try {
      origins.add(new URL(publicBaseUrl).origin);
    } catch {
      // An unparsable public URL serves nothing.
    }
  }
  for (const hostname of allowedHostnames) {
    const host = hostname.trim();
    if (!host) continue;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return [...origins];
}

const EDITOR_ORIGIN_PROBLEMS = {
  invalid: "The editor address must be an https:// origin with no path, like https://editor.example.com.",
  "public-origin": "The editor address must be its own host, not the public site's address.",
  "gsam-origin": "The editor address cannot be an address GSAM is served from.",
} as const;

// Website module routes (GRE-2105, ADR GRE-1914 section 6). Order of checks on
// every route: company access, then the website permission, then a lookup by
// (company_id, id). A site, page or entry that is not in this company, or a
// site outside the caller's scoped grant, answers 404, never 403, so ids
// cannot be probed.
export function websiteModuleRoutes(db: Db, options: WebsiteModuleRouteOptions = {}) {
  const router = Router();
  const service = websiteModuleService(db);
  const access = accessService(db);

  router.use(WEBSITE_MODULE_API_ROUTES.sites, requireEntitlement(db, "enableWebsiteView"));

  function actorOf(req: Request): WebsiteActor {
    const info = getActorInfo(req);
    return info.actorType === "agent" ? { agentId: info.agentId, userId: null } : { agentId: null, userId: info.actorId };
  }

  /** Throws 403 when the caller has no such permission at all; returns false when only the site scope excludes it. */
  async function allowed(req: Request, companyId: string, permission: WebsitePermission, siteId?: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: permission,
      resource: { type: "company", companyId },
      scope: siteId ? { siteId } : null,
    });
    if (decision.allowed) return true;
    if (decision.reason === "deny_scope" && siteId) return false;
    throw new HttpError(403, decision.explanation, { code: "website_permission_missing", permission });
  }

  /** Company access, permission, then the site by (company_id, id) or 404. */
  async function siteFor(req: Request, res: Response, permission: WebsitePermission): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
    // A malformed id is simply not found (never a database error).
    const idsValid = ["siteId", "pageId", "entryId", "optionId", "revisionId"].every((key) => req.params[key] === undefined || UUID_RE.test(req.params[key] as string));
    const permitted = (await allowed(req, companyId, permission, siteId)) && idsValid;
    const site = permitted ? await service.getSite(companyId, siteId) : null;
    if (!site) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return site;
  }

  async function log(req: Request, companyId: string, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType,
      entityId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  async function assertPropertyInCompany(companyId: string, propertyId: string | null | undefined) {
    if (!propertyId) return;
    const [row] = await db
      .select({ id: websiteProperties.id })
      .from(websiteProperties)
      .where(and(eq(websiteProperties.id, propertyId), eq(websiteProperties.companyId, companyId)));
    if (!row) throw unprocessable("That website property is not in this company", { code: "website_property_not_found" });
  }

  /** Rule C1.1, on every save of the setting and again when the editor opens. */
  function editorOriginProblem(req: Request, site: Pick<SiteRow, "domain">, editorFrameOrigin: string) {
    const host = req.get("host");
    const requestOrigin = host ? `${req.protocol}://${host}` : null;
    return checkWebsiteEditorOrigin(editorFrameOrigin, {
      publicOrigin: `https://${site.domain}`,
      gsamOrigins: [...(options.gsamOrigins ?? []), ...(requestOrigin ? [requestOrigin] : [])],
      allowLocalhost: options.allowLocalhostEditor,
    });
  }

  /** The stored form of a new editor frame origin, or a 422. */
  function normaliseEditorFrameOrigin(req: Request, domain: string, value: string | null | undefined) {
    if (value === undefined || value === null) return value;
    const problem = editorOriginProblem(req, { domain }, value);
    if (problem) throw unprocessable(EDITOR_ORIGIN_PROBLEMS[problem], { code: "website_editor_origin_refused", problem });
    return parseWebsiteEditorOrigin(value, { allowLocalhost: options.allowLocalhostEditor });
  }

  function sendSave(res: Response, result: WebsiteSaveResult) {
    const status = result.state === "saved" ? 200 : result.state === "conflict" ? 409 : 422;
    res.status(status).json(result);
  }

  // ---- sites ----

  router.get(WEBSITE_MODULE_API_ROUTES.sites, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await service.listSites(companyId);
    const visible = [];
    for (const row of rows) {
      if (await allowed(req, companyId, "website:view", row.id)) visible.push(toWebsiteSite(row));
    }
    res.json(visible);
  });

  router.post(WEBSITE_MODULE_API_ROUTES.sites, validate(createWebsiteSiteSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await allowed(req, companyId, "website:publish");
    await assertPropertyInCompany(companyId, req.body.propertyId);
    const editorFrameOrigin = normaliseEditorFrameOrigin(req, req.body.domain, req.body.editorFrameOrigin);
    const row = await service.createSite(companyId, { ...req.body, editorFrameOrigin }, actorOf(req));
    await log(req, companyId, "website.site_connected", "website_site", row.id, {
      domain: row.domain,
      netlifyToken: Boolean(row.netlifyTokenSecretId),
      editorFrameOrigin: row.editorFrameOrigin,
    });
    res.status(201).json(toWebsiteSite(row));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.site, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(toWebsiteSite(site));
  });

  router.patch(WEBSITE_MODULE_API_ROUTES.site, validate(updateWebsiteSiteSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    await assertPropertyInCompany(site.companyId, req.body.propertyId);
    const input = { ...req.body };
    if (input.editorFrameOrigin !== undefined) {
      input.editorFrameOrigin = normaliseEditorFrameOrigin(req, input.domain ?? site.domain, input.editorFrameOrigin);
    } else if (input.domain !== undefined && site.editorFrameOrigin && editorOriginProblem(req, { domain: input.domain }, site.editorFrameOrigin)) {
      throw unprocessable(EDITOR_ORIGIN_PROBLEMS["public-origin"], { code: "website_editor_origin_refused", problem: "public-origin" });
    }
    const row = await service.updateSite(site, input, actorOf(req));
    const fields = Object.keys(req.body).map((key) => (key === "netlifyToken" ? "netlifyToken (rotated)" : key));
    await log(req, site.companyId, "website.site_updated", "website_site", site.id, { fields });
    // Rule C2.2 and C2.3: old and new value in the log; the live event tells open editors to close.
    if (row.editorFrameOrigin !== site.editorFrameOrigin) {
      await log(req, site.companyId, "website.site_editor_origin_changed", "website_site", site.id, {
        from: site.editorFrameOrigin,
        to: row.editorFrameOrigin,
      });
    }
    res.json(toWebsiteSite(row));
  });

  // ---- pages ----

  router.get(WEBSITE_MODULE_API_ROUTES.pages, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await service.listPages(site.companyId, site.id, req.query.includeArchived === "true"));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pages, validate(createWebsitePageSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:edit");
    if (!site) return;
    const page = await service.createPage(site.companyId, site.id, req.body, actorOf(req));
    await log(req, site.companyId, "website.page_created", "website_page", page.id, { siteId: site.id, slug: page.slug });
    res.status(201).json(page);
  });

  async function sitePageFor(req: Request, res: Response, permission: WebsitePermission): Promise<{ site: SiteRow; page: PageRow } | null> {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const page = await service.getPageRow(site.companyId, site.id, req.params.pageId as string);
    if (!page) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return { site, page };
  }

  async function pageFor(req: Request, res: Response, permission: WebsitePermission) {
    return (await sitePageFor(req, res, permission))?.page ?? null;
  }

  router.get(WEBSITE_MODULE_API_ROUTES.page, async (req, res) => {
    const page = await pageFor(req, res, "website:view");
    if (!page) return;
    const detail = await service.pageDetail(page);
    if (!detail) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(detail);
  });

  router.patch(WEBSITE_MODULE_API_ROUTES.page, validate(updateWebsitePageSchema), async (req, res) => {
    const page = await pageFor(req, res, "website:edit");
    if (!page) return;
    const updated = await service.updatePage(page, req.body);
    await log(req, page.companyId, "website.page_updated", "website_page", page.id, { siteId: page.siteId, fields: Object.keys(req.body) });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsitePage(updated, doc));
  });

  router.put(WEBSITE_MODULE_API_ROUTES.pageContent, validate(saveWebsiteContentSchema), async (req, res) => {
    const found = await sitePageFor(req, res, "website:edit");
    if (!found) return;
    const { site, page } = found;
    if (page.archivedAt) {
      sendSave(res, { state: "failed", code: "archived", message: "This page is archived. Restore it before editing." });
      return;
    }
    // Rule C2.4: a save from an editor session opened on an older editor address never lands.
    if (req.body.editorOrigin !== undefined && req.body.editorOrigin !== site.editorFrameOrigin) {
      sendSave(res, {
        state: "failed",
        code: "origin-changed",
        message: "The editor address for this site changed. Reload to continue.",
      });
      return;
    }
    const result = await service.store.saveRevision({
      companyId: page.companyId,
      documentId: page.documentId,
      content: req.body.content,
      baseRevisionId: req.body.baseRevisionId,
      changeSummary: req.body.changeSummary,
      actor: actorOf(req),
    });
    if (result.state === "saved") {
      await log(req, page.companyId, "website.page_saved", "website_page", page.id, { siteId: page.siteId, revisionNumber: result.revisionNumber });
    }
    sendSave(res, result);
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pageArchive, async (req, res) => {
    const page = await pageFor(req, res, "website:edit");
    if (!page) return;
    const updated = await service.archivePage(page);
    await log(req, page.companyId, "website.page_archived", "website_page", page.id, { siteId: page.siteId, slug: page.slug });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsitePage(updated, doc));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.pageRevisions, async (req, res) => {
    const page = await pageFor(req, res, "website:view");
    if (!page) return;
    res.json(await service.store.listRevisions(page.companyId, page.documentId));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.pageRevision, async (req, res) => {
    const page = await pageFor(req, res, "website:view");
    if (!page) return;
    const found = await service.pageRevision(page, req.params.revisionId as string);
    if (!found) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    let content: unknown = null;
    try {
      content = JSON.parse(found.body);
    } catch {
      content = null;
    }
    res.json({ revision: found.revision, content });
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pageRevisionRestore, validate(restoreWebsiteRevisionSchema), async (req, res) => {
    const page = await pageFor(req, res, "website:edit");
    if (!page) return;
    if (page.archivedAt) {
      sendSave(res, { state: "failed", code: "archived", message: "This page is archived. Restore it before editing." });
      return;
    }
    const revisionId = req.params.revisionId as string;
    const result = await service.restorePageRevision(page, revisionId, req.body.baseRevisionId, actorOf(req));
    if (!result) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    if (result.state === "saved") {
      await log(req, page.companyId, "website.page_restored", "website_page", page.id, {
        siteId: page.siteId,
        restoredRevisionId: revisionId,
        revisionNumber: result.revisionNumber,
      });
    }
    sendSave(res, result);
  });

  router.get(WEBSITE_MODULE_API_ROUTES.pageEditor, async (req, res) => {
    // website:view is enough to load the draft (preview); every save checks website:edit again.
    const found = await sitePageFor(req, res, "website:view");
    if (!found) return;
    const { site, page } = found;
    // No editor without a frame origin that passes rule C1.1 now.
    if (!site.editorFrameOrigin) {
      throw unprocessable("Set the editor address for this site before editing pages.", { code: "website_editor_origin_missing" });
    }
    const problem = editorOriginProblem(req, site, site.editorFrameOrigin);
    if (problem) throw unprocessable(EDITOR_ORIGIN_PROBLEMS[problem], { code: "website_editor_origin_refused", problem });
    const load = await service.editorLoad(site, page, site.editorFrameOrigin);
    if (!load) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(load);
  });

  router.get(WEBSITE_MODULE_API_ROUTES.media, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await service.listMedia(site.companyId, site.id));
  });

  // ---- entries ----

  router.get(WEBSITE_MODULE_API_ROUTES.entries, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const collection = typeof req.query.collection === "string" ? req.query.collection : undefined;
    res.json(await service.listEntries(site.companyId, site.id, collection, req.query.includeArchived === "true"));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entries, validate(createWebsiteEntrySchema), async (req, res) => {
    const site = await siteFor(req, res, "website:edit");
    if (!site) return;
    const entry = await service.createEntry(site.companyId, site.id, req.body, actorOf(req));
    await log(req, site.companyId, "website.entry_created", "website_entry", entry.id, { siteId: site.id, collection: entry.collection });
    res.status(201).json(entry);
  });

  async function entryFor(req: Request, res: Response, permission: WebsitePermission) {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const entry = await service.getEntryRow(site.companyId, site.id, req.params.entryId as string);
    if (!entry) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return entry;
  }

  router.get(WEBSITE_MODULE_API_ROUTES.entry, async (req, res) => {
    const entry = await entryFor(req, res, "website:view");
    if (!entry) return;
    const detail = await service.entryDetail(entry);
    if (!detail) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(detail);
  });

  router.patch(WEBSITE_MODULE_API_ROUTES.entry, validate(updateWebsiteEntrySchema), async (req, res) => {
    const entry = await entryFor(req, res, "website:edit");
    if (!entry) return;
    const updated = await service.updateEntry(entry, req.body);
    await log(req, entry.companyId, "website.entry_updated", "website_entry", entry.id, { siteId: entry.siteId, fields: Object.keys(req.body) });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsiteEntry(updated, doc));
  });

  router.put(WEBSITE_MODULE_API_ROUTES.entryContent, validate(saveWebsiteContentSchema), async (req, res) => {
    const entry = await entryFor(req, res, "website:edit");
    if (!entry) return;
    if (entry.archivedAt) {
      sendSave(res, { state: "failed", code: "archived", message: "This entry is archived. Restore it before editing." });
      return;
    }
    const result = await service.store.saveRevision({
      companyId: entry.companyId,
      documentId: entry.documentId,
      content: req.body.content,
      baseRevisionId: req.body.baseRevisionId,
      changeSummary: req.body.changeSummary,
      actor: actorOf(req),
    });
    if (result.state === "saved") {
      await log(req, entry.companyId, "website.entry_saved", "website_entry", entry.id, { siteId: entry.siteId, revisionNumber: result.revisionNumber });
    }
    sendSave(res, result);
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entryArchive, async (req, res) => {
    const entry = await entryFor(req, res, "website:edit");
    if (!entry) return;
    const updated = await service.archiveEntry(entry);
    await log(req, entry.companyId, "website.entry_archived", "website_entry", entry.id, { siteId: entry.siteId });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsiteEntry(updated, doc));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.entryRevisions, async (req, res) => {
    const entry = await entryFor(req, res, "website:view");
    if (!entry) return;
    res.json(await service.store.listRevisions(entry.companyId, entry.documentId));
  });

  return router;
}
