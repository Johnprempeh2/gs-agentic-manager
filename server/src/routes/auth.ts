import { Router } from "express";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { authSessions, authUsers } from "@greatstone/db";
import {
  authSessionSchema,
  currentUserPreferencesSchema,
  updateCurrentUserPreferencesSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@greatstone/shared";
import { hasCompanyAccess } from "./authz.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { resolveSentryDsns } from "../sentry-dsn.js";
import { isTwoStepExemptEmail, isTwoStepSignInRequired } from "../auth/two-step-requirement.js";

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

export function authRoutes(db: Db) {
  const router = Router();
  // These routes sit in front of the API router, so they take the same
  // same-origin check board changes get there.
  const mutationGuard = boardMutationGuard();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    res.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
      // The browser reads this value to open its own Sentry gate — see
      // `ui/src/lib/sentry.ts`. `req.actor.type` already gates this whole
      // handler, so no second authorization check runs here. This field
      // carries the front-end DSN only; it never carries the backend DSN.
      sentryDsn: resolveSentryDsns().frontend,
      // Match the server SDK's runtime environment, including in reused images.
      sentryEnvironment: process.env.SENTRY_ENVIRONMENT || null,
    }));
  });

  // Whether this person has two-step sign-in on, for Profile. Only a person
  // signed in with a password session can turn it on or off.
  router.get("/two-step-status", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const [user] = await db.select({ enabled: authUsers.twoFactorEnabled })
      .from(authUsers).where(eq(authUsers.id, req.actor.userId));
    if (!user) throw unauthorized("Signed-in user not found");
    res.json({
      enabled: user.enabled,
      available: req.actor.source === "session",
      required: !isTwoStepExemptEmail(req.actor.userEmail) && (await isTwoStepSignInRequired(db)),
    });
  });

  // Where this person is signed in: one row per live session, newest first.
  // Tokens never leave the server; rows are addressed by session id.
  router.get("/sessions", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const rows = await db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        updatedAt: authSessions.updatedAt,
        expiresAt: authSessions.expiresAt,
        ipAddress: authSessions.ipAddress,
        userAgent: authSessions.userAgent,
      })
      .from(authSessions)
      .where(and(eq(authSessions.userId, req.actor.userId), gt(authSessions.expiresAt, new Date())))
      .orderBy(desc(authSessions.updatedAt));
    res.json({
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        ipAddress: row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
        current: row.id === req.actor.sessionId,
      })),
    });
  });

  router.post("/sessions/revoke-others", mutationGuard, async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const current = req.actor.sessionId ?? null;
    const removed = await db
      .delete(authSessions)
      .where(current
        ? and(eq(authSessions.userId, req.actor.userId), ne(authSessions.id, current))
        : eq(authSessions.userId, req.actor.userId))
      .returning({ id: authSessions.id });
    res.json({ revoked: removed.length });
  });

  router.post("/sessions/:sessionId/revoke", mutationGuard, async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const sessionId = req.params.sessionId as string;
    if (sessionId === req.actor.sessionId) {
      throw conflict("This is the device you are using. Use Sign out instead.");
    }
    const removed = await db
      .delete(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, req.actor.userId)))
      .returning({ id: authSessions.id });
    if (removed.length === 0) throw notFound("Session not found");
    res.json({ revoked: 1 });
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", mutationGuard, validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  });

  router.get("/preferences", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    if (req.query.expectedUserId !== req.actor.userId) throw unauthorized("Account changed. Refresh and try again.");
    const [user] = await db.select({ keyboardShortcuts: authUsers.keyboardShortcuts })
      .from(authUsers).where(eq(authUsers.id, req.actor.userId));
    if (!user) throw unauthorized("Signed-in user not found");
    res.json(currentUserPreferencesSchema.parse(user));
  });

  router.patch("/preferences", mutationGuard, validate(updateCurrentUserPreferencesSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const { companyId, keyboardShortcuts, expectedUserId } = updateCurrentUserPreferencesSchema.parse(req.body);
    const userId = req.actor.userId;
    if (expectedUserId !== userId) throw unauthorized("Account changed. Refresh and try again.");
    // This is a personal write; company membership supplies audit context only.
    if (!hasCompanyAccess(req, companyId)) throw forbidden("User does not have access to this company");
    const publications: ActivityPublication[] = [];
    const user = await db.transaction(async (tx) => {
      const [updated] = await tx.update(authUsers)
        .set({ keyboardShortcuts, updatedAt: new Date() })
        .where(eq(authUsers.id, userId))
        .returning({ keyboardShortcuts: authUsers.keyboardShortcuts });
      if (!updated) throw unauthorized("Signed-in user not found");
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "user.preferences_updated",
        entityType: "user",
        entityId: userId,
        details: { keyboardShortcuts },
      }, publications);
      return updated;
    });
    for (const publication of publications) {
      try {
        publishActivity(publication);
      } catch (err) {
        // The preference and audit row are committed; notification failure must
        // not tell the caller that its durable save failed.
        logger.warn({ err, companyId, userId }, "Could not publish user preference activity");
      }
    }
    res.json(currentUserPreferencesSchema.parse(user));
  });

  return router;
}
