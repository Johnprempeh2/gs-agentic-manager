import { and, count, desc, eq, ilike, inArray, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, generatedImages, issues, organisations, studioLooks } from "@greatstone/db";
import {
  composeImagePrompt,
  composeStoryboardPrompt,
  hasStudioCamera,
  imageAltText,
  createGeneratedImageSchema,
  createGeneratedImageVariationsSchema,
  generatedImagesQuerySchema,
  GENERATED_IMAGES_MAX_PENDING_PER_COMPANY,
  IMAGE_SEED_MAX,
  LOCAL_IMAGE_MODELS,
  localImageModel,
  type CreateGeneratedImage,
  type CreateGeneratedImageVariations,
  type GeneratedImage,
  type GeneratedImageCovers,
  type GeneratedImagesQuery,
  type GeneratedImagesResponse,
  type GeneratedImageStatus,
  type ImageAspectRatio,
  type ImageGenerationProviderId,
  type ImageStylePresetId,
  type StudioCameraSettings,
  type UpdateGeneratedImageCover,
  type UpdateGeneratedImageFavourite,
} from "@greatstone/shared";
import { notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { applyStudioLook } from "./studio-looks.js";
import { resolveImageGenerationProvider } from "./image-generation/registry.js";
import { localGpuFromEnv, type LocalGpu } from "./local-gpu.js";
import { ImageGenerationError, type ImageGenerationProvider } from "./image-generation/types.js";

// Image generation. A request is saved as a pending row and answered at once;
// the picture is made in the background, stored as a company asset, and the
// row is marked completed or failed. Callers poll the row to see it finish.

/** A pending row older than this, with no job running here, was lost to a restart. */
export const GENERATED_IMAGE_STALE_AFTER_MS = 10 * 60_000;
const MAX_CONCURRENT_JOBS = 3;

type GeneratedImageRow = typeof generatedImages.$inferSelect;

export interface GeneratedImageActor {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId?: string | null;
}

export interface GeneratedImageServiceOptions {
  /** Defaults to reading the server environment on each request. */
  resolveProvider?: () => ImageGenerationProvider | null;
  /** This PC's graphics card through ComfyUI; defaults to GSAM_COMFYUI_URL. Null switches it off. */
  localGpu?: LocalGpu | null;
  now?: () => Date;
}

/** Settings that are passed to the image service but not kept on the row. */
interface RunExtras {
  seed?: number;
  negativePrompt?: string | null;
}

export interface GeneratedImageLinks {
  issue: { id: string; identifier: string | null; title: string } | null;
  organisation: { id: string; name: string } | null;
}

export function toGeneratedImage(row: GeneratedImageRow, links?: GeneratedImageLinks): GeneratedImage {
  return {
    id: row.id,
    companyId: row.companyId,
    prompt: row.prompt,
    aspectRatio: row.aspectRatio as ImageAspectRatio,
    style: (row.style as ImageStylePresetId | null) ?? null,
    camera: (row.camera as StudioCameraSettings | null) ?? null,
    provider: row.provider as ImageGenerationProviderId,
    model: row.model,
    status: row.status as GeneratedImageStatus,
    error: row.error,
    assetId: row.assetId,
    contentPath: row.status === "completed" && row.assetId ? `/api/assets/${row.assetId}/content` : null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    issue: links?.issue ?? null,
    organisation: links?.organisation ?? null,
    altText: imageAltText(row.prompt, row.style),
    issueCover: row.issueCover,
    organisationCover: row.organisationCover,
    favourite: row.favourite,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function extensionFor(contentType: string) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

/** A short, readable file name from the description, for downloads. */
export function filenameForPrompt(prompt: string, contentType: string) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${slug || "image"}.${extensionFor(contentType)}`;
}

// Jobs live in this process. The set lets list() tell a lost job from a slow one.
const activeJobs = new Set<string>();
const queuedJobs: Array<() => Promise<void>> = [];
let runningJobs = 0;

function schedule(job: () => Promise<void>) {
  queuedJobs.push(job);
  drain();
}

function drain() {
  while (runningJobs < MAX_CONCURRENT_JOBS && queuedJobs.length > 0) {
    const job = queuedJobs.shift()!;
    runningJobs += 1;
    void job().finally(() => {
      runningJobs -= 1;
      drain();
    });
  }
}

export function generatedImageService(db: Db, storage: StorageService, options: GeneratedImageServiceOptions = {}) {
  const resolveProvider = options.resolveProvider ?? (() => resolveImageGenerationProvider());
  const localGpu = options.localGpu === undefined ? localGpuFromEnv() : options.localGpu;
  const now = options.now ?? (() => new Date());

  /** The service a request asked for, or the default; throws a plain reason when it cannot be used. */
  async function pickProvider(input: { provider?: string; model?: string }): Promise<ImageGenerationProvider> {
    if (input.provider === "local") {
      const model = localImageModel(input.model ?? LOCAL_IMAGE_MODELS[0].id);
      if (!model) {
        throw unprocessable(`Pick a local model: ${LOCAL_IMAGE_MODELS.map((item) => item.id).join(" or ")}`, {
          code: "local_image_model_unknown",
        });
      }
      const local = localGpu ? await localGpu.status() : null;
      if (!localGpu || !local) {
        throw unprocessable("This PC's image server is not answering. Check that ComfyUI is running on the PC, then try again.", {
          code: "local_gpu_unavailable",
        });
      }
      if (!local.imageModels.includes(model.id)) {
        throw unprocessable(`${model.label} is not installed on this PC.`, { code: "local_image_model_missing" });
      }
      return localGpu.imageProvider(model.id);
    }
    const cloud = resolveProvider();
    if (input.provider) {
      if (cloud?.id === input.provider) return cloud;
      throw unprocessable("That image service is not set up. Ask your admin, or pick another model.", {
        code: "image_generation_not_configured",
      });
    }
    if (cloud) return cloud;
    const local = localGpu ? await localGpu.status() : null;
    const fallback = local?.imageModels[0];
    if (localGpu && fallback) return localGpu.imageProvider(fallback as "flux-schnell" | "sdxl");
    throw unprocessable("Image generation is not set up yet. Ask your admin to add an image service key.", {
      code: "image_generation_not_configured",
    });
  }

  async function finish(id: string, patch: Partial<typeof generatedImages.$inferInsert>) {
    const [row] = await db
      .update(generatedImages)
      .set({ ...patch, updatedAt: now(), completedAt: now() })
      .where(and(eq(generatedImages.id, id), eq(generatedImages.status, "pending")))
      .returning();
    return row ?? null;
  }

  async function run(row: GeneratedImageRow, provider: ImageGenerationProvider, extras: RunExtras = {}) {
    activeJobs.add(row.id);
    try {
      const result = await provider.generate({
        prompt: composeImagePrompt(row.prompt, row.style, row.camera as StudioCameraSettings | null),
        aspectRatio: row.aspectRatio as ImageAspectRatio,
        seed: extras.seed,
        negativePrompt: extras.negativePrompt,
        jobId: row.id,
      });
      const stored = await storage.putFile({
        companyId: row.companyId,
        namespace: "assets/generated-images",
        originalFilename: filenameForPrompt(row.prompt, result.image.contentType),
        contentType: result.image.contentType,
        body: result.image.bytes,
      });
      const [asset] = await db
        .insert(assets)
        .values({
          companyId: row.companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: row.createdByAgentId,
          createdByUserId: row.createdByUserId,
        })
        .returning();
      const finished = await finish(row.id, {
        status: "completed",
        assetId: asset!.id,
        providerRequestId: result.providerRequestId,
      });
      if (!finished) return;
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "image-generation",
        agentId: row.createdByAgentId,
        action: "generated_image.completed",
        entityType: "generated_image",
        entityId: row.id,
        details: { assetId: asset!.id, provider: row.provider, byteSize: stored.byteSize },
      });
    } catch (error) {
      const message =
        error instanceof ImageGenerationError
          ? error.message
          : "Something went wrong while making the image. Please try again.";
      if (!(error instanceof ImageGenerationError)) {
        logger.error({ err: error, generatedImageId: row.id }, "image generation failed unexpectedly");
      }
      const failed = await finish(row.id, { status: "failed", error: message }).catch((finishError) => {
        logger.error({ err: finishError, generatedImageId: row.id }, "could not record failed image generation");
        return null;
      });
      if (failed) {
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "image-generation",
          agentId: row.createdByAgentId,
          action: "generated_image.failed",
          entityType: "generated_image",
          entityId: row.id,
          details: {
            provider: row.provider,
            code: error instanceof ImageGenerationError ? error.code : "unexpected",
          },
        }).catch(() => undefined);
      }
    } finally {
      activeJobs.delete(row.id);
    }
  }

  /** Marks pending rows that no job here is working on, and that are old, as failed. */
  async function failLostJobs(companyId: string) {
    const cutoff = new Date(now().getTime() - GENERATED_IMAGE_STALE_AFTER_MS);
    const stale = await db
      .select({ id: generatedImages.id })
      .from(generatedImages)
      .where(
        and(
          eq(generatedImages.companyId, companyId),
          eq(generatedImages.status, "pending"),
          lt(generatedImages.createdAt, cutoff),
        ),
      );
    const lost = stale.map((row) => row.id).filter((id) => !activeJobs.has(id));
    if (lost.length === 0) return;
    await db
      .update(generatedImages)
      .set({
        status: "failed",
        error: "This image was interrupted before it finished. Please try again.",
        updatedAt: now(),
        completedAt: now(),
      })
      .where(and(inArray(generatedImages.id, lost), eq(generatedImages.status, "pending")));
  }

  /** Task and client names for a set of rows, in one query each. */
  async function loadLinks(rows: GeneratedImageRow[]): Promise<Map<string, GeneratedImageLinks>> {
    const issueIds = [...new Set(rows.map((row) => row.issueId).filter((id): id is string => !!id))];
    const organisationIds = [...new Set(rows.map((row) => row.organisationId).filter((id): id is string => !!id))];
    const [issueRows, organisationRows] = await Promise.all([
      issueIds.length
        ? db.select({ id: issues.id, identifier: issues.identifier, title: issues.title }).from(issues).where(inArray(issues.id, issueIds))
        : Promise.resolve([]),
      organisationIds.length
        ? db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, organisationIds))
        : Promise.resolve([]),
    ]);
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const organisationById = new Map(organisationRows.map((row) => [row.id, row]));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          issue: row.issueId ? issueById.get(row.issueId) ?? null : null,
          organisation: row.organisationId ? organisationById.get(row.organisationId) ?? null : null,
        },
      ]),
    );
  }

  async function withLinks(row: GeneratedImageRow) {
    const links = await loadLinks([row]);
    return toGeneratedImage(row, links.get(row.id));
  }

  /** A task or client named on a request must belong to the same company. */
  async function assertLinksInCompany(companyId: string, issueId: string | null, organisationId: string | null) {
    if (issueId) {
      const issue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw unprocessable("That task is not in this organisation", { code: "generated_image_issue_not_found" });
    }
    if (organisationId) {
      const organisation = await db
        .select({ id: organisations.id })
        .from(organisations)
        .where(and(eq(organisations.id, organisationId), eq(organisations.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!organisation) {
        throw unprocessable("That client is not in this organisation", { code: "generated_image_organisation_not_found" });
      }
    }
  }

  const service = {
    status: async () => ({ provider: resolveProvider(), local: localGpu ? await localGpu.status() : null }),

    create: async (companyId: string, input: CreateGeneratedImage, actor: GeneratedImageActor) => {
      const parsed = createGeneratedImageSchema.parse(input);
      const look = parsed.lookId ? await applyStudioLook(db, companyId, parsed.lookId, parsed) : null;
      if (look) Object.assign(parsed, { prompt: look.prompt, style: look.style, camera: look.camera });
      const issueId = parsed.issueId ?? null;
      const organisationId = parsed.organisationId ?? null;
      const provider = await pickProvider(parsed);
      await assertLinksInCompany(companyId, issueId, organisationId);
      await failLostJobs(companyId);
      const [{ pending }] = await db
        .select({ pending: count() })
        .from(generatedImages)
        .where(and(eq(generatedImages.companyId, companyId), eq(generatedImages.status, "pending")));
      if (Number(pending) >= GENERATED_IMAGES_MAX_PENDING_PER_COMPANY) {
        throw tooManyRequests(
          `${GENERATED_IMAGES_MAX_PENDING_PER_COMPANY} images are already being made. Wait for one to finish, then try again.`,
          { code: "image_generation_busy" },
        );
      }
      const [row] = await db
        .insert(generatedImages)
        .values({
          companyId,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          style: parsed.style ?? null,
          camera: hasStudioCamera(parsed.camera) ? parsed.camera : null,
          issueId,
          organisationId,
          provider: provider.id,
          model: provider.model,
          status: "pending",
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          createdAt: now(),
          updatedAt: now(),
        })
        .returning();
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId ?? null,
        action: "generated_image.requested",
        entityType: "generated_image",
        entityId: row!.id,
        details: {
          provider: provider.id,
          model: provider.model,
          aspectRatio: parsed.aspectRatio,
          style: parsed.style ?? null,
          camera: hasStudioCamera(parsed.camera) ? parsed.camera : null,
          lookId: look?.lookId ?? null,
          issueId,
          organisationId,
          ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
        },
      });
      // Counted as running from now, so a long wait in the queue is not taken for a lost job.
      activeJobs.add(row!.id);
      schedule(() => run(row!, provider, { seed: parsed.seed, negativePrompt: parsed.negativePrompt }));
      return withLinks(row!);
    },

    list: async (companyId: string, query: Partial<GeneratedImagesQuery> = {}): Promise<GeneratedImagesResponse> => {
      const { limit, offset, q, issueId, organisationId, favourite } = generatedImagesQuerySchema.parse(query);
      await failLostJobs(companyId);
      const filters: SQL[] = [eq(generatedImages.companyId, companyId)];
      if (q) filters.push(ilike(generatedImages.prompt, `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`));
      if (issueId) filters.push(eq(generatedImages.issueId, issueId));
      if (organisationId) filters.push(eq(generatedImages.organisationId, organisationId));
      if (favourite !== undefined) filters.push(eq(generatedImages.favourite, favourite));
      const where = and(...filters);
      const [rows, [{ total }]] = await Promise.all([
        db
          .select()
          .from(generatedImages)
          .where(where)
          .orderBy(desc(generatedImages.createdAt), desc(generatedImages.id))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(generatedImages).where(where),
      ]);
      const totalCount = Number(total);
      const links = await loadLinks(rows);
      return {
        images: rows.map((row) => toGeneratedImage(row, links.get(row.id))),
        total: totalCount,
        nextOffset: offset + rows.length < totalCount ? offset + rows.length : null,
      };
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(generatedImages)
        .where(eq(generatedImages.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },

    toResponse: withLinks,

    /**
     * Make a finished image the cover of its task or client card, or stop. A
     * task or client has at most one cover, so setting one clears the last.
     */
    setCover: async (row: GeneratedImageRow, patch: UpdateGeneratedImageCover) => {
      if (row.status !== "completed" || !row.assetId) {
        throw unprocessable("Only a finished image can be a cover", { code: "generated_image_not_ready" });
      }
      if (patch.issueCover && !row.issueId) {
        throw unprocessable("Link the image to a task before using it as the task's cover", { code: "generated_image_no_task" });
      }
      if (patch.organisationCover && !row.organisationId) {
        throw unprocessable("Link the image to a client before using it as the client's cover", {
          code: "generated_image_no_client",
        });
      }
      const updated = await db.transaction(async (tx) => {
        if (patch.issueCover && row.issueId) {
          await tx
            .update(generatedImages)
            .set({ issueCover: false })
            .where(and(eq(generatedImages.companyId, row.companyId), eq(generatedImages.issueId, row.issueId), eq(generatedImages.issueCover, true)));
        }
        if (patch.organisationCover && row.organisationId) {
          await tx
            .update(generatedImages)
            .set({ organisationCover: false })
            .where(
              and(
                eq(generatedImages.companyId, row.companyId),
                eq(generatedImages.organisationId, row.organisationId),
                eq(generatedImages.organisationCover, true),
              ),
            );
        }
        return tx
          .update(generatedImages)
          .set({
            ...(patch.issueCover !== undefined ? { issueCover: patch.issueCover } : {}),
            ...(patch.organisationCover !== undefined ? { organisationCover: patch.organisationCover } : {}),
            updatedAt: new Date(),
          })
          .where(eq(generatedImages.id, row.id))
          .returning()
          .then((rows) => rows[0]!);
      });
      return updated;
    },

    /** Star or unstar an image as a favourite. Only a finished image can be starred. */
    setFavourite: async (row: GeneratedImageRow, patch: UpdateGeneratedImageFavourite) => {
      if (patch.favourite && (row.status !== "completed" || !row.assetId)) {
        throw unprocessable("Only a finished image can be a favourite", { code: "generated_image_not_ready" });
      }
      return db
        .update(generatedImages)
        .set({ favourite: patch.favourite, updatedAt: new Date() })
        .where(eq(generatedImages.id, row.id))
        .returning()
        .then((rows) => rows[0] ?? row);
    },

    /** Every cover in the company, keyed by task id and by client id, for the boards. */
    covers: async (companyId: string): Promise<GeneratedImageCovers> => {
      const rows = await db
        .select()
        .from(generatedImages)
        .where(
          and(
            eq(generatedImages.companyId, companyId),
            eq(generatedImages.status, "completed"),
            or(eq(generatedImages.issueCover, true), eq(generatedImages.organisationCover, true)),
          ),
        );
      const result: GeneratedImageCovers = { issues: {}, organisations: {} };
      for (const row of rows) {
        if (!row.assetId) continue;
        const cover = { imageId: row.id, contentPath: `/api/assets/${row.assetId}/content`, altText: imageAltText(row.prompt, row.style) };
        if (row.issueCover && row.issueId) result.issues[row.issueId] = cover;
        if (row.organisationCover && row.organisationId) result.organisations[row.organisationId] = cover;
      }
      return result;
    },

    remove: async (id: string) => {
      const row = await db
        .select()
        .from(generatedImages)
        .where(eq(generatedImages.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Image not found");
      await db.delete(generatedImages).where(eq(generatedImages.id, id));
      if (row.assetId) {
        // An asset something else now points at (a logo, say) is kept.
        const asset = await db
          .delete(assets)
          .where(eq(assets.id, row.assetId))
          .returning()
          .then((rows) => rows[0] ?? null)
          .catch((error) => {
            logger.warn({ err: error, assetId: row.assetId }, "kept generated image asset that is still in use");
            return null;
          });
        if (asset) {
          await storage.deleteObject(asset.companyId, asset.objectKey).catch((error) => {
            logger.warn({ err: error, assetId: asset.id }, "could not remove stored generated image");
          });
        }
      }
      return row;
    },

    /**
     * Several takes on one brief at once: `count` copies, one per house look,
     * or one per storyboard shot. Every look and the pending cap are checked before any is made, so
     * a request either starts all of its pictures or none.
     */
    createVariations: async (companyId: string, input: CreateGeneratedImageVariations, actor: GeneratedImageActor) => {
      const { count: takes, lookIds, shots, ...request } = createGeneratedImageVariationsSchema.parse(input);
      const takesWanted = takes ?? shots?.length ?? 0;
      const looks: Array<string | null> = lookIds ?? Array.from({ length: takesWanted }, () => request.lookId ?? null);
      if (lookIds) {
        const found = await db
          .select({ id: studioLooks.id })
          .from(studioLooks)
          .where(and(eq(studioLooks.companyId, companyId), inArray(studioLooks.id, lookIds)));
        if (found.length !== lookIds.length) {
          throw unprocessable("That look is not in this organisation", { code: "studio_look_not_found" });
        }
      }
      await failLostJobs(companyId);
      const [{ pending }] = await db
        .select({ pending: count() })
        .from(generatedImages)
        .where(and(eq(generatedImages.companyId, companyId), eq(generatedImages.status, "pending")));
      if (Number(pending) + looks.length > GENERATED_IMAGES_MAX_PENDING_PER_COMPANY) {
        const free = Math.max(0, GENERATED_IMAGES_MAX_PENDING_PER_COMPANY - Number(pending));
        throw tooManyRequests(
          free === 0
            ? `${GENERATED_IMAGES_MAX_PENDING_PER_COMPANY} images are already being made. Wait for one to finish, then try again.`
            : `Only ${free} more ${free === 1 ? "image" : "images"} can start now. Ask for fewer, or wait for some to finish.`,
          { code: "image_generation_busy" },
        );
      }
      const images = [];
      for (const [index, lookId] of looks.entries()) {
        const prompt = shots ? composeStoryboardPrompt(shots[index]!, request.prompt) : request.prompt;
        // A named seed makes each version different but repeatable: seed, seed + 1, ...
        const seed = request.seed === undefined ? undefined : (request.seed + index) % (IMAGE_SEED_MAX + 1);
        images.push(await service.create(companyId, { ...request, prompt, lookId, seed }, actor));
      }
      return { images };
    },
  };
  return service;
}

/** Test hook: lets a test wait until every queued image job has settled. */
export async function waitForGeneratedImageJobs() {
  while (runningJobs > 0 || queuedJobs.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
