import { and, count, desc, eq, ilike, inArray, lt, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, generatedImages, issues, organisations } from "@greatstone/db";
import {
  composeImagePrompt,
  imageAltText,
  createGeneratedImageSchema,
  generatedImagesQuerySchema,
  GENERATED_IMAGES_MAX_PENDING_PER_COMPANY,
  type CreateGeneratedImage,
  type GeneratedImage,
  type GeneratedImagesQuery,
  type GeneratedImagesResponse,
  type GeneratedImageStatus,
  type ImageAspectRatio,
  type ImageGenerationProviderId,
  type ImageStylePresetId,
} from "@greatstone/shared";
import { notFound, tooManyRequests, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { resolveImageGenerationProvider } from "./image-generation/registry.js";
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
  now?: () => Date;
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
  const now = options.now ?? (() => new Date());

  async function finish(id: string, patch: Partial<typeof generatedImages.$inferInsert>) {
    const [row] = await db
      .update(generatedImages)
      .set({ ...patch, updatedAt: now(), completedAt: now() })
      .where(and(eq(generatedImages.id, id), eq(generatedImages.status, "pending")))
      .returning();
    return row ?? null;
  }

  async function run(row: GeneratedImageRow, provider: ImageGenerationProvider) {
    activeJobs.add(row.id);
    try {
      const result = await provider.generate({
        prompt: composeImagePrompt(row.prompt, row.style),
        aspectRatio: row.aspectRatio as ImageAspectRatio,
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

  return {
    status: () => resolveProvider(),

    create: async (companyId: string, input: CreateGeneratedImage, actor: GeneratedImageActor) => {
      const parsed = createGeneratedImageSchema.parse(input);
      const issueId = parsed.issueId ?? null;
      const organisationId = parsed.organisationId ?? null;
      const provider = resolveProvider();
      if (!provider) {
        throw unprocessable("Image generation is not set up yet. Ask your admin to add an image service key.", {
          code: "image_generation_not_configured",
        });
      }
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
          issueId,
          organisationId,
        },
      });
      schedule(() => run(row!, provider));
      return withLinks(row!);
    },

    list: async (companyId: string, query: Partial<GeneratedImagesQuery> = {}): Promise<GeneratedImagesResponse> => {
      const { limit, offset, q, issueId, organisationId } = generatedImagesQuerySchema.parse(query);
      await failLostJobs(companyId);
      const filters: SQL[] = [eq(generatedImages.companyId, companyId)];
      if (q) filters.push(ilike(generatedImages.prompt, `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`));
      if (issueId) filters.push(eq(generatedImages.issueId, issueId));
      if (organisationId) filters.push(eq(generatedImages.organisationId, organisationId));
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
  };
}

/** Test hook: lets a test wait until every queued image job has settled. */
export async function waitForGeneratedImageJobs() {
  while (runningJobs > 0 || queuedJobs.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
