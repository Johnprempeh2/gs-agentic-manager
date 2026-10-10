import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { userTourDismissals, type Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated, assertBoard } from "./authz.js";

export const markTourSeenSchema = z.object({
  tourKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Tour key must be a short lowercase slug"),
  tourVersion: z.number().int().min(1).max(10_000),
}).strict();

/** Guided tours the signed-in person has finished or skipped. Board users only; never agents. */
export function tourDismissalRoutes(db: Db) {
  const router = Router();
  router.use("/tour-dismissals", (req, res, next) => {
    assertAuthenticated(req);
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user context required");
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/tour-dismissals/me", async (req, res) => {
    const rows = await db
      .select({ tourKey: userTourDismissals.tourKey, tourVersion: userTourDismissals.tourVersion, seenAt: userTourDismissals.seenAt })
      .from(userTourDismissals)
      .where(eq(userTourDismissals.userId, req.actor.userId!));
    res.json(rows);
  });

  // Idempotent: marking a tour seen twice keeps the first seenAt.
  router.put("/tour-dismissals/me", validate(markTourSeenSchema), async (req, res) => {
    await db
      .insert(userTourDismissals)
      .values({ userId: req.actor.userId!, tourKey: req.body.tourKey, tourVersion: req.body.tourVersion })
      .onConflictDoNothing();
    res.status(204).send();
  });

  // "Show all tutorials again": clears only the caller's own records.
  router.delete("/tour-dismissals/me", async (req, res) => {
    await db.delete(userTourDismissals).where(eq(userTourDismissals.userId, req.actor.userId!));
    res.status(204).send();
  });

  return router;
}
