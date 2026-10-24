import { Router, type Request, type Response } from "express";
import { Ajv2020 } from "ajv/dist/2020.js";
import publicImport from "../services/website/public-import-v1.json" with { type: "json" };
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { websiteProperties } from "@greatstone/db";
import {
  WEBSITE_MODULE_API_ROUTES,
  websiteCollectionDefinition,
  websiteCollectionFieldSchema,
  WEBSITE_SITEMAP_API_ROUTES,
  createWebsiteSitemapOptionSchema,
  importWebsiteSitemapOptionSchema,
  sitemapTreeFromImport,
  updateWebsiteSitemapOptionSchema,
  websiteSitemapTreeSchema,
  createWebsiteEntrySchema,
  createWebsitePageSchema,
  createWebsiteSiteSchema,
  saveWebsiteContentSchema,
  sendBackWebsiteContentSchema,
  updateWebsiteEntrySchema,
  updateWebsitePageSchema,
  updateWebsiteSiteSchema,
  websiteReleaseActionSchema,
  type PermissionKey,
  type WebsiteSaveResult,
} from "@greatstone/shared";
import { HttpError, conflict, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import {
  toWebsiteEntry,
  toWebsitePage,
  toWebsiteSite,
  websiteModuleService,
  type SiteRow,
  type WebsiteActor,
} from "../services/website/module.js";
import {
  toWebsiteRelease,
  websitePublishService,
  type WebsitePerson,
  type WebsitePublishOptions,
} from "../services/website/publish.js";
import { WEBSITE_MESSAGES, type WebsiteMessageKey } from "../services/website/messages.js";
import { websitePublishApprovals } from "../services/website/publish-approval.js";
import { toWebsiteSitemapOption, websiteSitemapService } from "../services/website/sitemap.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type WebsitePermission = Extract<PermissionKey, "website:view" | "website:edit" | "website:publish">;

const NOT_FOUND = "Not found";

/** What the caller is refused, in the copy's words (GRE-2107 section 13). */
const REFUSAL: Record<WebsitePermission, WebsiteMessageKey> = {
  "website:view": "perm.view_none",
  "website:edit": "perm.edit_none",
  "website:publish": "perm.publish_none",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Website module routes (GRE-2105, ADR GRE-1914 section 6). Order of checks on
// every route: company access, then the website permission, then a lookup by
// (company_id, id). A site, page or entry that is not in this company, or a
// site outside the caller's scoped grant, answers 404, never 403, so ids
// cannot be probed.
export function websiteModuleRoutes(db: Db, options: { publish?: WebsitePublishOptions } = {}) {
  const router = Router();
  const service = websiteModuleService(db);
  const publish = websitePublishService(db, options.publish);
  const sitemap = websiteSitemapService(db);
  const access = accessService(db);
  const collectionValidator = new Ajv2020({ allErrors: true });
  const fieldValidators = new Map<string, ReturnType<typeof collectionValidator.compile>>();

  function assertCollectionFields(collection: string, content: unknown) {
    const definition = websiteCollectionDefinition(collection);
    if (!definition) throw unprocessable("This collection is not in the site's release schema", { code: "website_collection_unknown" });
    let check = fieldValidators.get(collection);
    if (!check) {
      check = collectionValidator.compile({ $defs: websiteCollectionFieldSchema.$defs, $ref: definition.ref });
      fieldValidators.set(collection, check);
    }
    if (!check(content)) {
      const first = check.errors?.[0];
      throw unprocessable(`The entry fields are incomplete: ${first?.instancePath || "fields"} ${first?.message || "is invalid"}`, { code: "website_collection_fields_invalid" });
    }
  }
  const publishApprovals = websitePublishApprovals(db);

  router.use(WEBSITE_MODULE_API_ROUTES.sites, requireEntitlement(db, "enableWebsiteView"));
  router.use(WEBSITE_MODULE_API_ROUTES.tokenSecrets, requireEntitlement(db, "enableWebsiteView"));

  function actorOf(req: Request): WebsiteActor {
    const info = getActorInfo(req);
    return info.actorType === "agent" ? { agentId: info.agentId, userId: null } : { agentId: null, userId: info.actorId };
  }

  /**
   * Throws 403 when the caller has no such permission at all; returns false when only the site scope excludes it.
   * `refusal` names the message for this route when the generic one does not fit (people and agents).
   */
  async function allowed(
    req: Request,
    companyId: string,
    permission: WebsitePermission,
    siteId?: string,
    refusal?: { person?: WebsiteMessageKey; agent?: WebsiteMessageKey },
  ) {
    // Agents never hold website:publish (ADR section 6): say so, and say what they can do instead.
    if (permission === "website:publish" && req.actor.type === "agent") {
      throw new HttpError(403, WEBSITE_MESSAGES[refusal?.agent ?? "agent.publish_refused"], { code: "website_publish_agent_refused", permission });
    }
    const decision = await access.decide({
      actor: req.actor,
      action: permission,
      resource: { type: "company", companyId },
      scope: siteId ? { siteId } : null,
    });
    if (decision.allowed) return true;
    if (decision.reason === "deny_scope" && siteId) return false;
    throw new HttpError(403, WEBSITE_MESSAGES[refusal?.person ?? REFUSAL[permission]], { code: "website_permission_missing", permission });
  }

  /** Company access, permission, then the site by (company_id, id) or 404. */
  async function siteFor(
    req: Request,
    res: Response,
    permission: WebsitePermission,
    refusal?: { person?: WebsiteMessageKey; agent?: WebsiteMessageKey },
  ): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
    // A malformed id is simply not found (never a database error).
    const idsValid = ["siteId", "pageId", "entryId", "optionId", "releaseId"].every((key) => req.params[key] === undefined || UUID_RE.test(req.params[key] as string));
    const permitted = (await allowed(req, companyId, permission, siteId, refusal)) && idsValid;
    const site = permitted ? await service.getSite(companyId, siteId) : null;
    if (!site) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return site;
  }

  /** Writes to pages and entries need a connected site: a disconnected (archived) site answers 409. */
  async function writableSiteFor(req: Request, res: Response, refusal?: { person?: WebsiteMessageKey; agent?: WebsiteMessageKey }): Promise<SiteRow | null> {
    const site = await siteFor(req, res, "website:edit", refusal);
    if (site?.archivedAt) {
      throw conflict("This site is disconnected. Connect it again before you edit or Publish.", { code: "website_site_disconnected" });
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

  function sendSave(res: Response, result: WebsiteSaveResult) {
    const status = result.state === "saved" ? 200 : result.state === "conflict" ? 409 : 422;
    res.status(status).json(result);
  }

  // ---- sites ----

  /** The site as the API returns it: the token secret's name, never its value. */
  async function siteView(row: SiteRow) {
    return toWebsiteSite(row, await service.tokenSecretName(row));
  }

  router.get(WEBSITE_MODULE_API_ROUTES.sites, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await service.listSites(companyId);
    const visible = [];
    for (const row of rows) {
      if (await allowed(req, companyId, "website:view", row.id)) visible.push(await siteView(row));
    }
    res.json(visible);
  });

  // Saved secrets a person with Publish rights can choose as a site's Netlify token: names only.
  router.get(WEBSITE_MODULE_API_ROUTES.tokenSecrets, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await allowed(req, companyId, "website:publish", undefined, { person: "perm.settings" });
    res.json(await service.listTokenSecrets(companyId));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.sites, validate(createWebsiteSiteSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await allowed(req, companyId, "website:publish", undefined, { person: "perm.settings" });
    await assertPropertyInCompany(companyId, req.body.propertyId);
    const row = await service.createSite(companyId, req.body, actorOf(req));
    await log(req, companyId, "website.site_connected", "website_site", row.id, {
      domain: row.domain,
      netlifyToken: Boolean(row.netlifyTokenSecretId),
      netlifyTokenSource: row.netlifyTokenSecretId ? (row.netlifyTokenSecretOwned ? "own" : "shared") : null,
    });
    res.status(201).json(await siteView(row));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.site, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await siteView(site));
  });

  router.patch(WEBSITE_MODULE_API_ROUTES.site, validate(updateWebsiteSiteSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish", { person: "perm.settings" });
    if (!site) return;
    await assertPropertyInCompany(site.companyId, req.body.propertyId);
    const row = await service.updateSite(site, req.body, actorOf(req));
    const fields = Object.keys(req.body).map((key) => {
      if (key === "netlifyToken") return site.netlifyTokenSecretId && site.netlifyTokenSecretOwned ? "netlifyToken (rotated)" : "netlifyToken (new site secret)";
      if (key === "netlifyTokenSecretId") return req.body.netlifyTokenSecretId ? "netlifyTokenSecretId (shared secret linked)" : "netlifyTokenSecretId (unlinked)";
      return key;
    });
    await log(req, site.companyId, "website.site_updated", "website_site", site.id, { fields });
    res.json(await siteView(row));
  });

  // ---- pages ----

  router.get(WEBSITE_MODULE_API_ROUTES.pages, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await service.listPages(site.companyId, site.id, req.query.includeArchived === "true"));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pages, validate(createWebsitePageSchema), async (req, res) => {
    const site = await writableSiteFor(req, res);
    if (!site) return;
    const page = await service.createPage(site.companyId, site.id, req.body, actorOf(req));
    await log(req, site.companyId, "website.page_created", "website_page", page.id, { siteId: site.id, slug: page.slug });
    res.status(201).json(page);
  });

  async function pageFor(req: Request, res: Response, permission: WebsitePermission, refusal?: { agent?: WebsiteMessageKey }) {
    const site = permission === "website:edit" ? await writableSiteFor(req, res, refusal) : await siteFor(req, res, permission, refusal);
    if (!site) return null;
    const page = await service.getPageRow(site.companyId, site.id, req.params.pageId as string);
    if (!page) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return page;
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
    const page = await pageFor(req, res, "website:edit");
    if (!page) return;
    if (page.archivedAt) {
      sendSave(res, { state: "failed", message: "This page is archived. Restore it before editing." });
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

  // ---- review: submit (edit), approve and send back (people with Publish rights) ----

  const APPROVER = { agent: "agent.approve_refused" } as const;

  router.post(WEBSITE_MODULE_API_ROUTES.pageSubmit, async (req, res) => {
    const page = await pageFor(req, res, "website:edit");
    if (!page) return;
    const updated = await service.submitPage(page);
    await log(req, page.companyId, "website.page_submitted", "website_page", page.id, { siteId: page.siteId, title: page.title });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsitePage(updated, doc));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pageApprove, async (req, res) => {
    const page = await pageFor(req, res, "website:publish", APPROVER);
    if (!page) return;
    const updated = await service.approvePage(page);
    await log(req, page.companyId, "website.page_approved", "website_page", page.id, { siteId: page.siteId, revisionId: updated.approvedRevisionId });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsitePage(updated, doc));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.pageSendBack, validate(sendBackWebsiteContentSchema), async (req, res) => {
    const page = await pageFor(req, res, "website:publish", APPROVER);
    if (!page) return;
    const updated = await service.sendBackPage(page);
    await log(req, page.companyId, "website.page_sent_back", "website_page", page.id, { siteId: page.siteId, note: req.body.note });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsitePage(updated, doc));
  });

  // ---- entries ----

  router.get(WEBSITE_MODULE_API_ROUTES.entries, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    const collection = typeof req.query.collection === "string" ? req.query.collection : undefined;
    res.json(await service.listEntries(site.companyId, site.id, collection, req.query.includeArchived === "true"));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entryImport, async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const rows = [
      ...publicImport.vendors.map((item) => ({ collection: "vendor", entryKey: item.id, content: { data: item } })),
      ...publicImport.categories.map((item) => ({ collection: "category", entryKey: item.id, content: { data: item } })),
      ...publicImport.products.map((item) => ({ collection: "product", entryKey: item.id, content: { data: item } })),
      ...publicImport.people.map((item, index) => ({ collection: "public-person", entryKey: `public-person-${index + 1}`, content: item })),
      ...publicImport.forms.map((item) => ({ collection: "form", entryKey: item.key, content: item })),
    ];
    const existing = new Set((await service.listEntries(site.companyId, site.id, undefined, true)).map((item) => `${item.collection}:${item.entryKey}`));
    let imported = 0;
    for (const row of rows) {
      if (existing.has(`${row.collection}:${row.entryKey}`)) continue;
      assertCollectionFields(row.collection, row.content);
      await service.createEntry(site.companyId, site.id, row, actorOf(req));
      imported++;
    }
    await log(req, site.companyId, "website.public_drafts_imported", "website_site", site.id, { imported, skipped: rows.length - imported, capturedAt: publicImport.capturedAt });
    res.json({ imported, skipped: rows.length - imported, capturedAt: publicImport.capturedAt });
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entries, validate(createWebsiteEntrySchema), async (req, res) => {
    const site = await writableSiteFor(req, res);
    if (!site) return;
    assertCollectionFields(req.body.collection, req.body.content);
    const entry = await service.createEntry(site.companyId, site.id, req.body, actorOf(req));
    await log(req, site.companyId, "website.entry_created", "website_entry", entry.id, { siteId: site.id, collection: entry.collection });
    res.status(201).json(entry);
  });

  async function entryFor(req: Request, res: Response, permission: WebsitePermission, refusal?: { agent?: WebsiteMessageKey }) {
    const site = permission === "website:edit" ? await writableSiteFor(req, res, refusal) : await siteFor(req, res, permission, refusal);
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
      sendSave(res, { state: "failed", message: "This entry is archived. Restore it before editing." });
      return;
    }
    assertCollectionFields(entry.collection, req.body.content);
    const result = await service.saveEntryRevision(entry, {
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

  router.get(WEBSITE_MODULE_API_ROUTES.entryRevision, async (req, res) => {
    const entry = await entryFor(req, res, "website:view");
    if (!entry) return;
    const revisionId = req.params.revisionId as string;
    const revision = UUID_RE.test(revisionId) ? await service.store.readRevision(entry.companyId, entry.documentId, revisionId) : null;
    if (!revision) { res.status(404).json({ error: NOT_FOUND }); return; }
    res.json(revision);
  });

  // ---- releases: Publish, Retry, Rollback (GRE-2108) ----

  /**
   * Publish, Retry and Rollback are a signed-in person's click in GSAM only
   * (John, GRE-2053). Agents never hold website:publish, so they stop at the
   * permission check; a board API key is a script, not a click, so it is
   * refused here too.
   */
  function personClick(req: Request): WebsitePerson {
    const actor = req.actor;
    if (actor.type === "board" && actor.userId && (actor.source === "session" || actor.source === "local_implicit")) {
      return { userId: actor.userId };
    }
    throw new HttpError(403, "Only a person can publish, retry or roll back a website, by clicking in GSAM.", {
      code: "website_publish_person_only",
    });
  }

  async function releaseFor(req: Request, res: Response, permission: WebsitePermission) {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const release = await publish.getRelease(site.companyId, site.id, req.params.releaseId as string);
    if (!release) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return { site, release };
  }

  router.get(WEBSITE_MODULE_API_ROUTES.releases, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json((await publish.listReleases(site.companyId, site.id)).map(toWebsiteRelease));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.releases, async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const person = personClick(req);
    const release = await publish.startPublish(site, person);
    await log(req, site.companyId, "website.publish_started", "website_release", release.id, { siteId: site.id, number: release.number });
    res.status(202).json(toWebsiteRelease(release));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.release, async (req, res) => {
    const found = await releaseFor(req, res, "website:view");
    if (!found) return;
    res.json(toWebsiteRelease(found.release));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.releaseRetry, async (req, res) => {
    const found = await releaseFor(req, res, "website:publish");
    if (!found) return;
    res.json((await publish.retryPlan(found.site, found.release)).plan);
  });

  router.post(WEBSITE_MODULE_API_ROUTES.releaseRetry, validate(websiteReleaseActionSchema), async (req, res) => {
    const found = await releaseFor(req, res, "website:publish");
    if (!found) return;
    const person = personClick(req);
    const { release, plan } = await publish.retry(found.site, found.release, person, req.body.confirmRebuild === true);
    await log(req, found.site.companyId, "website.release_retried", "website_release", release.id, { siteId: found.site.id, number: release.number, action: plan.action });
    res.status(202).json(toWebsiteRelease(release));
  });

  router.get(WEBSITE_MODULE_API_ROUTES.releaseRollback, async (req, res) => {
    const found = await releaseFor(req, res, "website:publish");
    if (!found) return;
    res.json((await publish.rollbackPlan(found.site, found.release)).plan);
  });

  router.post(WEBSITE_MODULE_API_ROUTES.releaseRollback, validate(websiteReleaseActionSchema), async (req, res) => {
    const found = await releaseFor(req, res, "website:publish");
    if (!found) return;
    const person = personClick(req);
    const { release, plan } = await publish.rollback(found.site, found.release, person, req.body.confirmRebuild === true);
    await log(req, found.site.companyId, "website.rollback_started", "website_release", release.id, {
      siteId: found.site.id,
      number: release.number,
      rollbackOf: found.release.number,
      action: plan.action,
    });
    res.status(202).json(toWebsiteRelease(release));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entrySubmit, async (req, res) => {
    const entry = await entryFor(req, res, "website:edit");
    if (!entry) return;
    const updated = await service.submitEntry(entry);
    await log(req, entry.companyId, "website.entry_submitted", "website_entry", entry.id, { siteId: entry.siteId, collection: entry.collection });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsiteEntry(updated, doc));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entryApprove, async (req, res) => {
    const entry = await entryFor(req, res, "website:publish", APPROVER);
    if (!entry) return;
    const detail = await service.entryDetail(entry);
    assertCollectionFields(entry.collection, detail?.content);
    const updated = await service.approveEntry(entry);
    await log(req, entry.companyId, "website.entry_approved", "website_entry", entry.id, { siteId: entry.siteId, revisionId: updated.approvedRevisionId });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsiteEntry(updated, doc));
  });

  router.post(WEBSITE_MODULE_API_ROUTES.entrySendBack, validate(sendBackWebsiteContentSchema), async (req, res) => {
    const entry = await entryFor(req, res, "website:publish", APPROVER);
    if (!entry) return;
    const updated = await service.sendBackEntry(entry);
    await log(req, entry.companyId, "website.entry_sent_back", "website_entry", entry.id, { siteId: entry.siteId, note: req.body.note });
    const { doc } = await service.withDoc(updated);
    res.json(toWebsiteEntry(updated, doc));
  });

  // ---- Publish proposals (GRE-2109): agents and people without Publish rights propose; a person approves ----

  router.post(WEBSITE_MODULE_API_ROUTES.publishProposals, async (req, res) => {
    const site = await siteFor(req, res, "website:edit");
    if (!site) return;
    const { approval, created } = await publishApprovals.propose(site, actorOf(req));
    if (created) {
      await log(req, site.companyId, "approval.created", "approval", approval.id, { type: approval.type, siteId: site.id });
    }
    res.status(created ? 201 : 200).json(approval);
  });

  // ---- sitemap options (GRE-2111): agents propose, people approve ----

  router.get(WEBSITE_SITEMAP_API_ROUTES.options, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await sitemap.list(site.companyId, site.id, req.query.includeArchived === "true"));
  });

  router.post(WEBSITE_SITEMAP_API_ROUTES.options, validate(createWebsiteSitemapOptionSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:edit");
    if (!site) return;
    const row = await sitemap.create(site, req.body, actorOf(req));
    await log(req, site.companyId, "website.sitemap_option_created", "website_sitemap_option", row.id, { siteId: site.id, name: row.name });
    res.status(201).json(toWebsiteSitemapOption(row));
  });

  router.post(WEBSITE_SITEMAP_API_ROUTES.importOption, validate(importWebsiteSitemapOptionSchema), async (req, res) => {
    const site = await siteFor(req, res, "website:edit");
    if (!site) return;
    const tree = sitemapTreeFromImport(req.body);
    const parsed = websiteSitemapTreeSchema.safeParse(tree);
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]?.message ?? "The sitemap is not valid", {
        code: "website_sitemap_tree_invalid",
        problems: parsed.error.issues.map((issue) => issue.message),
      });
    }
    const row = await sitemap.create(site, { name: req.body.name, description: req.body.description ?? null, tree: parsed.data }, actorOf(req));
    await log(req, site.companyId, "website.sitemap_option_imported", "website_sitemap_option", row.id, { siteId: site.id, name: row.name, pages: tree.nodes.length });
    res.status(201).json(toWebsiteSitemapOption(row));
  });

  async function optionFor(req: Request, res: Response, permission: WebsitePermission) {
    const site = await siteFor(req, res, permission);
    if (!site) return null;
    const row = await sitemap.getRow(site.companyId, site.id, req.params.optionId as string);
    if (!row) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return { site, row };
  }

  router.get(WEBSITE_SITEMAP_API_ROUTES.option, async (req, res) => {
    const found = await optionFor(req, res, "website:view");
    if (!found) return;
    res.json(toWebsiteSitemapOption(found.row));
  });

  router.put(WEBSITE_SITEMAP_API_ROUTES.option, validate(updateWebsiteSitemapOptionSchema), async (req, res) => {
    const found = await optionFor(req, res, "website:edit");
    if (!found) return;
    const row = await sitemap.update(found.row, req.body);
    await log(req, found.site.companyId, "website.sitemap_option_updated", "website_sitemap_option", row.id, { siteId: found.site.id, fields: Object.keys(req.body) });
    res.json(toWebsiteSitemapOption(row));
  });

  router.post(WEBSITE_SITEMAP_API_ROUTES.archiveOption, async (req, res) => {
    const found = await optionFor(req, res, "website:edit");
    if (!found) return;
    const row = await sitemap.archive(found.row);
    await log(req, found.site.companyId, "website.sitemap_option_archived", "website_sitemap_option", row.id, { siteId: found.site.id });
    res.json(toWebsiteSitemapOption(row));
  });

  // Approving writes the site's pages and menus: website:publish, which agents can never hold.
  router.post(WEBSITE_SITEMAP_API_ROUTES.approveOption, async (req, res) => {
    const found = await optionFor(req, res, "website:publish");
    if (!found) return;
    const actor = actorOf(req);
    if (!actor.userId) throw new HttpError(403, "Only a person can approve a sitemap", { code: "website_sitemap_approve_people_only" });
    const result = await sitemap.approve(found.site, found.row, actor);
    await log(req, found.site.companyId, "website.sitemap_option_approved", "website_sitemap_option", found.row.id, { siteId: found.site.id, ...result.summary });
    res.json(result);
  });

  router.get(WEBSITE_SITEMAP_API_ROUTES.sitemapXml, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.type("application/xml").send(await sitemap.sitemapXml(site));
  });

  return router;
}
