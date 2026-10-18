import { and, count, desc, eq, ilike, inArray, lt, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, generatedImages, generatedVideos, issues, organisations } from "@greatstone/db";
import {
  composeVideoPrompt,
  createGeneratedVideoSchema,
  generatedVideosQuerySchema,
  GENERATED_VIDEOS_MAX_PENDING_PER_COMPANY,
  hasStudioCamera,
  imageAltText,
  videoModel,
  type CreateGeneratedVideo,
  type GeneratedVideo,
  type GeneratedVideosQuery,
  type GeneratedVideosResponse,
  type GeneratedVideoStatus,
  type StudioCameraSettings,
  type UpdateGeneratedVideoFavourite,
  type VideoGenerationProviderId,
  type VideoModelId,
  type VideoMotionPresetId,
} from "@greatstone/shared";
import { notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { applyStudioLook } from "./studio-looks.js";
import type { GeneratedImageActor } from "./generated-images.js";
import { describeVideoGeneration, resolveVideoGenerationProvider } from "./video-generation/registry.js";
import {
  assertPlanCanSpend,
  describeHiggsfieldPlan,
  higgsfieldPlanResolver,
  pickStudioProvider,
  type HiggsfieldPlan,
  type ResolveHiggsfieldPlan,
} from "./image-generation/higgsfield-plan.js";
import { createHiggsfieldPlanVideoProvider, planClipCosts, planVideoParams } from "./video-generation/higgsfield-plan.js";
import { VideoGenerationError, type VideoGenerationProvider } from "./video-generation/types.js";
import { localGpuFromEnv, localGpuProgress, type LocalGpu } from "./local-gpu.js";

// Studio clips. As with images, a request is saved as a pending row and
// answered at once; the clip is made in the background, stored as a company
// asset, and the row is marked completed or failed. Callers poll the row.

/** A pending clip older than this, with no job running here, was lost to a restart. */
export const GENERATED_VIDEO_STALE_AFTER_MS = 30 * 60_000;
const MAX_CONCURRENT_JOBS = 2;
const SOURCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

type GeneratedVideoRow = typeof generatedVideos.$inferSelect;

export interface GeneratedVideoServiceOptions {
  resolveProvider?: () => VideoGenerationProvider | null;
  /** This PC's graphics card through ComfyUI; defaults to GSAM_COMFYUI_URL. Null switches it off. */
  localGpu?: LocalGpu | null;
  /** The company's connected Higgsfield plan; defaults to looking up its app connection. */
  resolvePlan?: ResolveHiggsfieldPlan;
  now?: () => Date;
}

interface VideoLinks {
  issue: { id: string; identifier: string | null; title: string } | null;
  organisation: { id: string; name: string } | null;
  sourceImage: { id: string; contentPath: string | null; altText: string } | null;
}

export function toGeneratedVideo(row: GeneratedVideoRow, links?: VideoLinks): GeneratedVideo {
  return {
    id: row.id,
    companyId: row.companyId,
    prompt: row.prompt,
    model: row.model as VideoModelId,
    provider: row.provider as VideoGenerationProviderId,
    durationSeconds: row.durationSeconds,
    motion: (row.motion as VideoMotionPresetId | null) ?? null,
    camera: (row.camera as StudioCameraSettings | null) ?? null,
    sourceImage: links?.sourceImage ?? null,
    status: row.status as GeneratedVideoStatus,
    error: row.error,
    assetId: row.assetId,
    contentPath: row.status === "completed" && row.assetId ? `/api/assets/${row.assetId}/content` : null,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    issue: links?.issue ?? null,
    organisation: links?.organisation ?? null,
    favourite: row.favourite,
    progress: row.status === "pending" && row.provider === "local" ? localGpuProgress(row.id) : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** A short, readable file name from the description, for downloads. */
export function videoFilenameForPrompt(prompt: string, contentType: string) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${slug || "clip"}.${contentType === "video/webm" ? "webm" : "mp4"}`;
}

async function readAll(stream: AsyncIterable<Buffer | Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new VideoGenerationError("That picture is too large to animate.", "rejected");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const activeJobs = new Set<string>();
/** Stops a clip that is waiting or being made, by row id. */
const jobControllers = new Map<string, AbortController>();
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

export function generatedVideoService(db: Db, storage: StorageService, options: GeneratedVideoServiceOptions = {}) {
  const resolveProvider = options.resolveProvider ?? (() => resolveVideoGenerationProvider());
  const localGpu = options.localGpu === undefined ? localGpuFromEnv() : options.localGpu;
  const resolvePlan = options.resolvePlan ?? higgsfieldPlanResolver(db);
  const now = options.now ?? (() => new Date());

  async function finish(id: string, patch: Partial<typeof generatedVideos.$inferInsert>) {
    const [row] = await db
      .update(generatedVideos)
      .set({ ...patch, updatedAt: now(), completedAt: now() })
      .where(and(eq(generatedVideos.id, id), eq(generatedVideos.status, "pending")))
      .returning();
    return row ?? null;
  }

  async function loadSourceImage(row: GeneratedVideoRow) {
    if (!row.sourceImageId) return null;
    const source = await db
      .select({ assetId: generatedImages.assetId })
      .from(generatedImages)
      .where(and(eq(generatedImages.id, row.sourceImageId), eq(generatedImages.companyId, row.companyId)))
      .then((rows) => rows[0] ?? null);
    const asset = source?.assetId
      ? await db.select().from(assets).where(eq(assets.id, source.assetId)).then((rows) => rows[0] ?? null)
      : null;
    if (!asset) throw new VideoGenerationError("The picture to animate has been deleted.", "rejected");
    const object = await storage.getObject(asset.companyId, asset.objectKey);
    return { bytes: await readAll(object.stream, SOURCE_IMAGE_MAX_BYTES), contentType: asset.contentType };
  }

  async function run(row: GeneratedVideoRow, provider: VideoGenerationProvider) {
    activeJobs.add(row.id);
    const signal = jobControllers.get(row.id)?.signal;
    try {
      if (signal?.aborted) return;
      const result = await provider.generate({
        prompt: composeVideoPrompt(row.prompt, row.motion, row.camera as StudioCameraSettings | null),
        model: row.model as VideoModelId,
        durationSeconds: row.durationSeconds,
        sourceImage: await loadSourceImage(row),
        jobId: row.id,
        signal,
      });
      const stored = await storage.putFile({
        companyId: row.companyId,
        namespace: "assets/generated-videos",
        originalFilename: videoFilenameForPrompt(row.prompt, result.video.contentType),
        contentType: result.video.contentType,
        body: result.video.bytes,
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
        actorId: "video-generation",
        agentId: row.createdByAgentId,
        action: "generated_video.completed",
        entityType: "generated_video",
        entityId: row.id,
        details: { assetId: asset!.id, provider: row.provider, model: row.model, byteSize: stored.byteSize },
      });
    } catch (error) {
      const message =
        error instanceof VideoGenerationError ? error.message : "Something went wrong while making the clip. Please try again.";
      if (!(error instanceof VideoGenerationError)) {
        logger.error({ err: error, generatedVideoId: row.id }, "video generation failed unexpectedly");
      }
      const failed = await finish(row.id, { status: "failed", error: message }).catch((finishError) => {
        logger.error({ err: finishError, generatedVideoId: row.id }, "could not record failed video generation");
        return null;
      });
      if (failed) {
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "video-generation",
          agentId: row.createdByAgentId,
          action: "generated_video.failed",
          entityType: "generated_video",
          entityId: row.id,
          details: { provider: row.provider, code: error instanceof VideoGenerationError ? error.code : "unexpected" },
        }).catch(() => undefined);
      }
    } finally {
      activeJobs.delete(row.id);
      jobControllers.delete(row.id);
    }
  }

  async function failLostJobs(companyId: string) {
    const cutoff = new Date(now().getTime() - GENERATED_VIDEO_STALE_AFTER_MS);
    const stale = await db
      .select({ id: generatedVideos.id })
      .from(generatedVideos)
      .where(and(eq(generatedVideos.companyId, companyId), eq(generatedVideos.status, "pending"), lt(generatedVideos.createdAt, cutoff)));
    const lost = stale.map((row) => row.id).filter((id) => !activeJobs.has(id));
    if (lost.length === 0) return;
    await db
      .update(generatedVideos)
      .set({ status: "failed", error: "This clip was interrupted before it finished. Please try again.", updatedAt: now(), completedAt: now() })
      .where(and(inArray(generatedVideos.id, lost), eq(generatedVideos.status, "pending")));
  }

  async function loadLinks(rows: GeneratedVideoRow[]): Promise<Map<string, VideoLinks>> {
    const ids = <K extends "issueId" | "organisationId" | "sourceImageId">(key: K) =>
      [...new Set(rows.map((row) => row[key]).filter((id): id is string => !!id))];
    const issueIds = ids("issueId");
    const organisationIds = ids("organisationId");
    const imageIds = ids("sourceImageId");
    const [issueRows, organisationRows, imageRows] = await Promise.all([
      issueIds.length
        ? db.select({ id: issues.id, identifier: issues.identifier, title: issues.title }).from(issues).where(inArray(issues.id, issueIds))
        : Promise.resolve([]),
      organisationIds.length
        ? db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, organisationIds))
        : Promise.resolve([]),
      imageIds.length
        ? db
            .select({ id: generatedImages.id, assetId: generatedImages.assetId, prompt: generatedImages.prompt, style: generatedImages.style })
            .from(generatedImages)
            .where(inArray(generatedImages.id, imageIds))
        : Promise.resolve([]),
    ]);
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const organisationById = new Map(organisationRows.map((row) => [row.id, row]));
    const imageById = new Map(
      imageRows.map((row) => [
        row.id,
        { id: row.id, contentPath: row.assetId ? `/api/assets/${row.assetId}/content` : null, altText: imageAltText(row.prompt, row.style) },
      ]),
    );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          issue: row.issueId ? issueById.get(row.issueId) ?? null : null,
          organisation: row.organisationId ? organisationById.get(row.organisationId) ?? null : null,
          sourceImage: row.sourceImageId ? imageById.get(row.sourceImageId) ?? null : null,
        },
      ]),
    );
  }

  async function withLinks(row: GeneratedVideoRow) {
    const links = await loadLinks([row]);
    return toGeneratedVideo(row, links.get(row.id));
  }

  async function assertLinksInCompany(companyId: string, input: { issueId: string | null; organisationId: string | null; sourceImageId: string | null }) {
    if (input.issueId) {
      const found = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!found) throw unprocessable("That task is not in this organisation", { code: "generated_video_issue_not_found" });
    }
    if (input.organisationId) {
      const found = await db
        .select({ id: organisations.id })
        .from(organisations)
        .where(and(eq(organisations.id, input.organisationId), eq(organisations.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!found) throw unprocessable("That client is not in this organisation", { code: "generated_video_organisation_not_found" });
    }
    if (input.sourceImageId) {
      const found = await db
        .select({ status: generatedImages.status, assetId: generatedImages.assetId })
        .from(generatedImages)
        .where(and(eq(generatedImages.id, input.sourceImageId), eq(generatedImages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!found) throw unprocessable("That image is not in this organisation", { code: "generated_video_image_not_found" });
      if (found.status !== "completed" || !found.assetId) {
        throw unprocessable("Wait for the image to finish before animating it", { code: "generated_video_image_not_ready" });
      }
    }
  }

  return {
    status: async (companyId: string) => {
      const envProvider = resolveProvider();
      const plan = await resolvePlan(companyId).catch((error) => {
        logger.warn({ err: error, companyId }, "could not read the Higgsfield plan connection");
        return null;
      });
      const local = localGpu ? await localGpu.status() : null;
      if (!plan) return describeVideoGeneration(envProvider, local);
      const [described, creditsPerClip] = await Promise.all([describeHiggsfieldPlan(plan), planClipCosts(plan.client)]);
      return describeVideoGeneration(envProvider, local, { ...described, creditsPerClip });
    },

    create: async (companyId: string, input: CreateGeneratedVideo, actor: GeneratedImageActor) => {
      const parsed = createGeneratedVideoSchema.parse(input);
      const look = parsed.lookId ? await applyStudioLook(db, companyId, parsed.lookId, parsed) : null;
      if (look) Object.assign(parsed, { prompt: look.prompt, camera: look.camera });
      const model = videoModel(parsed.model)!;
      const issueId = parsed.issueId ?? null;
      const organisationId = parsed.organisationId ?? null;
      const sourceImageId = parsed.sourceImageId ?? null;
      const isAgent = actor.actorType === "agent";
      let provider: VideoGenerationProvider | null;
      let picked: { provider: VideoGenerationProvider | null; plan: HiggsfieldPlan | null } = { provider: null, plan: null };
      if (model.provider === "local") {
        const local = localGpu ? await localGpu.status() : null;
        if (!localGpu || !local) {
          throw unprocessable("This PC's video server is not answering. Check that ComfyUI is running on the PC, then try again.", {
            code: "local_gpu_unavailable",
          });
        }
        if (!local.videoModels.includes(model.id)) {
          throw unprocessable(`${model.label} is not installed on this PC.`, { code: "local_video_model_missing" });
        }
        provider = localGpu.videoProvider();
      } else {
        let envProvider = resolveProvider();
        // Practice mode stands in for every model; a real service only for its own.
        if (envProvider && envProvider.id !== "mock" && envProvider.id !== model.provider) envProvider = null;
        const requested = parsed.provider === "local" ? undefined : parsed.provider;
        const plan = requested && requested !== "higgsfield_plan" ? null : await resolvePlan(companyId);
        picked = pickStudioProvider({
          requested,
          envProvider,
          plan,
          planProvider: (connected) => createHiggsfieldPlanVideoProvider(connected.client),
          isAgent,
          kind: "video",
        });
        provider = picked.provider;
        if (!provider && plan && isAgent) await assertPlanCanSpend(plan, isAgent, null);
      }
      if (!provider) {
        throw unprocessable("Video making is not set up yet. Ask your admin to add the Higgsfield key.", {
          code: "video_generation_not_configured",
        });
      }
      await assertLinksInCompany(companyId, { issueId, organisationId, sourceImageId });
      if (picked.plan) {
        const cost = await picked.plan.client.cost("generate_video", {
          ...planVideoParams(model.id, parsed.duration ?? model.durations[0]),
          prompt: "price check",
        });
        await assertPlanCanSpend(picked.plan, isAgent, cost);
      }
      await failLostJobs(companyId);
      const [{ pending }] = await db
        .select({ pending: count() })
        .from(generatedVideos)
        .where(and(eq(generatedVideos.companyId, companyId), eq(generatedVideos.status, "pending")));
      if (Number(pending) >= GENERATED_VIDEOS_MAX_PENDING_PER_COMPANY) {
        throw tooManyRequests(
          `${GENERATED_VIDEOS_MAX_PENDING_PER_COMPANY} clips are already being made. Wait for one to finish, then try again.`,
          { code: "video_generation_busy" },
        );
      }
      const camera = hasStudioCamera(parsed.camera) ? parsed.camera : null;
      const durationSeconds = parsed.duration ?? model.durations[0];
      const [row] = await db
        .insert(generatedVideos)
        .values({
          companyId,
          prompt: parsed.prompt,
          model: model.id,
          provider: provider.id,
          durationSeconds,
          motion: parsed.motion ?? null,
          camera,
          sourceImageId,
          issueId,
          organisationId,
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
        action: "generated_video.requested",
        entityType: "generated_video",
        entityId: row!.id,
        details: {
          lookId: look?.lookId ?? null,
          provider: provider.id,
          model: model.id,
          durationSeconds,
          motion: parsed.motion ?? null,
          camera,
          sourceImageId,
          issueId,
          organisationId,
        },
      });
      // Counted as running from now, so a long wait in the queue is not taken for a lost job.
      activeJobs.add(row!.id);
      jobControllers.set(row!.id, new AbortController());
      schedule(() => run(row!, provider));
      return withLinks(row!);
    },

    list: async (companyId: string, query: Partial<GeneratedVideosQuery> = {}): Promise<GeneratedVideosResponse> => {
      const { limit, offset, q, issueId, organisationId, favourite } = generatedVideosQuerySchema.parse(query);
      await failLostJobs(companyId);
      const filters: SQL[] = [eq(generatedVideos.companyId, companyId)];
      if (q) filters.push(ilike(generatedVideos.prompt, `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`));
      if (issueId) filters.push(eq(generatedVideos.issueId, issueId));
      if (organisationId) filters.push(eq(generatedVideos.organisationId, organisationId));
      if (favourite !== undefined) filters.push(eq(generatedVideos.favourite, favourite));
      const where = and(...filters);
      const [rows, [{ total }]] = await Promise.all([
        db.select().from(generatedVideos).where(where).orderBy(desc(generatedVideos.createdAt), desc(generatedVideos.id)).limit(limit).offset(offset),
        db.select({ total: count() }).from(generatedVideos).where(where),
      ]);
      const totalCount = Number(total);
      const links = await loadLinks(rows);
      return {
        videos: rows.map((row) => toGeneratedVideo(row, links.get(row.id))),
        total: totalCount,
        nextOffset: offset + rows.length < totalCount ? offset + rows.length : null,
      };
    },

    getById: async (id: string) =>
      db
        .select()
        .from(generatedVideos)
        .where(eq(generatedVideos.id, id))
        .then((rows) => rows[0] ?? null),

    toResponse: withLinks,

    /** Star or unstar a clip as a favourite. Only a finished clip can be starred. */
    setFavourite: async (row: typeof generatedVideos.$inferSelect, patch: UpdateGeneratedVideoFavourite) => {
      if (patch.favourite && (row.status !== "completed" || !row.assetId)) {
        throw unprocessable("Only a finished clip can be a favourite", { code: "generated_video_not_ready" });
      }
      return db
        .update(generatedVideos)
        .set({ favourite: patch.favourite, updatedAt: new Date() })
        .where(eq(generatedVideos.id, row.id))
        .returning()
        .then((rows) => rows[0] ?? row);
    },

    /** Stops a clip that is waiting or being made and marks it failed. A finished clip is left alone. */
    cancel: async (row: GeneratedVideoRow, cancelledBy: string) => {
      if (row.status !== "pending") {
        throw unprocessable("Only a clip that is still being made can be cancelled", { code: "generated_video_not_pending" });
      }
      const cancelled = await finish(row.id, { status: "failed", error: `Cancelled by ${cancelledBy}.` });
      jobControllers.get(row.id)?.abort();
      return cancelled ?? row;
    },

    remove: async (id: string) => {
      const row = await db
        .select()
        .from(generatedVideos)
        .where(eq(generatedVideos.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Clip not found");
      await db.delete(generatedVideos).where(eq(generatedVideos.id, id));
      if (row.assetId) {
        const asset = await db
          .delete(assets)
          .where(eq(assets.id, row.assetId))
          .returning()
          .then((rows) => rows[0] ?? null)
          .catch((error) => {
            logger.warn({ err: error, assetId: row.assetId }, "kept generated video asset that is still in use");
            return null;
          });
        if (asset) {
          await storage.deleteObject(asset.companyId, asset.objectKey).catch((error) => {
            logger.warn({ err: error, assetId: asset.id }, "could not remove stored generated video");
          });
        }
      }
      return row;
    },
  };
}

/** Test hook: lets a test wait until every queued clip job has settled. */
export async function waitForGeneratedVideoJobs() {
  while (runningJobs > 0 || queuedJobs.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
