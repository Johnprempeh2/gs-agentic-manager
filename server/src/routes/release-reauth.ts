// POST /api/reauth (GRE-133): the signed-in board user enters the password
// again and gets a one-use token for one release, rollback or promote. The
// check itself is `assertReleaseReauth` in services/release-reauth.ts.
import { Router } from "express";
import type { Db } from "@greatstone/db";
import { conflict, forbidden, HttpError, unprocessable } from "../errors.js";
import {
  RELEASE_REAUTH_ACTIONS,
  isReleaseReauthAction,
  releaseReauth,
  type ReleaseReauth,
} from "../services/release-reauth.js";
import { assertBoard } from "./authz.js";

export function releaseReauthRoutes(db: Db, reauth: ReleaseReauth = releaseReauth(db)) {
  const router = Router();

  router.post("/reauth", async (req, res) => {
    assertBoard(req);
    if (req.actor.source === "local_implicit") {
      throw conflict("No password in local_trusted mode; the board-only guard applies", { code: "reauth_not_needed" });
    }
    if (req.actor.source !== "session" || !req.actor.userId) {
      throw forbidden("Sign in to the app in a browser first", { code: "reauth_session_required" });
    }
    const action = req.body?.action;
    if (!isReleaseReauthAction(action)) {
      throw unprocessable(`action must be one of: ${RELEASE_REAUTH_ACTIONS.join(", ")}`);
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const result = await reauth.issue({
      userId: req.actor.userId,
      sessionId: req.actor.sessionId ?? null,
      action,
      password,
    });
    if (!result.ok) {
      if (result.reason === "locked") {
        throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes", { code: "reauth_locked" });
      }
      throw forbidden("Wrong password", { code: "reauth_invalid_password" });
    }
    res.json({ token: result.token, action: result.action, expiresAt: result.expiresAt });
  });

  return router;
}
