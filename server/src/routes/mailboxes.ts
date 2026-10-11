import { Router, type Request } from "express";
import {
  isUuidLike,
  mailboxAgentsSchema,
  mailboxConnectSchema,
  mailboxOAuthAppSchema,
  mailboxOAuthProviderSchema,
  mailboxOAuthStartSchema,
  mailboxReadSchema,
  mailboxSaveSchema,
  mailboxSearchSchema,
} from "@greatstone/shared";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@greatstone/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";
import { badRequest, forbidden, HttpError, unprocessable } from "../errors.js";
import { isLoopbackHost } from "../url-utils.js";
import { trustedBoardMutationOrigin } from "../middleware/board-mutation-guard.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import type { OAuthFetch } from "../services/mailbox-oauth.js";
import type { StorageService } from "../storage/types.js";
import {
  mailboxService,
  type MailboxBoardActor,
  type MailboxReader,
} from "../services/mailboxes.js";
import {
  MailboxUnavailableError,
  type MailboxClientFactory,
} from "../services/mailbox-imap.js";
import { logger } from "../middleware/logger.js";

// Read-only mailboxes (GRE-1343). Board users with tools:manage_connections add
// and remove them; agents reach only the mailboxes installed for them.
export function mailboxRoutes(
  db: Db,
  storage: StorageService,
  options: {
    clientFactory?: MailboxClientFactory;
    fetch?: OAuthFetch;
    authPublicBaseUrl?: string;
  } = {},
) {
  const router = Router();
  const service = mailboxService(db, {
    storage,
    clientFactory: options.clientFactory,
    fetch: options.fetch,
  });

  router.param("companyId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid company");
    next();
  });
  router.param("mailboxId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid mailbox");
    next();
  });

  async function manager(req: Request, companyId: string): Promise<MailboxBoardActor> {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = {
      userId: req.actor.userId ?? "board",
      localImplicit: req.actor.source === "local_implicit",
    };
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return actor;
    if (
      !req.actor.userId ||
      !(await accessService(db).hasPermission(
        companyId,
        "user",
        req.actor.userId,
        "tools:manage_connections",
      ))
    )
      throw forbidden("Missing permission: tools:manage_connections");
    return actor;
  }

  async function reader(req: Request, companyId: string): Promise<MailboxReader> {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      return { kind: "agent", agentId: req.actor.agentId, runId: req.actor.runId ?? undefined };
    }
    const actor = await manager(req, companyId);
    return { kind: "board", userId: actor.userId };
  }

  // The provider sends the browser back here. It must match the redirect URI
  // registered on the OAuth app exactly, so prefer a configured public
  // address, then the browser's own same-origin address, then loopback.
  function redirectUri(req: Request) {
    const configured =
      runtimeCanonicalOrigin() ??
      (process.env.GSAM_AUTH_PUBLIC_BASE_URL?.trim() ||
        options.authPublicBaseUrl?.trim() ||
        process.env.GSAM_PUBLIC_URL?.trim() ||
        null);
    let base: string | null = null;
    if (configured) {
      try {
        base = new URL(configured).origin;
      } catch {
        base = null;
      }
    }
    if (!base) {
      const origin = trustedBoardMutationOrigin(req);
      const host = req.get("host")?.trim();
      const candidate = origin ?? (host ? `${req.protocol}://${host}` : null);
      try {
        const parsed = candidate ? new URL(candidate) : null;
        if (
          parsed &&
          (parsed.protocol === "https:" ||
            (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))
        )
          base = parsed.origin;
      } catch {
        base = null;
      }
    }
    if (!base)
      throw unprocessable(
        "Mailbox sign-in needs an HTTPS address (or localhost) for this app.",
        { code: "mailbox_oauth_redirect_unsupported" },
      );
    return new URL("/api/mailbox-oauth/callback", base).toString();
  }

  async function mailboxesPath(companyId: string | null, outcome: Record<string, string>) {
    const [company] = companyId
      ? await db
          .select({ issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, companyId))
      : [];
    const query = new URLSearchParams(outcome).toString();
    return company ? `/${company.issuePrefix}/apps/mailboxes?${query}` : "/";
  }

  router.get("/companies/:companyId/mailbox-oauth/apps", async (req, res) => {
    const companyId = String(req.params.companyId);
    await manager(req, companyId);
    res.set("Cache-Control", "no-store").json(await service.oauthApps(companyId, redirectUri(req)));
  });

  router.put(
    "/companies/:companyId/mailbox-oauth/apps/:provider",
    validate(mailboxOAuthAppSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      const provider = mailboxOAuthProviderSchema.safeParse(req.params.provider);
      if (!provider.success) throw badRequest("Unknown sign-in provider");
      res.json(await service.saveOAuthApp(companyId, provider.data, req.body, actor));
    },
  );

  router.post(
    "/companies/:companyId/mailbox-oauth/start",
    validate(mailboxOAuthStartSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(await service.startOAuth(companyId, req.body, actor, redirectUri(req)));
    },
  );

  // Always a redirect, never a 4xx: the query carries the one-time code, and
  // failure logs copy the query string. Outcomes use our own wording only;
  // the provider's error_description is never shown.
  router.get("/mailbox-oauth/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const entry = state ? service.takeSignIn(state) : null;
    if (!entry) {
      res.redirect(303, "/?mailboxError=" + encodeURIComponent("This mailbox sign-in expired or was already used. Start again."));
      return;
    }
    const fail = async (message: string) =>
      res.redirect(303, await mailboxesPath(entry.companyId, { mailboxError: message }));
    try {
      // Bind the callback to the board user who started it, so a sign-in
      // link cannot attach someone else's mailbox to this company.
      if (req.actor.type !== "board" || (req.actor.userId ?? "board") !== entry.userId) {
        await fail("Sign in to this app as the person who started the mailbox sign-in, then try again.");
        return;
      }
      const actor = await manager(req, entry.companyId);
      if (typeof req.query.error === "string" || !code) {
        await fail(
          req.query.error === "access_denied"
            ? "Mailbox sign-in was cancelled."
            : "The provider did not complete the mailbox sign-in. Try again.",
        );
        return;
      }
      const mailbox = await service.completeOAuth(entry, code, actor);
      res.redirect(303, await mailboxesPath(entry.companyId, { mailboxConnected: mailbox.address }));
    } catch (error) {
      const ours =
        error instanceof HttpError &&
        (error.status < 500 || error instanceof MailboxUnavailableError);
      if (!ours) logger.warn({ err: error }, "mailbox sign-in failed");
      await fail(ours ? (error as HttpError).message : "Mailbox sign-in failed. Try again.");
    }
  });

  router.get("/companies/:companyId/mailboxes", async (req, res) => {
    const companyId = String(req.params.companyId);
    const who = await reader(req, companyId);
    res.set("Cache-Control", "no-store").json(
      who.kind === "agent"
        ? await service.assigned(companyId, who.agentId)
        : await service.list(companyId),
    );
  });

  router.post(
    "/companies/:companyId/mailboxes",
    validate(mailboxConnectSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      res.status(201).json(await service.connect(companyId, req.body, actor));
    },
  );

  router.put(
    "/companies/:companyId/mailboxes/:mailboxId/agents",
    validate(mailboxAgentsSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      res.json(
        await service.setAgents(companyId, String(req.params.mailboxId), req.body, actor),
      );
    },
  );

  router.delete("/companies/:companyId/mailboxes/:mailboxId", async (req, res) => {
    const companyId = String(req.params.companyId);
    const actor = await manager(req, companyId);
    res.json(await service.remove(companyId, String(req.params.mailboxId), actor));
  });

  router.post("/companies/:companyId/mailboxes/:mailboxId/test", async (req, res) => {
    const companyId = String(req.params.companyId);
    await manager(req, companyId);
    res.json(await service.test(companyId, String(req.params.mailboxId)));
  });

  router.get("/companies/:companyId/mailboxes/:mailboxId/folders", async (req, res) => {
    const companyId = String(req.params.companyId);
    const who = await reader(req, companyId);
    res
      .set("Cache-Control", "no-store")
      .json(await service.folders(companyId, String(req.params.mailboxId), who));
  });

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/search",
    validate(mailboxSearchSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(await service.search(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/read",
    validate(mailboxReadSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(await service.read(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/save",
    validate(mailboxSaveSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .status(201)
        .json(await service.save(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  return router;
}
