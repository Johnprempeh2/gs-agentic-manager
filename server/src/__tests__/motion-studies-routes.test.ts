import request from "supertest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { activityLog, agents, assets, motionStudies } from "@greatstone/db";
import { expect, it } from "vitest";
import type { MotionStudiesResponse, MotionStudy } from "@greatstone/shared";
import { motionStudyRoutes } from "../routes/motion-studies.js";
import { companyService } from "../services/companies.js";
import type { StorageService } from "../storage/types.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  type BoardActor,
} from "./helpers/route-test-harness.js";
import { useEmbeddedPostgres } from "./helpers/route-test-harness.js";

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
    deleteObject: async () => {},
  } as StorageService;
  return { storage, objects };
}

const PAGE = "<!doctype html><title>Bedrock</title><canvas></canvas><script>/* strata */</script>";

function labStudy(overrides: Record<string, unknown> = {}) {
  return {
    number: "015",
    slug: "bedrock",
    title: "Bedrock",
    concept: "Immense strata drift almost imperceptibly.",
    theme: ["Background", "Text-safe", "Strata"],
    tech: "Canvas 2D",
    notes: "BACKGROUND CLASS. Heading 16.6:1, body 8.3:1.",
    studyDate: "2026-07-22",
    sourceUrl: "https://greatstone-animation-lab.netlify.app/anims/bedrock.html",
    html: PAGE,
    ...overrides,
  };
}

describeEmbeddedPostgres("motion studies routes", () => {
  const ctx = useEmbeddedPostgres("gsam-motion-studies-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(motionStudies);
      await db.delete(assets);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  function app(actor: BoardActor | Record<string, unknown>, storage: StorageService) {
    return routeApp(ctx.db, actor as BoardActor, (db) => motionStudyRoutes(db, storage));
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Prism", role: "designer", status: "idle", adapterType: "codex_local" });
    return { type: "agent", source: "agent_key", companyId, agentId, runId: null };
  }

  it("imports the Lab's studies once, keeps decisions on a second import, and marks text-safe from the theme", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion import");
    const server = app(actor, memoryStorage().storage);

    const first = await request(server)
      .post(`/api/companies/${companyId}/motion-studies/import`)
      .send({ studies: [labStudy(), labStudy({ number: "14", slug: "weave", title: "Weave", theme: ["Truchet"] })] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ created: 2, updated: 0 });

    const list = await request(server).get(`/api/companies/${companyId}/motion-studies`);
    const studies = (list.body as MotionStudiesResponse).studies;
    expect(studies.map((study) => [study.number, study.slug, study.textSafe, study.status, study.decision])).toEqual([
      ["015", "bedrock", true, "new", "undecided"],
      ["014", "weave", false, "new", "undecided"],
    ]);
    const bedrock = studies[0]!;
    expect(bedrock.previewPath).toBe(`/api/motion-studies/${bedrock.id}/preview`);

    await request(server).patch(`/api/motion-studies/${bedrock.id}`).send({ decision: "implement", status: "reviewed" }).expect(200);
    const second = await request(server)
      .post(`/api/companies/${companyId}/motion-studies/import`)
      .send({ studies: [labStudy({ concept: "Refreshed concept." })] });
    expect(second.body).toMatchObject({ created: 0, updated: 1 });
    const again = (second.body.studies as MotionStudy[])[0]!;
    expect(again).toMatchObject({ id: bedrock.id, concept: "Refreshed concept.", decision: "implement", status: "reviewed" });

    const textSafe = await request(server).get(`/api/companies/${companyId}/motion-studies?textSafe=true`);
    expect((textSafe.body as MotionStudiesResponse).studies.map((study) => study.slug)).toEqual(["bedrock"]);
  });

  it("serves the study page sandboxed with no network", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion preview");
    const server = app(actor, memoryStorage().storage);
    const created = await request(server).post(`/api/companies/${companyId}/motion-studies`).send(labStudy());
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const preview = await request(server).get((created.body as MotionStudy).previewPath!);
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    expect(preview.text).toBe(PAGE);
    const csp = preview.headers["content-security-policy"] as string;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("serves a study's poster and keeps it when a re-import sends none", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion poster");
    const server = app(actor, memoryStorage().storage);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

    const none = await request(server).post(`/api/companies/${companyId}/motion-studies`).send(labStudy({ slug: "weave" }));
    expect((none.body as MotionStudy).posterPath).toBeNull();
    await request(server).get(`/api/motion-studies/${(none.body as MotionStudy).id}/poster`).expect(404);

    const imported = await request(server)
      .post(`/api/companies/${companyId}/motion-studies/import`)
      .send({ studies: [labStudy({ poster: { contentType: "image/jpeg", dataBase64: jpeg.toString("base64") } })] });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const study = (imported.body.studies as MotionStudy[])[0]!;
    expect(study.posterPath).toBe(`/api/motion-studies/${study.id}/poster?v=${study.posterAssetId}`);

    const poster = await request(server).get(study.posterPath!).buffer(true);
    expect(poster.status).toBe(200);
    expect(poster.headers["content-type"]).toBe("image/jpeg");
    expect(poster.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(poster.body as Buffer, jpeg)).toBe(0);

    const again = await request(server).post(`/api/companies/${companyId}/motion-studies/import`).send({ studies: [labStudy()] });
    expect((again.body.studies as MotionStudy[])[0]!.posterAssetId).toBe(study.posterAssetId);

    const wrongType = await request(server)
      .post(`/api/companies/${companyId}/motion-studies/import`)
      .send({ studies: [labStudy({ poster: { contentType: "text/html", dataBase64: "PGI+" } })] });
    expect(wrongType.status).toBe(400);
  });

  it("numbers a new study after the highest, starts it New and Undecided, and refuses a taken slug", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion create");
    const storage = memoryStorage().storage;
    await request(app(actor, storage)).post(`/api/companies/${companyId}/motion-studies/import`).send({ studies: [labStudy({ number: "021", slug: "wake" })] });

    const agent = await seedAgent(companyId);
    const created = await request(app(agent, storage))
      .post(`/api/companies/${companyId}/motion-studies`)
      .send({ ...labStudy({ slug: "tide", title: "Tide", number: undefined }), source: "routine" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ number: "022", status: "new", decision: "undecided", source: "routine", createdByAgentId: agent.agentId });

    const taken = await request(app(agent, storage)).post(`/api/companies/${companyId}/motion-studies`).send(labStudy({ slug: "tide" }));
    expect(taken.status).toBe(409);
  });

  it("keeps an agent's Status and Decision as a proposal until a person accepts it", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion proposals");
    const storage = memoryStorage().storage;
    const board = app(actor, storage);
    const created = await request(board).post(`/api/companies/${companyId}/motion-studies`).send(labStudy());
    const studyId = (created.body as MotionStudy).id;

    const agent = await seedAgent(companyId);
    const proposed = await request(app(agent, storage))
      .patch(`/api/motion-studies/${studyId}`)
      .send({ decision: "implement", reason: "Text-safe and calm; fits the hero." });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body).toMatchObject({
      decision: "undecided",
      proposal: { decision: "implement", status: null, reason: "Text-safe and calm; fits the hero.", agentId: agent.agentId },
    });

    const agentResolve = await request(app(agent, storage)).post(`/api/motion-studies/${studyId}/proposal`).send({ accept: true });
    expect(agentResolve.status).toBe(403);

    const accepted = await request(board).post(`/api/motion-studies/${studyId}/proposal`).send({ accept: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ decision: "implement", proposal: null });

    await request(app(agent, storage)).patch(`/api/motion-studies/${studyId}`).send({ status: "archived" }).expect(200);
    const declined = await request(board).post(`/api/motion-studies/${studyId}/proposal`).send({ accept: false });
    expect(declined.body).toMatchObject({ status: "new", proposal: null });
  });

  it("keeps another agent's open Decision proposal when an agent proposes only Status", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion partial proposals");
    const storage = memoryStorage().storage;
    const created = await request(app(actor, storage)).post(`/api/companies/${companyId}/motion-studies`).send(labStudy());
    const studyId = (created.body as MotionStudy).id;

    const first = await seedAgent(companyId);
    const second = await seedAgent(companyId);
    await request(app(first, storage)).patch(`/api/motion-studies/${studyId}`).send({ decision: "maybe" }).expect(200);
    const both = await request(app(second, storage)).patch(`/api/motion-studies/${studyId}`).send({ status: "reviewed" });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body).toMatchObject({ proposal: { decision: "maybe", status: "reviewed", agentId: second.agentId } });
  });

  it("removes a company that has studies", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Motion company removal");
    await request(app(actor, memoryStorage().storage)).post(`/api/companies/${companyId}/motion-studies`).send(labStudy()).expect(201);

    const removed = await companyService(ctx.db).remove(companyId);
    expect(removed?.id).toBe(companyId);
    expect(await ctx.db.select().from(motionStudies)).toEqual([]);
  });

  it("brings agent imports in as New and Undecided whatever they ask for", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Motion agent import");
    const agent = await seedAgent(companyId);
    const res = await request(app(agent, memoryStorage().storage))
      .post(`/api/companies/${companyId}/motion-studies/import`)
      .send({ studies: [labStudy({ status: "approved", decision: "implement" })] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.studies[0]).toMatchObject({ status: "new", decision: "undecided", source: "lab_import" });
  });
});
