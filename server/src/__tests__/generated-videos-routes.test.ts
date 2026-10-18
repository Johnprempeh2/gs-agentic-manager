import request from "supertest";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { activityLog, assets, generatedImages, generatedVideos, issues } from "@greatstone/db";
import { expect, it } from "vitest";
import type { GeneratedVideo, GeneratedVideosResponse } from "@greatstone/shared";
import { generatedVideoRoutes } from "../routes/generated-videos.js";
import { waitForGeneratedVideoJobs } from "../services/generated-videos.js";
import { VideoGenerationError, type VideoGenerationInput, type VideoGenerationProvider } from "../services/video-generation/types.js";
import type { StorageService } from "../storage/types.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  type BoardActor,
} from "./helpers/route-test-harness.js";
import { useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: StorageService = {
    provider: "local_disk",
    putFile: async (input) => {
      const objectKey = `${input.companyId}/${input.namespace}/${objects.size}-${input.originalFilename}`;
      objects.set(objectKey, input.body);
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha",
        originalFilename: input.originalFilename,
      };
    },
    getObject: async (_companyId, objectKey) => ({ stream: Readable.from(objects.get(objectKey) ?? Buffer.alloc(0)) }),
    headObject: async () => ({ exists: false }),
    deleteObject: async (_companyId, objectKey) => {
      objects.delete(objectKey);
    },
  } as StorageService;
  return { storage, objects };
}

function provider(generate: VideoGenerationProvider["generate"]): VideoGenerationProvider {
  return { id: "higgsfield", generate };
}

describeEmbeddedPostgres("generated videos routes", () => {
  const ctx = useEmbeddedPostgres("gsam-generated-videos-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(generatedVideos);
      await db.delete(generatedImages);
      await db.delete(assets);
      await resetCompanyIssueFixtures(db);
    },
  });

  function app(actor: BoardActor, storage: StorageService, resolveProvider: () => VideoGenerationProvider | null) {
    return routeApp(ctx.db, actor, (db) => generatedVideoRoutes(db, storage, { resolveProvider }));
  }

  it("says when clips are off, and refuses to start one", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Videos off");
    const server = app(actor, memoryStorage().storage, () => null);
    const status = await request(server).get(`/api/companies/${companyId}/video-generation`);
    expect(status.body).toEqual({ configured: false, provider: null, providerLabel: null });
    const created = await request(server).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "Waves on rocks" });
    expect(created.status).toBe(422);
    expect(created.body.details.code).toBe("video_generation_not_configured");
  });

  it("makes a clip from words with motion and camera, and stores it as a company asset", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Videos on");
    const { storage, objects } = memoryStorage();
    const seen: VideoGenerationInput[] = [];
    const server = app(actor, storage, () =>
      provider(async (input) => {
        seen.push(input);
        return { video: { bytes: MP4, contentType: "video/mp4" }, providerRequestId: "vid-9" };
      }),
    );
    const [task] = await ctx.db.insert(issues).values({ companyId, title: "Launch teaser" }).returning();

    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "A sailing boat at sunset", model: "hailuo-2.3", duration: 10, motion: "drone", camera: { focalLength: 24 }, issueId: task!.id });
    expect(created.status).toBe(202);
    const pending = created.body as GeneratedVideo;
    expect(pending).toMatchObject({
      status: "pending",
      model: "hailuo-2.3",
      durationSeconds: 10,
      motion: "drone",
      camera: { focalLength: 24 },
      createdByUserId: userId,
      issue: { id: task!.id, title: "Launch teaser" },
      contentPath: null,
    });

    await waitForGeneratedVideoJobs();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt.startsWith("A sailing boat at sunset, aerial drone shot")).toBe(true);
    expect(seen[0]).toMatchObject({ model: "hailuo-2.3", durationSeconds: 10, sourceImage: null });

    const fetched = await request(server).get(`/api/generated-videos/${pending.id}`);
    expect(fetched.body.status).toBe("completed");
    const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, fetched.body.assetId));
    expect(asset).toMatchObject({ contentType: "video/mp4", originalFilename: "a-sailing-boat-at-sunset.mp4" });

    const list = await request(server).get(`/api/companies/${companyId}/generated-videos?q=sailing`);
    expect((list.body as GeneratedVideosResponse).videos.map((video) => video.id)).toEqual([pending.id]);
    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action).sort();
    expect(actions).toEqual(["generated_video.completed", "generated_video.requested"]);

    const removed = await request(server).delete(`/api/generated-videos/${pending.id}`);
    expect(removed.status).toBe(204);
    expect([...objects.keys()].some((key) => key.includes("generated-videos"))).toBe(false);
  });

  it("animates a finished studio image and refuses images that are not ready or not ours", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Videos animate");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Videos other");
    const { storage } = memoryStorage();
    const stored = await storage.putFile({ companyId, namespace: "assets/generated-images", originalFilename: "boat.png", contentType: "image/png", body: PNG });
    const [imageAsset] = await ctx.db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey: stored.objectKey, contentType: "image/png", byteSize: PNG.length, sha256: "x", originalFilename: "boat.png" })
      .returning();
    const [image] = await ctx.db
      .insert(generatedImages)
      .values({ companyId, prompt: "A red boat", aspectRatio: "16:9", provider: "mock", model: "practice", status: "completed", assetId: imageAsset!.id })
      .returning();
    const [pendingImage] = await ctx.db
      .insert(generatedImages)
      .values({ companyId, prompt: "Not yet", aspectRatio: "1:1", provider: "mock", model: "practice" })
      .returning();
    const [foreignImage] = await ctx.db
      .insert(generatedImages)
      .values({ companyId: other.companyId, prompt: "Theirs", aspectRatio: "1:1", provider: "mock", model: "practice", status: "completed" })
      .returning();
    const seen: VideoGenerationInput[] = [];
    const server = app(actor, storage, () =>
      provider(async (input) => {
        seen.push(input);
        return { video: { bytes: MP4, contentType: "video/mp4" }, providerRequestId: null };
      }),
    );

    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "The boat drifts", model: "kling-2.5-turbo-standard", sourceImageId: image!.id });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ durationSeconds: 5, sourceImage: { id: image!.id, contentPath: `/api/assets/${imageAsset!.id}/content`, altText: "A red boat" } });
    await waitForGeneratedVideoJobs();
    expect(seen[0]!.sourceImage).toEqual({ bytes: PNG, contentType: "image/png" });

    const notReady = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "Too soon", sourceImageId: pendingImage!.id });
    expect(notReady.body.details.code).toBe("generated_video_image_not_ready");
    const foreign = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "Sneaky", sourceImageId: foreignImage!.id });
    expect(foreign.body.details.code).toBe("generated_video_image_not_found");
    const imageOnly = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "No picture", model: "kling-2.5-turbo-standard" });
    expect(imageOnly.status).toBe(400);
  });

  it("records a plain reason when the service fails, and caps clips in progress", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Videos fail");
    const failing = app(actor, memoryStorage().storage, () =>
      provider(async () => {
        throw new VideoGenerationError("The Higgsfield account has run out of credits. Ask your admin to top it up.", "credits");
      }),
    );
    const created = await request(failing).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "Rain on a window" });
    await waitForGeneratedVideoJobs();
    const fetched = await request(failing).get(`/api/generated-videos/${created.body.id}`);
    expect(fetched.body).toMatchObject({ status: "failed", error: "The Higgsfield account has run out of credits. Ask your admin to top it up." });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = app(actor, memoryStorage().storage, () =>
      provider(async () => {
        await gate;
        return { video: { bytes: MP4, contentType: "video/mp4" }, providerRequestId: null };
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      expect((await request(slow).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: `Clip ${index}` })).status).toBe(202);
    }
    const fourth = await request(slow).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "One too many" });
    expect(fourth.status).toBe(429);
    release();
    await waitForGeneratedVideoJobs();
  });

  it("stars favourite clips, lists only them, and refuses an unfinished clip", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Videos favourites");
    let fail = false;
    const server = app(actor, memoryStorage().storage, () =>
      provider(async () => {
        if (fail) throw new VideoGenerationError("Higgsfield could not make this clip. Please try again.", "provider_error");
        return { video: { bytes: MP4, contentType: "video/mp4" }, providerRequestId: null };
      }),
    );
    const keeper = (await request(server).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "Waves on a pebble beach" })).body as GeneratedVideo;
    const other = (await request(server).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "Gulls over a harbour" })).body as GeneratedVideo;
    await waitForGeneratedVideoJobs();
    fail = true;
    const broken = (await request(server).post(`/api/companies/${companyId}/generated-videos`).send({ prompt: "Fog over the pier" })).body as GeneratedVideo;
    await waitForGeneratedVideoJobs();

    const starred = await request(server).patch(`/api/generated-videos/${keeper.id}/favourite`).send({ favourite: true });
    expect(starred.status).toBe(200);
    expect(starred.body).toMatchObject({ id: keeper.id, favourite: true });
    const favourites = await request(server).get(`/api/companies/${companyId}/generated-videos?favourite=true`);
    expect(favourites.body.videos.map((video: GeneratedVideo) => video.id)).toEqual([keeper.id]);
    const rest = await request(server).get(`/api/companies/${companyId}/generated-videos?favourite=false`);
    expect(rest.body.videos.map((video: GeneratedVideo) => video.id).sort()).toEqual([other.id, broken.id].sort());

    const notReady = await request(server).patch(`/api/generated-videos/${broken.id}/favourite`).send({ favourite: true });
    expect(notReady.status).toBe(422);
    expect(notReady.body.details.code).toBe("generated_video_not_ready");
    expect((await request(server).patch(`/api/generated-videos/${keeper.id}/favourite`).send({})).status).toBe(400);
    const unstarred = await request(server).patch(`/api/generated-videos/${keeper.id}/favourite`).send({ favourite: false });
    expect(unstarred.body.favourite).toBe(false);
  });

  it("keeps other companies out", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Videos mine");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Videos theirs");
    const [row] = await ctx.db
      .insert(generatedVideos)
      .values({ companyId: other.companyId, prompt: "Theirs", model: "hailuo-2.3", provider: "mock", durationSeconds: 6 })
      .returning();
    const server = app(actor, memoryStorage().storage, () => null);
    expect((await request(server).get(`/api/generated-videos/${row!.id}`)).status).toBe(404);
    expect((await request(server).get(`/api/companies/${other.companyId}/generated-videos`)).status).toBe(403);
    expect((await request(server).get(`/api/companies/${companyId}/generated-videos`)).body.total).toBe(0);
  });
});
