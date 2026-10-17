import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { studioLooks } from "@greatstone/db";
import {
  applyStudioLookWords,
  createStudioLookSchema,
  hasStudioCamera,
  STUDIO_LOOKS_MAX_PER_COMPANY,
  updateStudioLookSchema,
  type CreateStudioLook,
  type ImageStylePresetId,
  type StudioCameraSettings,
  type StudioLook,
  type UpdateStudioLook,
} from "@greatstone/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { GeneratedImageActor } from "./generated-images.js";

// House looks: named studio settings a company keeps so its images and clips
// match. Requests name a look by id; the look fills in what they leave out.

type StudioLookRow = typeof studioLooks.$inferSelect;

export function toStudioLook(row: StudioLookRow): StudioLook {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    style: (row.style as ImageStylePresetId | null) ?? null,
    camera: (row.camera as StudioCameraSettings | null) ?? null,
    words: row.words,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What a look adds to one request: the request's own picks win, the words are appended. */
export interface StudioLookApplied {
  lookId: string;
  prompt: string;
  style: ImageStylePresetId | null;
  camera: StudioCameraSettings | null;
}

export async function applyStudioLook(
  db: Db,
  companyId: string,
  lookId: string,
  request: { prompt: string; style?: ImageStylePresetId | null; camera?: StudioCameraSettings | null },
): Promise<StudioLookApplied> {
  const look = await db
    .select()
    .from(studioLooks)
    .where(and(eq(studioLooks.id, lookId), eq(studioLooks.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!look) throw unprocessable("That look is not in this organisation", { code: "studio_look_not_found" });
  const lookCamera = (look.camera as StudioCameraSettings | null) ?? null;
  return {
    lookId: look.id,
    prompt: applyStudioLookWords(request.prompt, look.words),
    style: request.style ?? ((look.style as ImageStylePresetId | null) ?? null),
    camera: hasStudioCamera(request.camera) ? request.camera : hasStudioCamera(lookCamera) ? lookCamera : null,
  };
}

function cleanCamera(camera: StudioCameraSettings | null | undefined) {
  return hasStudioCamera(camera) ? camera : null;
}

export function studioLookService(db: Db) {
  async function assertNameFree(companyId: string, name: string, exceptId?: string) {
    const clash = await db
      .select({ id: studioLooks.id })
      .from(studioLooks)
      .where(
        and(
          eq(studioLooks.companyId, companyId),
          sql`lower(${studioLooks.name}) = lower(${name})`,
          exceptId ? ne(studioLooks.id, exceptId) : undefined,
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (clash) throw conflict(`There is already a look called "${name}"`, { code: "studio_look_name_taken" });
  }

  async function audit(row: StudioLookRow, actor: GeneratedImageActor, action: string) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "studio_look",
      entityId: row.id,
      details: { name: row.name },
    });
  }

  return {
    list: async (companyId: string): Promise<StudioLook[]> => {
      const rows = await db
        .select()
        .from(studioLooks)
        .where(eq(studioLooks.companyId, companyId))
        .orderBy(asc(studioLooks.name));
      return rows.map(toStudioLook);
    },

    getById: async (id: string) =>
      db
        .select()
        .from(studioLooks)
        .where(eq(studioLooks.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (companyId: string, input: CreateStudioLook, actor: GeneratedImageActor) => {
      const parsed = createStudioLookSchema.parse(input);
      const [{ total }] = await db.select({ total: count() }).from(studioLooks).where(eq(studioLooks.companyId, companyId));
      if (Number(total) >= STUDIO_LOOKS_MAX_PER_COMPANY) {
        throw unprocessable(`An organisation can keep ${STUDIO_LOOKS_MAX_PER_COMPANY} looks. Delete one first.`, {
          code: "studio_looks_full",
        });
      }
      await assertNameFree(companyId, parsed.name);
      const [row] = await db
        .insert(studioLooks)
        .values({
          companyId,
          name: parsed.name,
          description: parsed.description || null,
          style: parsed.style ?? null,
          camera: cleanCamera(parsed.camera),
          words: parsed.words || null,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        })
        .returning();
      await audit(row!, actor, "studio_look.created");
      return toStudioLook(row!);
    },

    update: async (row: StudioLookRow, input: UpdateStudioLook, actor: GeneratedImageActor) => {
      const parsed = updateStudioLookSchema.parse(input);
      if (parsed.name !== undefined) await assertNameFree(row.companyId, parsed.name, row.id);
      const patch: Partial<typeof studioLooks.$inferInsert> = { updatedAt: new Date() };
      if (parsed.name !== undefined) patch.name = parsed.name;
      if (parsed.description !== undefined) patch.description = parsed.description || null;
      if (parsed.style !== undefined) patch.style = parsed.style ?? null;
      if (parsed.camera !== undefined) patch.camera = cleanCamera(parsed.camera);
      if (parsed.words !== undefined) patch.words = parsed.words || null;
      const [updated] = await db.update(studioLooks).set(patch).where(eq(studioLooks.id, row.id)).returning();
      if (!updated) throw notFound("Look not found");
      await audit(updated, actor, "studio_look.updated");
      return toStudioLook(updated);
    },

    remove: async (row: StudioLookRow, actor: GeneratedImageActor) => {
      await db.delete(studioLooks).where(eq(studioLooks.id, row.id));
      await audit(row, actor, "studio_look.deleted");
    },
  };
}
