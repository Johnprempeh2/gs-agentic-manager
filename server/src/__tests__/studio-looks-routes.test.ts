import request from "supertest";
import { Router } from "express";
import { activityLog, assets, generatedImages, studioLooks } from "@greatstone/db";
import { expect, it } from "vitest";
import type { StudioLook } from "@greatstone/shared";
import { generatedImageRoutes } from "../routes/generated-images.js";
import { studioLookRoutes } from "../routes/studio-looks.js";
import { waitForGeneratedImageJobs } from "../services/generated-images.js";
import type { ImageGenerationInput, ImageGenerationProvider } from "../services/image-generation/types.js";
import type { StorageService } from "../storage/types.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const storage = {
  provider: "local_disk",
  putFile: async (input) => ({
    provider: "local_disk",
    objectKey: `${input.companyId}/${crypto.randomUUID()}/${input.originalFilename}`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "sha",
    originalFilename: input.originalFilename,
  }),
  deleteObject: async () => undefined,
} as StorageService;

describeEmbeddedPostgres("studio looks routes", () => {
  const ctx = useEmbeddedPostgres("gsam-studio-looks-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(generatedImages);
      await db.delete(assets);
      await db.delete(studioLooks);
      await resetCompanyIssueFixtures(db);
    },
  });

  function app(actor: BoardActor, seen: ImageGenerationInput[] = []) {
    const imageProvider: ImageGenerationProvider = {
      id: "higgsfield",
      model: "soul",
      generate: async (input) => {
        seen.push(input);
        return { image: { bytes: PNG, contentType: "image/png" }, providerRequestId: null };
      },
    };
    return routeApp(ctx.db, actor, (db) => {
      const router = Router();
      router.use(studioLookRoutes(db));
      router.use(generatedImageRoutes(db, storage, { resolveProvider: () => imageProvider }));
      return router;
    });
  }

  it("saves, lists, renames and deletes a look, refusing a name already in use", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Looks crud");
    const server = app(actor);

    const created = await request(server)
      .post(`/api/companies/${companyId}/studio-looks`)
      .send({ name: "Brand hero", style: "photo", camera: { lens: "warm-cinema-prime", focalLength: 50 }, words: "warm golden light, navy and gold" });
    expect(created.status).toBe(201);
    const look = created.body as StudioLook;
    expect(look).toMatchObject({ name: "Brand hero", style: "photo", camera: { lens: "warm-cinema-prime", focalLength: 50 } });

    const clash = await request(server).post(`/api/companies/${companyId}/studio-looks`).send({ name: "brand HERO" });
    expect(clash.status).toBe(409);

    const renamed = await request(server).patch(`/api/studio-looks/${look.id}`).send({ name: "Brand hero 2", camera: {} });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Brand hero 2", camera: null, words: "warm golden light, navy and gold" });

    const list = await request(server).get(`/api/companies/${companyId}/studio-looks`);
    expect(list.body.looks.map((item: StudioLook) => item.name)).toEqual(["Brand hero 2"]);

    expect((await request(server).delete(`/api/studio-looks/${look.id}`)).status).toBe(204);
    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action).sort();
    expect(actions).toEqual(["studio_look.created", "studio_look.deleted", "studio_look.updated"]);
  });

  it("fills in an image request from a look, letting the request's own picks win", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Looks apply");
    const seen: ImageGenerationInput[] = [];
    const server = app(actor, seen);
    const look = (
      await request(server)
        .post(`/api/companies/${companyId}/studio-looks`)
        .send({ name: "Product", style: "photo", camera: { camera: "large-format", aperture: "f11" }, words: "on a white marble plinth" })
    ).body as StudioLook;

    const plain = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A bottle of olive oil.", lookId: look.id });
    expect(plain.status).toBe(202);
    expect(plain.body).toMatchObject({ style: "photo", camera: { camera: "large-format", aperture: "f11" } });
    expect(plain.body.prompt).toBe("A bottle of olive oil, on a white marble plinth");

    const own = await request(server)
      .post(`/api/companies/${companyId}/generated-images`)
      .send({ prompt: "A jar of honey", lookId: look.id, style: "illustration", camera: { lens: "extreme-macro" } });
    expect(own.body).toMatchObject({ style: "illustration", camera: { lens: "extreme-macro" } });

    await waitForGeneratedImageJobs();
    expect(seen[0]!.prompt).toContain("premium large-format digital cinema camera");
    expect(seen[0]!.prompt).toContain("on a white marble plinth");
  });

  it("keeps looks inside their company", async () => {
    const mine = await seedCompanyWithBoardAccess(ctx.db, "Looks mine");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Looks other");
    const theirLook = (
      await request(app(other.actor)).post(`/api/companies/${other.companyId}/studio-looks`).send({ name: "Secret" })
    ).body as StudioLook;

    const server = app(mine.actor);
    expect((await request(server).get(`/api/studio-looks/${theirLook.id}`)).status).toBe(404);
    expect((await request(server).delete(`/api/studio-looks/${theirLook.id}`)).status).toBe(404);
    const borrowed = await request(server)
      .post(`/api/companies/${mine.companyId}/generated-images`)
      .send({ prompt: "A red kite", lookId: theirLook.id });
    expect(borrowed.status).toBe(422);
    expect(borrowed.body.details.code).toBe("studio_look_not_found");
  });

  it("makes several takes at once, one per look, and refuses a batch that would not fit", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Looks variations");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Looks variations other");
    const seen: ImageGenerationInput[] = [];
    const server = app(actor, seen);
    const warm = (await request(server).post(`/api/companies/${companyId}/studio-looks`).send({ name: "Warm", words: "golden hour" })).body as StudioLook;
    const cool = (await request(server).post(`/api/companies/${companyId}/studio-looks`).send({ name: "Cool", words: "blue dusk" })).body as StudioLook;
    const theirs = (await request(app(other.actor)).post(`/api/companies/${other.companyId}/studio-looks`).send({ name: "Theirs" })).body as StudioLook;

    const compared = await request(server)
      .post(`/api/companies/${companyId}/generated-images/variations`)
      .send({ prompt: "A lighthouse", lookIds: [warm.id, cool.id] });
    expect(compared.status).toBe(202);
    expect(compared.body.images.map((image: { prompt: string }) => image.prompt)).toEqual([
      "A lighthouse, golden hour",
      "A lighthouse, blue dusk",
    ]);

    const copies = await request(server).post(`/api/companies/${companyId}/generated-images/variations`).send({ prompt: "A fox", count: 3 });
    expect(copies.status).toBe(202);
    expect(copies.body.images).toHaveLength(3);
    await waitForGeneratedImageJobs();

    const storyboard = await request(server)
      .post(`/api/companies/${companyId}/generated-images/variations`)
      .send({ prompt: "Acme coffee on a rainy London morning", lookId: warm.id, shots: ["A barista pours.", "A commuter sips at the window"] });
    expect(storyboard.status).toBe(202);
    expect(storyboard.body.images.map((image: { prompt: string }) => image.prompt)).toEqual([
      "A barista pours. Acme coffee on a rainy London morning, golden hour",
      "A commuter sips at the window. Acme coffee on a rainy London morning, golden hour",
    ]);
    await waitForGeneratedImageJobs();

    const both = await request(server)
      .post(`/api/companies/${companyId}/generated-images/variations`)
      .send({ prompt: "A fox", count: 2, shots: ["One shot", "Two shot"] });
    expect(both.status).toBe(400);

    const borrowed = await request(server)
      .post(`/api/companies/${companyId}/generated-images/variations`)
      .send({ prompt: "A fox", lookIds: [warm.id, theirs.id] });
    expect(borrowed.status).toBe(422);
    expect(borrowed.body.details.code).toBe("studio_look_not_found");

    await ctx.db.insert(generatedImages).values(
      Array.from({ length: 4 }, () => ({ companyId, prompt: "Busy", aspectRatio: "1:1", provider: "higgsfield", model: "soul", status: "pending" })),
    );
    const before = (await ctx.db.select().from(generatedImages)).length;
    const crowded = await request(server).post(`/api/companies/${companyId}/generated-images/variations`).send({ prompt: "A fox", count: 3 });
    expect(crowded.status).toBe(429);
    expect(crowded.body.error).toContain("Only 2 more images can start now");
    expect((await ctx.db.select().from(generatedImages)).length).toBe(before);
  });
});
