import request from "supertest";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { activityLog, assets, generatedImages, generatedVideos, toolApplications, toolConnections } from "@greatstone/db";
import { expect, it, vi } from "vitest";
import { HIGGSFIELD_PLAN_URL, type GeneratedImage, type GeneratedVideo, type ImageGenerationStatus } from "@greatstone/shared";
import { generatedImageRoutes } from "../routes/generated-images.js";
import { generatedVideoRoutes } from "../routes/generated-videos.js";
import { generatedImageService, waitForGeneratedImageJobs } from "../services/generated-images.js";
import { waitForGeneratedVideoJobs } from "../services/generated-videos.js";
import { higgsfieldPlanResolver, type CallConnectionTool } from "../services/image-generation/higgsfield-plan.js";
import type { ImageGenerationProvider } from "../services/image-generation/types.js";
import type { StorageService } from "../storage/types.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
const JOB = "5f0c6a3e-2d1b-4c8e-9a7f-1b2c3d4e5f60";
const text = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage = {
    provider: "local_disk",
    putFile: async (input: { companyId: string; namespace: string; originalFilename: string; contentType: string; body: Buffer }) => {
      const objectKey = `${input.companyId}/${input.namespace}/${objects.size}-${input.originalFilename}`;
      objects.set(objectKey, input.body);
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.length, sha256: "sha", originalFilename: input.originalFilename };
    },
    getObject: async (_companyId: string, objectKey: string) => ({ stream: Readable.from(objects.get(objectKey) ?? Buffer.alloc(0)) }),
    headObject: async () => ({ exists: false }),
    deleteObject: async (_companyId: string, objectKey: string) => void objects.delete(objectKey),
  } as unknown as StorageService;
  return { storage, objects };
}

/** A mocked Higgsfield MCP connection with a plan balance. */
function mockPlanMcp(state: { credits: number }) {
  const calls: Array<{ toolName: string; arguments: Record<string, unknown>; connectionId: string }> = [];
  const callConnectionTool: CallConnectionTool = vi.fn(async (input) => {
    calls.push(input);
    const params = (input.arguments.params ?? {}) as Record<string, unknown>;
    switch (input.toolName) {
      case "balance":
        return text({ credits: state.credits, subscription_plan_type: "basic" });
      case "generate_image":
        return text({ cost: { credits: 1 } });
      case "generate_video":
        return text({ cost: { credits: params.model === "minimax_hailuo" ? 6 : 7.5 } });
      case "generate_image_batch":
      case "generate_video_batch":
        return text({ jobs: [{ index: 0, job_id: JOB }] });
      case "jobs_wait":
        return text({ jobs: [{ index: 0, job_id: JOB, status: "completed", result_url: "https://cdn.example/result" }], all_terminal: true });
      case "media_upload":
        return text({ uploads: [{ upload_url: "https://upload.example/put", media_id: "media-7" }] });
      case "media_confirm":
        return text({ ok: true });
      default:
        throw new Error(`unexpected tool ${input.toolName}`);
    }
  });
  return { calls, callConnectionTool };
}

function apiKeyProvider(): ImageGenerationProvider {
  return { id: "higgsfield", model: "higgsfield-ai/soul/standard", generate: async () => ({ image: { bytes: PNG, contentType: "image/png" }, providerRequestId: "api-1" }) };
}

describeEmbeddedPostgres("Higgsfield plan in the studio", () => {
  const ctx = useEmbeddedPostgres("gsam-higgsfield-plan-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(generatedVideos);
      await db.delete(generatedImages);
      await db.delete(assets);
      await db.delete(toolConnections);
      await db.delete(toolApplications);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function connectHiggsfield(companyId: string, status = "active") {
    const [application] = await ctx.db.insert(toolApplications).values({ companyId, name: `Higgsfield ${status}`, type: "mcp_http" }).returning();
    const [connection] = await ctx.db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name: "Higgsfield for the organization",
        uid: `higgsfield-${status}-${companyId}`,
        transport: "mcp_remote",
        authKind: "oauth",
        status: status as "active",
        enabled: true,
        config: { sourceTemplateKey: "higgsfield", url: "https://mcp.higgsfield.ai/mcp" },
      })
      .returning();
    return connection!;
  }

  function fetchResult(contentType: string, body: Buffer) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(body, { headers: { "content-type": contentType } }),
    );
  }

  function imageApp(actor: BoardActor, storage: StorageService, mcp: ReturnType<typeof mockPlanMcp>, env: ImageGenerationProvider | null) {
    const resolvePlan = higgsfieldPlanResolver(ctx.db, { callConnectionTool: mcp.callConnectionTool });
    return routeApp(ctx.db, actor, (db) => generatedImageRoutes(db, storage, { resolveProvider: () => env, resolvePlan }));
  }

  it("shows the plan only while the Higgsfield app is connected, with its credits and price", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Plan status");
    const mcp = mockPlanMcp({ credits: 312.75 });
    const server = imageApp(actor, memoryStorage().storage, mcp, apiKeyProvider());

    const before = await request(server).get(`/api/companies/${companyId}/image-generation`);
    expect(before.body).toMatchObject({ provider: "higgsfield" });
    expect(before.body.plan).toBeUndefined();

    await connectHiggsfield(companyId, "draft");
    expect((await request(server).get(`/api/companies/${companyId}/image-generation`)).body.plan).toBeUndefined();

    const connection = await connectHiggsfield(companyId);
    const after = (await request(server).get(`/api/companies/${companyId}/image-generation`)).body as ImageGenerationStatus;
    expect(after).toMatchObject({
      configured: true,
      provider: "higgsfield_plan",
      providerLabel: "Higgsfield (your plan)",
      model: "soul_2",
      plan: { connectionId: connection.id, credits: 312.75, planType: "basic", lowCredits: false, agentsMaySpend: false, creditsPerImage: 1, planUrl: HIGGSFIELD_PLAN_URL },
      alsoAvailable: { provider: "higgsfield", providerLabel: "Higgsfield" },
    });
    expect(mcp.calls.every((call) => call.connectionId === connection.id)).toBe(true);
  });

  it("makes the studio's image on the plan by default and stores it like any other", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Plan image");
    await connectHiggsfield(companyId);
    const mcp = mockPlanMcp({ credits: 40 });
    fetchResult("image/png", PNG);
    const server = imageApp(actor, memoryStorage().storage, mcp, apiKeyProvider());

    const status = await request(server).get(`/api/companies/${companyId}/image-generation`);
    expect(status.body.plan.lowCredits).toBe(true);

    const created = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "A lighthouse at dawn", aspectRatio: "16:9" });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ provider: "higgsfield_plan", model: "soul_2", status: "pending" });
    await waitForGeneratedImageJobs();

    const done = (await request(server).get(`/api/generated-images/${created.body.id}`)).body as GeneratedImage;
    expect(done).toMatchObject({ status: "completed", createdByUserId: userId });
    const [row] = await ctx.db.select().from(generatedImages).where(eq(generatedImages.id, done.id));
    expect(row!.providerRequestId).toBe(JOB);
    const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, done.assetId!));
    expect(asset).toMatchObject({ companyId, contentType: "image/png" });
    const submit = mcp.calls.find((call) => call.toolName === "generate_image_batch")!;
    expect(submit.arguments).toEqual({ requests: [{ index: 0, params: { model: "soul_2", prompt: "A lighthouse at dawn", aspect_ratio: "16:9", use_unlim: false } }] });

    // Versions run as separate plan jobs too, and can be starred.
    const versions = await request(server).post(`/api/companies/${companyId}/generated-images/variations`).send({ prompt: "A red kite", count: 2 });
    expect(versions.status).toBe(202);
    expect(versions.body.images.map((image: GeneratedImage) => image.provider)).toEqual(["higgsfield_plan", "higgsfield_plan"]);
    await waitForGeneratedImageJobs();
    const star = await request(server).patch(`/api/generated-images/${done.id}/favourite`).send({ favourite: true });
    expect(star.body.favourite).toBe(true);

    // The API key service stays available on request.
    const viaKey = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "A blue kite", provider: "higgsfield" });
    expect(viaKey.body.provider).toBe("higgsfield");
    await waitForGeneratedImageJobs();
    vi.restoreAllMocks();
  });

  it("refuses when the plan is out of credits, with the plan page", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Plan empty");
    await connectHiggsfield(companyId);
    const server = imageApp(actor, memoryStorage().storage, mockPlanMcp({ credits: 0 }), null);
    const created = await request(server).post(`/api/companies/${companyId}/generated-images`).send({ prompt: "A red bicycle" });
    expect(created.status).toBe(422);
    expect(created.body.details).toMatchObject({ code: "higgsfield_plan_no_credits", planUrl: HIGGSFIELD_PLAN_URL });
    expect(created.body.error).toContain(HIGGSFIELD_PLAN_URL);
    expect(await ctx.db.select().from(generatedImages)).toEqual([]);
  });

  it("keeps agents off the plan until the board allows it", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Plan agents");
    await connectHiggsfield(companyId);
    const mcp = mockPlanMcp({ credits: 312 });
    fetchResult("image/png", PNG);
    const storage = memoryStorage().storage;
    const resolvePlan = higgsfieldPlanResolver(ctx.db, { callConnectionTool: mcp.callConnectionTool });
    const agent = { actorType: "agent" as const, actorId: "agent-1", agentId: null, runId: null };

    const noKey = generatedImageService(ctx.db, storage, { resolveProvider: () => null, resolvePlan });
    await expect(noKey.create(companyId, { prompt: "Agent picture" }, agent)).rejects.toMatchObject({ details: { code: "higgsfield_plan_agents_off" } });
    const withKey = generatedImageService(ctx.db, storage, { resolveProvider: apiKeyProvider, resolvePlan });
    await expect(withKey.create(companyId, { prompt: "Agent picture" }, agent)).resolves.toMatchObject({ provider: "higgsfield" });
    await expect(withKey.create(companyId, { prompt: "Agent picture", provider: "higgsfield_plan" }, agent)).rejects.toMatchObject({
      details: { code: "higgsfield_plan_agents_off" },
    });

    const server = imageApp(actor, storage, mcp, null);
    const allowed = await request(server).patch(`/api/companies/${companyId}/higgsfield-plan`).send({ agentsMaySpend: true });
    expect(allowed.body).toEqual({ agentsMaySpend: true });
    expect((await request(server).get(`/api/companies/${companyId}/image-generation`)).body.plan.agentsMaySpend).toBe(true);
    await expect(noKey.create(companyId, { prompt: "Agent picture" }, agent)).resolves.toMatchObject({ provider: "higgsfield_plan" });
    await waitForGeneratedImageJobs();
    vi.restoreAllMocks();
  });

  it("only lets a board member change the setting, and only with the app connected", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Plan setting");
    const server = imageApp(actor, memoryStorage().storage, mockPlanMcp({ credits: 1 }), null);
    const missing = await request(server).patch(`/api/companies/${companyId}/higgsfield-plan`).send({ agentsMaySpend: true });
    expect(missing.status).toBe(422);
    expect(missing.body.details.code).toBe("higgsfield_plan_not_connected");
    const bad = await request(server).patch(`/api/companies/${companyId}/higgsfield-plan`).send({ agentsMaySpend: "yes" });
    expect(bad.status).toBe(400);
  });

  it("animates a studio image on the plan and stores the clip", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Plan clip");
    await connectHiggsfield(companyId);
    const mcp = mockPlanMcp({ credits: 312 });
    const { storage } = memoryStorage();
    const stored = await storage.putFile({ companyId, namespace: "assets/generated-images", originalFilename: "boat.png", contentType: "image/png", body: PNG });
    const [asset] = await ctx.db.insert(assets).values({ companyId, ...stored }).returning();
    const [image] = await ctx.db
      .insert(generatedImages)
      .values({ companyId, prompt: "A boat", aspectRatio: "16:9", provider: "higgsfield_plan", model: "soul_2", status: "completed", assetId: asset!.id })
      .returning();
    fetchResult("video/mp4", MP4);
    const resolvePlan = higgsfieldPlanResolver(ctx.db, { callConnectionTool: mcp.callConnectionTool });
    const server = routeApp(ctx.db, actor, (db) => generatedVideoRoutes(db, storage, { resolveProvider: () => null, resolvePlan }));

    const status = await request(server).get(`/api/companies/${companyId}/video-generation`);
    expect(status.body).toMatchObject({ provider: "higgsfield_plan", plan: { credits: 312, creditsPerClip: { "hailuo-2.3": { 6: 6, 10: 6 } } }, alsoAvailable: null });

    const created = await request(server)
      .post(`/api/companies/${companyId}/generated-videos`)
      .send({ prompt: "The boat drifts", model: "kling-2.5-turbo-standard", duration: 5, sourceImageId: image!.id });
    expect(created.status).toBe(202);
    await waitForGeneratedVideoJobs();
    const done = (await request(server).get(`/api/generated-videos/${created.body.id}`)).body as GeneratedVideo;
    expect(done).toMatchObject({ status: "completed", provider: "higgsfield_plan", model: "kling-2.5-turbo-standard" });
    const submit = mcp.calls.find((call) => call.toolName === "generate_video_batch")!;
    expect((submit.arguments.requests as Array<{ params: unknown }>)[0]!.params).toMatchObject({
      model: "kling3_0_turbo",
      resolution: "720p",
      duration: 5,
      medias: [{ role: "start_image", value: "media-7" }],
    });
    vi.restoreAllMocks();
  });
  it("calls a tool on the connection over MCP as the board, retrying once after an expired session", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Plan wire");
    const connection = await connectHiggsfield(companyId);
    await ctx.db.update(toolConnections).set({ authKind: "none" }).where(eq(toolConnections.id, connection.id));
    const seen: Array<{ method: string; session: string | null }> = [];
    let toolCalls = 0;
    const remoteHttpRequest = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      seen.push({ method: body.method, session: headers.get("mcp-session-id") });
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }), {
          headers: { "content-type": "application/json", "mcp-session-id": `s-${seen.length}` },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCalls += 1;
      if (toolCalls === 1) return new Response("gone", { status: 404 });
      expect(body.params).toEqual({ name: "balance", arguments: {} });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: text({ credits: 12 }) })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const service = toolAccessService(ctx.db, { remoteHttpRequest });
    const result = await service.callConnectionTool({ companyId, connectionId: connection.id, toolName: "balance", arguments: {} });
    expect(result).toEqual(text({ credits: 12 }));
    expect(seen.filter((entry) => entry.method === "tools/call")).toHaveLength(2);
    expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(2);

    // Another company cannot reach this connection.
    const other = await seedCompanyWithBoardAccess(ctx.db, "Plan wire other");
    await expect(
      service.callConnectionTool({ companyId: other.companyId, connectionId: connection.id, toolName: "balance", arguments: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
