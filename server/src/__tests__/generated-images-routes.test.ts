import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, assets, generatedImages, issues, organisations } from "@greatstone/db";
import { expect, it } from "vitest";
import {
  IMAGE_STYLE_PRESETS,
  studioCameraWords,
  type GeneratedImage,
  type GeneratedImagesResponse,
  type StudioCameraSettings,
} from "@greatstone/shared";
import { generatedImageRoutes } from "../routes/generated-images.js";
import { waitForGeneratedImageJobs } from "../services/generated-images.js";
import { ImageGenerationError, type ImageGenerationProvider } from "../services/image-generation/types.js";
import type { StorageService } from "../storage/types.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  type BoardActor,
} from "./helpers/route-test-harness.js";
import { useEmbeddedPostgres } from "./helpers/route-test-harness.js";

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
    getObject: async () => {
      throw new Error("not used");
    },
    headObject: async () => ({ exists: false }),
    deleteObject: async (_companyId, objectKey) => {
      objects.delete(objectKey);
    },
  } as StorageService;
  return { storage, objects };
}

function provider(generate: ImageGenerationProvider["generate"]): ImageGenerationProvider {
  return { id: "higgsfield", model: "higgsfield-ai/soul/standard", generate };
}

describeEmbeddedPostgres("generated images routes", () => {
  const ctx = useEmbeddedPostgres("gsam-generated-images-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(generatedImages);
      await db.delete(assets);
      await resetCompanyIssueFixtures(db);
    },
  });

  function app(actor: BoardActor, storage: StorageService, resolveProvider: () => ImageGenerationProvider | null) {
    return routeApp(ctx.db, actor, (db) => generatedImageRoutes(db, storage, { resolveProvider }));
  }

  it("says when no image service is set up, and refuses to start one", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Images off");
    const { storage } = memoryStorage();
    const server = app(actor, storage, () => null);

    const status = await request(server).get(`/api/companies/${companyId}/image-generation`);
    expect(status.body).toEqual({ configured: false, provider: null, providerLabel: null, model: null });

    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A red bicycle" });
    expect(created.status).toBe(422);
    expect(created.body.details.code).toBe("image_generation_not_configured");
  });

  it("makes an image in the background and stores it as a company asset", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Images on");
    const { storage, objects } = memoryStorage();
    const seen: unknown[] = [];
    const server = app(actor, storage, () =>
      provider(async (input) => {
        seen.push(input);
        return { image: { bytes: PNG, contentType: "image/png" }, providerRequestId: "req-9" };
      }),
    );

    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "  A lighthouse at dawn, watercolour ", aspectRatio: "16:9" });
    expect(created.status).toBe(202);
    const pending = created.body as GeneratedImage;
    expect(pending).toMatchObject({ status: "pending", prompt: "A lighthouse at dawn, watercolour", aspectRatio: "16:9", createdByUserId: userId, contentPath: null, altText: "A lighthouse at dawn, watercolour" });

    await waitForGeneratedImageJobs();
    expect(seen).toEqual([{ prompt: "A lighthouse at dawn, watercolour", aspectRatio: "16:9" }]);

    const fetched = await request(server).get(`/api/generated-images/${pending.id}`);
    expect(fetched.body.status).toBe("completed");
    expect(fetched.body.contentPath).toBe(`/api/assets/${fetched.body.assetId}/content`);
    const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, fetched.body.assetId));
    expect(asset).toMatchObject({ companyId, contentType: "image/png", originalFilename: "a-lighthouse-at-dawn-watercolour.png", createdByUserId: userId });
    expect(objects.size).toBe(1);

    const list = await request(server).get(`/api/companies/${companyId}/generated-images`);
    expect((list.body as GeneratedImagesResponse).images.map((image) => image.id)).toEqual([pending.id]);

    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action).sort();
    expect(actions).toEqual(["generated_image.completed", "generated_image.requested"]);

    const removed = await request(server).delete(`/api/generated-images/${pending.id}`);
    expect(removed.status).toBe(204);
    expect(objects.size).toBe(0);
    expect(await ctx.db.select().from(assets)).toHaveLength(0);
  });

  it("adds the style guidance for the provider, links the task and client, and searches", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Images styled");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Images other");
    const [task] = await ctx.db.insert(issues).values({ companyId, title: "Spring campaign deck" }).returning();
    const [client] = await ctx.db.insert(organisations).values({ companyId, name: "Ethical Quest" }).returning();
    const [otherTask] = await ctx.db.insert(issues).values({ companyId: other.companyId, title: "Not yours" }).returning();
    const { storage } = memoryStorage();
    const seen: string[] = [];
    const server = app(actor, storage, () =>
      provider(async (input) => {
        seen.push(input.prompt);
        return { image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null };
      }),
    );

    const styled = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A mountain path at sunrise", style: "greatstone-brand", issueId: task!.id, organisationId: client!.id });
    expect(styled.status).toBe(202);
    expect(styled.body).toMatchObject({
      prompt: "A mountain path at sunrise",
      style: "greatstone-brand",
      issue: { id: task!.id, title: "Spring campaign deck" },
      organisation: { id: client!.id, name: "Ethical Quest" },
    });
    await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "Office plants by a window" });
    await waitForGeneratedImageJobs();

    const brand = IMAGE_STYLE_PRESETS.find((preset) => preset.id === "greatstone-brand")!;
    expect(seen).toContain(`A mountain path at sunrise. ${brand.guidance}`);
    expect(seen).toContain("Office plants by a window");

    const search = await request(server).get(`/api/companies/${companyId}/generated-images?q=MOUNTAIN`);
    expect((search.body as GeneratedImagesResponse).images.map((image) => image.prompt)).toEqual(["A mountain path at sunrise"]);
    const byTask = await request(server).get(`/api/companies/${companyId}/generated-images?issueId=${task!.id}`);
    expect((byTask.body as GeneratedImagesResponse).total).toBe(1);
    const byClient = await request(server).get(`/api/companies/${companyId}/generated-images?organisationId=${client!.id}`);
    expect((byClient.body as GeneratedImagesResponse).images[0]?.organisation?.name).toBe("Ethical Quest");
    const wildcard = await request(server).get(`/api/companies/${companyId}/generated-images?q=%25`);
    expect((wildcard.body as GeneratedImagesResponse).total).toBe(0);

    const foreign = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "Sneaky", issueId: otherTask!.id });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details.code).toBe("generated_image_issue_not_found");

    const badStyle = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "Anything", style: "neon-cyberpunk" });
    expect(badStyle.status).toBe(400);
  });

  it("keeps the camera picks and sends their wording to the provider", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Images camera");
    const { storage } = memoryStorage();
    const seen: string[] = [];
    const server = app(actor, storage, () =>
      provider(async (input) => {
        seen.push(input.prompt);
        return { image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null };
      }),
    );

    const camera = { camera: "16mm-film", lens: "vintage-prime", focalLength: 50, aperture: "f4" };
    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A jazz trio in a smoky bar", camera });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ prompt: "A jazz trio in a smoky bar", camera });
    const plain = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A quiet library", camera: {} });
    expect(plain.body.camera).toBeNull();
    await waitForGeneratedImageJobs();

    expect(seen).toContain(`A jazz trio in a smoky bar, ${studioCameraWords(camera as StudioCameraSettings)}`);
    expect(seen).toContain("A quiet library");
    const fetched = await request(server).get(`/api/generated-images/${created.body.id}`);
    expect(fetched.body.camera).toEqual(camera);
    const [requested] = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    expect(requested?.details).toMatchObject({ camera });

    const bad = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "Anything", camera: { focalLength: 40 } });
    expect(bad.status).toBe(400);
  });

  it("uses an image as the cover of its task or client, one cover each", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Images covers");
    const [task] = await ctx.db.insert(issues).values({ companyId, title: "Launch deck" }).returning();
    const [client] = await ctx.db.insert(organisations).values({ companyId, name: "Acme" }).returning();
    const { storage } = memoryStorage();
    const server = app(actor, storage, () =>
      provider(async () => ({ image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null })),
    );
    const make = async (prompt: string, links: Record<string, string>) =>
      (await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt, ...links })).body as GeneratedImage;
    const first = await make("Rocket on a launch pad, no text", { issueId: task!.id, organisationId: client!.id });
    const second = await make("Rocket in orbit", { issueId: task!.id });
    const loose = await make("Office plants", {});
    await waitForGeneratedImageJobs();

    const setFirst = await request(server).patch(`/api/generated-images/${first.id}/cover`).send({ issueCover: true, organisationCover: true });
    expect(setFirst.status).toBe(200);
    expect(setFirst.body).toMatchObject({ issueCover: true, organisationCover: true });

    const swap = await request(server).patch(`/api/generated-images/${second.id}/cover`).send({ issueCover: true });
    expect(swap.status).toBe(200);
    const covers = await request(server).get(`/api/companies/${companyId}/generated-images/covers`);
    expect(covers.status).toBe(200);
    expect(covers.body.issues[task!.id]).toMatchObject({ imageId: second.id, altText: "Rocket in orbit" });
    expect(covers.body.organisations[client!.id]).toMatchObject({ imageId: first.id, altText: "Rocket on a launch pad" });
    const refetched = await request(server).get(`/api/generated-images/${first.id}`);
    expect(refetched.body).toMatchObject({ issueCover: false, organisationCover: true });

    const noLink = await request(server).patch(`/api/generated-images/${loose.id}/cover`).send({ issueCover: true });
    expect(noLink.status).toBe(422);
    expect(noLink.body.details.code).toBe("generated_image_no_task");
    const empty = await request(server).patch(`/api/generated-images/${loose.id}/cover`).send({});
    expect(empty.status).toBe(400);

    const cleared = await request(server).patch(`/api/generated-images/${first.id}/cover`).send({ organisationCover: false });
    expect(cleared.body.organisationCover).toBe(false);
    const after = await request(server).get(`/api/companies/${companyId}/generated-images/covers`);
    expect(after.body.organisations).toEqual({});
    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "generated_image.cover_changed"));
    expect(logged).toHaveLength(3);
  });

  it("records a plain reason when the provider fails", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Images fail");
    const { storage } = memoryStorage();
    const server = app(actor, storage, () =>
      provider(async () => {
        throw new ImageGenerationError("The Higgsfield account has run out of credits. Ask your admin to top it up.", "credits");
      }),
    );
    const created = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "Team photo" });
    await waitForGeneratedImageJobs();
    const fetched = await request(server).get(`/api/generated-images/${created.body.id}`);
    expect(fetched.body).toMatchObject({ status: "failed", error: expect.stringContaining("run out of credits"), contentPath: null });
  });

  it("keeps other companies out and validates the description", async () => {
    const first = await seedCompanyWithBoardAccess(ctx.db, "First");
    const second = await seedCompanyWithBoardAccess(ctx.db, "Second");
    const { storage } = memoryStorage();
    const ok = () => provider(async () => ({ image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null }));
    const created = await request(app(first.actor, storage, ok))
      .post(`/api/companies/${first.companyId}/generated-images`)
      .send({ prompt: "Private picture" });
    await waitForGeneratedImageJobs();

    const outsider = app(second.actor, storage, ok);
    expect((await request(outsider).get(`/api/generated-images/${created.body.id}`)).status).toBe(404);
    expect((await request(outsider).get(`/api/companies/${first.companyId}/generated-images`)).status).toBe(403);

    const tooShort = await request(app(first.actor, storage, ok))
      .post(`/api/companies/${first.companyId}/generated-images`)
      .send({ prompt: "x" });
    expect(tooShort.status).toBe(400);
  });

  it("caps how many images one company can have in progress", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Busy");
    const { storage } = memoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = app(actor, storage, () =>
      provider(async () => {
        await gate;
        return { image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null };
      }),
    );
    for (let index = 0; index < 6; index += 1) {
      const response = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: `Picture ${index}` });
      expect(response.status).toBe(202);
    }
    const seventh = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "One too many" });
    expect(seventh.status).toBe(429);
    release();
    await waitForGeneratedImageJobs();
  });
});
