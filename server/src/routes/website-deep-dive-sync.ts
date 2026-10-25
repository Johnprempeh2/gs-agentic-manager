import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  DEEP_DIVE_SYNC_API_ROUTES,
  WEBSITE_BRIDGE_INBOUND_ROUTES,
  setWebsiteBridgeSiteKeySchema,
  websiteDocumentRequestAnswerSchema,
  type PermissionKey,
} from "@greatstone/shared";
import { HttpError } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteModuleService, type SiteRow } from "../services/website/module.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import type { WebsiteBridgeActor } from "../services/website/data-bridge-client.js";
import { InboundBridgeError, deepDiveSyncService, type DeepDiveSyncOptions } from "../services/website/deep-dive-sync.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deep Dive sync (GRE-2439), staff side. Same order of checks as the website data bridge routes: company access,
// the website permission, then the site by (company_id, id) or 404. Sending to the site and setting its key are
// website:publish and people only, like the read key; the preview is website:view.
export function websiteDeepDiveSyncRoutes(db: Db, options: DeepDiveSyncOptions = {}) {
  const router = Router();
  const sites = websiteModuleService(db);
  const access = accessService(db);
  const sync = deepDiveSyncService(db, options);

  router.use("/companies/:companyId/website/sites/:siteId/deep-dive-sync", requireEntitlement(db, "enableWebsiteView"));
  router.use(DEEP_DIVE_SYNC_API_ROUTES.siteKey, requireEntitlement(db, "enableWebsiteView"));

  async function siteFor(req: Request, res: Response, permission: Extract<PermissionKey, "website:view" | "website:publish">): Promise<SiteRow | null> {
    const companyId = req.params.companyId as string;
    const siteId = req.params.siteId as string;
    assertCompanyAccess(req, companyId);
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

  router.get(DEEP_DIVE_SYNC_API_ROUTES.preview, async (req, res) => {
    const site = await siteFor(req, res, "website:view");
    if (!site) return;
    res.json(await sync.preview(site.companyId, req.params.clientCaseId as string));
  });

  router.post(DEEP_DIVE_SYNC_API_ROUTES.sync, async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const result = await sync.push(site, req.params.clientCaseId as string, actorOf(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.deep_dive_synced",
      entityType: "pipeline_case", entityId: result.tenantId, agentId: actor.agentId, runId: actor.runId,
      details: { siteId: site.id, keyId: site.dataBridgeWriteKeyId, counts: result.counts },
    });
    res.json(result);
  });

  router.put(DEEP_DIVE_SYNC_API_ROUTES.siteKey, validate(setWebsiteBridgeSiteKeySchema), async (req, res) => {
    const site = await siteFor(req, res, "website:publish");
    if (!site) return;
    const key = await sync.setSiteKey(site, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: site.companyId, actorType: actor.actorType, actorId: actor.actorId, action: "website.data_bridge_site_key_set",
      entityType: "website_site", entityId: site.id, agentId: actor.agentId, runId: actor.runId,
      details: { keyId: key.keyId, replaced: site.dataBridgeSiteKeyId },
    });
    res.json(key);
  });

  return router;
}

// Deep Dive sync (GRE-2439), the site's call back. No GSAM sign-in: the gs-bridge-v1 signature with the site's own
// key is the only way in, and that key names one site, so one company. Errors are `{ error: { code } }` only.
export function websiteBridgeInboundRoutes(db: Db, options: DeepDiveSyncOptions = {}) {
  const router = Router();
  const sync = deepDiveSyncService(db, options);
  const publicHost = (() => {
    try {
      return process.env.GSAM_PUBLIC_URL ? new URL(process.env.GSAM_PUBLIC_URL).host.toLowerCase() : null;
    } catch {
      return null;
    }
  })();

  router.post(WEBSITE_BRIDGE_INBOUND_ROUTES.answerDocumentRequest, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const host = req.get("host")?.toLowerCase();
      const call = await sync.verifySiteCall({
        method: req.method,
        hosts: [...new Set([host, publicHost].filter((value): value is string => Boolean(value)))],
        url: req.originalUrl,
        headers: req.headers as Record<string, string | undefined>,
        body: (req as Request & { rawBody?: Buffer }).rawBody,
      });
      const body = websiteDocumentRequestAnswerSchema.safeParse(req.body);
      if (!body.success) throw new InboundBridgeError("bad_request");
      const result = await sync.answerDocumentRequest(call, req.params.tenantId as string, req.params.requestId as string, body.data);
      if (!result.repeated) {
        await logActivity(db, {
          companyId: call.site.companyId, actorType: "system", actorId: `website:${call.site.id}`,
          action: "deep_dive.document_request_answered_on_website", entityType: "pipeline_case_document_request",
          entityId: result.requestId,
          details: { siteId: call.site.id, tenantId: req.params.tenantId, customerId: call.customerId, answerId: body.data.answerId },
        });
      }
      res.json({ ok: true, requestId: result.requestId, receivedAt: result.receivedAt });
    } catch (error) {
      if (error instanceof InboundBridgeError) {
        res.status(error.status).json({ error: { code: error.code } });
        return;
      }
      throw error;
    }
  });

  return router;
}
