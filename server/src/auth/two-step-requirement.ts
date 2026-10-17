/**
 * Compulsory two-step sign-in.
 *
 * An instance admin can turn on `requireTwoStepSignIn` (Instance settings >
 * Security). While it is on, a person who signed in with only a password
 * reaches sign-in, sign-out, their own two-step setup, invite acceptance and
 * the health check, and nothing else, until they turn two-step sign-in on.
 * Nobody can turn it off for themselves while it is required; an admin reset
 * (lost phone) is the only way to clear it, and the person must set it up
 * again at their next sign-in.
 *
 * Agent keys, board API keys and the local trusted mode are not password
 * sessions, so they are not affected.
 */

import type { Request, RequestHandler } from "express";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { instanceSettingsService } from "../services/instance-settings.js";

export const TWO_STEP_SETUP_REQUIRED_CODE = "TWO_STEP_SETUP_REQUIRED";
export const TWO_STEP_SETUP_REQUIRED_MESSAGE =
  "Two-step sign-in is required on this instance. Turn it on in your profile to continue.";
export const TWO_STEP_DISABLE_REFUSED_MESSAGE =
  "Two-step sign-in is required on this instance, so it cannot be turned off. An admin can reset it if you lose your phone.";

// Read on most API calls, so the setting is cached briefly. Changing it
// through the settings route clears the cache at once.
const CACHE_MS = 5_000;
let cached: { value: boolean; at: number } | null = null;

export function clearTwoStepRequirementCache() {
  cached = null;
}

export async function isTwoStepSignInRequired(db: Db, now: () => number = Date.now): Promise<boolean> {
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const general = await instanceSettingsService(db).getGeneral();
  const value = general.requireTwoStepSignIn === true;
  cached = { value, at: now() };
  return value;
}

// Paths a person without two-step sign-in still needs: sign-in, sign-out,
// session, profile and two-step setup (all under /api/auth), the health
// check, and accepting an invite (token in the link). Matched on the raw
// path so an encoded or dotted segment cannot reach another router.
const ALLOWED_PATHS = [/^\/api\/auth(\/.*)?$/i, /^\/api\/health\/?$/i, /^\/api\/invites\/[^/]+(\/[^/]+)*\/?$/i];

export function isTwoStepSetupPath(path: string) {
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path)) return false;
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

export function needsTwoStepSetup(actor: Request["actor"]) {
  return actor.type === "board" && actor.source === "session" && actor.twoFactorEnabled !== true;
}

export function twoStepRequiredGuard(db: Db): RequestHandler {
  return (req, _res, next) => {
    if (!needsTwoStepSetup(req.actor) || !req.originalUrl.startsWith("/api") || isTwoStepSetupPath(req.path)) {
      next();
      return;
    }
    isTwoStepSignInRequired(db).then(
      (required) =>
        next(required ? forbidden(TWO_STEP_SETUP_REQUIRED_MESSAGE, { code: TWO_STEP_SETUP_REQUIRED_CODE }) : undefined),
      next,
    );
  };
}

/** Refuses turning two-step sign-in off while the instance requires it. */
export function twoStepRequiredPlugin(db: Db) {
  return {
    id: "gsam-two-step-required",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/two-factor/disable",
          handler: createAuthMiddleware(async () => {
            if (await isTwoStepSignInRequired(db)) {
              throw APIError.from("FORBIDDEN", {
                message: TWO_STEP_DISABLE_REFUSED_MESSAGE,
                code: "TWO_STEP_REQUIRED",
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
