import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { assets, referenceItems, type Db } from "@greatstone/db";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

/**
 * The reference studio (2 Nov 2026): labelled images people and agents refer to
 * when instructing work. Upload the image with POST /companies/:id/assets/images
 * first, then file it here with a title, notes and tags.
 */

const fields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
};
const createSchema = z.object({ assetId: z.string().uuid(), ...fields }).strict();
const updateSchema = z
  .object({ ...fields, title: fields.title.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

const view = (row: typeof referenceItems.$inferSelect & { contentType?: string | null }) => ({
  id: row.id,
  assetId: row.assetId,
  title: row.title,
  notes: row.notes,
  tags: row.tags,
  contentType: row.contentType ?? null,
  /** Agents fetch the image here with their API key. */
  contentPath: `/api/assets/${row.assetId}/content`,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function referenceRoutes(db: Db) {
  const router = Router();

  async function activity(req: Parameters<typeof getActorInfo>[0], companyId: string, action: string, id: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "reference",
      entityId: id,
      details,
    });
  }

  router.get("/companies/:companyId/references", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : null;
    const rows = await db
      .select({ item: referenceItems, contentType: assets.contentType })
      .from(referenceItems)
      .innerJoin(assets, eq(assets.id, referenceItems.assetId))
      .where(and(eq(referenceItems.companyId, companyId), isNull(referenceItems.archivedAt)))
      .orderBy(desc(referenceItems.createdAt));
    res.json(
      rows
        .filter((r) => !tag || r.item.tags.includes(tag))
        .map((r) => view({ ...r.item, contentType: r.contentType })),
    );
  });

  router.post("/companies/:companyId/references", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as z.infer<typeof createSchema>;
    const [asset] = await db
      .select({ id: assets.id, contentType: assets.contentType })
      .from(assets)
      .where(and(eq(assets.id, body.assetId), eq(assets.companyId, companyId)));
    if (!asset) throw notFound("Image not found");
    if (!asset.contentType.startsWith("image/")) {
      res.status(422).json({ error: "A reference must be an image" });
      return;
    }
    const actor = getActorInfo(req);
    const [row] = await db
      .insert(referenceItems)
      .values({
        companyId,
        assetId: asset.id,
        title: body.title,
        notes: body.notes ?? null,
        tags: [...new Set(body.tags ?? [])],
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      })
      .returning();
    await activity(req, companyId, "reference.created", row.id, { title: row.title });
    res.status(201).json(view({ ...row, contentType: asset.contentType }));
  });

  async function ownRow(companyId: string, id: string) {
    const [row] = await db
      .select()
      .from(referenceItems)
      .where(and(eq(referenceItems.id, id), eq(referenceItems.companyId, companyId), isNull(referenceItems.archivedAt)));
    if (!row) throw notFound("Reference not found");
    return row;
  }

  router.patch("/companies/:companyId/references/:id", validate(updateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await ownRow(companyId, req.params.id as string);
    const body = req.body as z.infer<typeof updateSchema>;
    const [row] = await db
      .update(referenceItems)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.tags !== undefined ? { tags: [...new Set(body.tags)] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(referenceItems.id, req.params.id as string))
      .returning();
    await activity(req, companyId, "reference.updated", row.id, { fields: Object.keys(body) });
    res.json(view(row));
  });

  /** Archive, never delete: a reference may already be named in past instructions. */
  router.delete("/companies/:companyId/references/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await ownRow(companyId, req.params.id as string);
    await db.update(referenceItems).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(referenceItems.id, row.id));
    await activity(req, companyId, "reference.archived", row.id, { title: row.title });
    res.status(204).end();
  });

  return router;
}
