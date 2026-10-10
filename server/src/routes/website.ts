import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies } from "@greatstone/db";
import {
  WEBSITE_API_ROUTES,
  createWebsitePropertySchema,
  startWebsiteGoogleConnectSchema,
  updateWebsitePropertySchema,
  type WebsiteGoogleConnectStart,
  type WebsiteOverview,
} from "@greatstone/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import { logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { websiteService, type WebsiteServiceOptions } from "../services/website/index.js";
import { isLoopbackHost } from "../url-utils.js";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess, assertCompanyOwnerOrAdmin, getActorInfo } from "./authz.js";

// Website view routes (GRE-1087). The `enableWebsiteView` switch gates every
// one of them through the shared entitlement gate (GRE-1077) before anything
// else runs: off answers 403 `not_entitled` with `feature`.

export function websiteRoutes(db: Db, opts: WebsiteServiceOptions = {}) {
  const router = Router();
  const service = websiteService(db, opts);

  router.use(["/companies/:companyId/website", "/website"], requireEntitlement(db, "enableWebsiteView"));

  function configuredPublicOrigin(): string | null {
    const runtimeOrigin = runtimeCanonicalOrigin();
    if (runtimeOrigin) return runtimeOrigin;
    const raw =
      process.env.GSAM_AUTH_PUBLIC_BASE_URL?.trim()
      || process.env.BETTER_AUTH_URL?.trim()
      || process.env.GSAM_PUBLIC_URL?.trim();
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  function browserOrigin(req: Request): string | null {
    const trusted = trustedBoardMutationOrigin(req);
    const candidate = trusted ?? (req.get("host") ? `${req.protocol}://${req.get("host")}` : null);
    if (!candidate) return null;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && trusted) return parsed.origin;
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // Fall through.
    }
    return null;
  }

  function googleRedirectUri(req: Request): string {
    const origin = configuredPublicOrigin() ?? browserOrigin(req);
    if (!origin) {
      throw unprocessable(
        "This GS Agentic Manager needs a browser-reachable HTTPS address (or loopback HTTP) before Google sign-in can start.",
        { code: "oauth_redirect_origin_unsupported" },
      );
    }
    return new URL(`/api${WEBSITE_API_ROUTES.googleCallback}`, origin).toString();
  }

  async function websitePagePath(companyId: string): Promise<string> {
    const [company] = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return company ? `/${company.issuePrefix}/website` : "/";
  }

  /** Property in the path's company, or 404 (never another company's row). */
  async function propertyInCompany(req: Request, res: Response) {
    const companyId = req.params.companyId as string;
    const property = await service.getPropertyRow(req.params.propertyId as string);
    if (!property || property.companyId !== companyId) {
      res.status(404).json({ error: "Website property not found" });
      return null;
    }
    return property;
  }

  async function logWebsite(req: Request, companyId: string, action: string, propertyId: string, details?: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "website_property",
      entityId: propertyId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  router.get(WEBSITE_API_ROUTES.overview, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const overview: WebsiteOverview = {
      googleSignInAvailable: service.googleSignInAvailable(),
      properties: await service.listProperties(companyId),
    };
    res.json(overview);
  });

  router.post(WEBSITE_API_ROUTES.createProperty, validate(createWebsitePropertySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerOrAdmin(req, companyId);
    const property = await service.createProperty(companyId, req.body);
    await logWebsite(req, companyId, "website.property_created", property.id, { siteUrl: property.siteUrl });
    res.status(201).json(property);
  });

  router.patch(WEBSITE_API_ROUTES.property, validate(updateWebsitePropertySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerOrAdmin(req, companyId);
    const property = await propertyInCompany(req, res);
    if (!property) return;
    const updated = await service.updateProperty(property, req.body);
    await logWebsite(req, companyId, "website.property_updated", property.id, { fields: Object.keys(req.body) });
    res.json(updated);
  });

  router.get(WEBSITE_API_ROUTES.report, async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const property = await propertyInCompany(req, res);
    if (!property) return;
    res.json(await service.getReport(property));
  });

  router.post(WEBSITE_API_ROUTES.connectGoogle, validate(startWebsiteGoogleConnectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerOrAdmin(req, companyId);
    const property = await propertyInCompany(req, res);
    if (!property) return;
    const actor = getActorInfo(req);
    const authorizationUrl = service.startGoogleConnect({
      property,
      userId: actor.actorId,
      redirectUri: googleRedirectUri(req),
      returnTo: req.body.returnTo ?? null,
    });
    const body: WebsiteGoogleConnectStart = { authorizationUrl };
    res.json(body);
  });

  router.post(WEBSITE_API_ROUTES.disconnectGoogle, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerOrAdmin(req, companyId);
    const property = await propertyInCompany(req, res);
    if (!property) return;
    const updated = await service.disconnectGoogle(property);
    await logWebsite(req, companyId, "website.google_disconnected", property.id);
    res.json(updated);
  });

  router.post(WEBSITE_API_ROUTES.pull, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const property = await propertyInCompany(req, res);
    if (!property) return;
    const pull = await service.pullProperty(property.id, "manual");
    await logWebsite(req, companyId, "website.pulled", property.id, { pullId: pull.id, status: pull.status });
    res.json(pull);
  });

  // Google sends the browser here after consent. Only the user who started
  // the sign-in may finish it, and only into the company it was started for.
  router.get(WEBSITE_API_ROUTES.googleCallback, async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const pending = state ? service.peekGoogleConnect(state) : null;
    if (!pending) {
      res.status(400).json({ error: "This Google sign-in has expired. Start it again from the Website page.", code: "website_google_state_invalid" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, pending.companyId);
    if (req.actor.type !== "board" || req.actor.userId !== pending.userId) {
      throw forbidden("Finish Google sign-in as the same user who started it", { code: "website_google_user_mismatch" });
    }
    const fallbackPath = await websitePagePath(pending.companyId);
    const target = new URL(pending.returnTo ?? fallbackPath, "http://app.invalid");
    try {
      const result = await service.completeGoogleConnect({ state, code, error });
      await logWebsite(req, pending.companyId, "website.google_connected", result.property.id);
      target.searchParams.set("websiteGoogle", "connected");
    } catch (err) {
      logger.warn({ err, companyId: pending.companyId, propertyId: pending.propertyId }, "website Google sign-in failed");
      const errCode = (err as { details?: { code?: unknown } })?.details?.code;
      target.searchParams.set("websiteGoogle", "error");
      target.searchParams.set("reason", typeof errCode === "string" ? errCode : "website_google_exchange_failed");
    }
    res.redirect(302, `${target.pathname}${target.search}`);
  });

  return router;
}
