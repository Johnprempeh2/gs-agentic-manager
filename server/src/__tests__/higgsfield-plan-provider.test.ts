import { describe, expect, it, vi } from "vitest";
import { HIGGSFIELD_PLAN_URL } from "@greatstone/shared";
import {
  assertPlanCanSpend,
  createHiggsfieldPlanImageProvider,
  higgsfieldPlanClient,
  pickStudioProvider,
  planToolPayload,
  type HiggsfieldPlan,
} from "../services/image-generation/higgsfield-plan.js";
import { ImageGenerationError } from "../services/image-generation/types.js";
import { createHiggsfieldPlanVideoProvider, planClipCosts } from "../services/video-generation/higgsfield-plan.js";
import { describeImageGeneration } from "../services/image-generation/registry.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const JOB = "02cbf9eb-1345-46b7-a575-7dbbe43c4241";

/** A tools/call result as the Higgsfield MCP server sends it: JSON in a text block. */
const text = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

/** A mocked Higgsfield MCP connection: answers by tool name and records every call. */
function mcp(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected tool ${name}`);
    return handler(args);
  });
  return { calls, callTool };
}

function downloads(map: Record<string, Buffer>, contentType: string) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response(null, { status: 200 });
    const body = map[url];
    if (!body) throw new Error(`unexpected ${url}`);
    return new Response(body, { headers: { "content-type": contentType } });
  });
}

describe("Higgsfield plan provider", () => {
  it("maps a studio image onto generate_image_batch, waits on jobs_wait and downloads the result", async () => {
    let waits = 0;
    const { calls, callTool } = mcp({
      generate_image_batch: () => text({ jobs: [{ index: 0, job_id: JOB }] }),
      jobs_wait: () =>
        text(
          ++waits < 2
            ? { jobs: [{ index: 0, job_id: JOB, status: "in_progress" }], all_terminal: false, poll_after_seconds: 2 }
            : { jobs: [{ index: 0, job_id: JOB, status: "completed", result_url: "https://cdn.example/out.png" }], all_terminal: true },
        ),
    });
    const sleep = vi.fn(async () => undefined);
    const client = higgsfieldPlanClient(callTool, { fetchImpl: downloads({ "https://cdn.example/out.png": PNG }, "image/png"), sleep });
    const provider = createHiggsfieldPlanImageProvider(client);

    const result = await provider.generate({ prompt: "A lighthouse at dawn", aspectRatio: "16:9" });

    expect(provider).toMatchObject({ id: "higgsfield_plan", model: "soul_2" });
    expect(calls[0]).toEqual({
      name: "generate_image_batch",
      args: { requests: [{ index: 0, params: { model: "soul_2", prompt: "A lighthouse at dawn", aspect_ratio: "16:9", use_unlim: false } }] },
    });
    expect(calls.filter((call) => call.name === "jobs_wait")).toHaveLength(2);
    expect(calls[1]!.args).toEqual({ jobs: [{ index: 0, job_id: JOB }], timeout_seconds: 15 });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(result).toEqual({ image: { bytes: PNG, contentType: "image/png" }, providerRequestId: JOB });
  });

  it("animates a picture: uploads it with media_upload, PUT and media_confirm, then asks for a Kling start frame", async () => {
    const { calls, callTool } = mcp({
      media_upload: () => text({ uploads: [{ upload_url: "https://upload.example/put", media_id: "media-1" }] }),
      media_confirm: () => text({ ok: true }),
      generate_video_batch: () => text({ jobs: [{ index: 0, job_id: JOB }] }),
      jobs_wait: () => text({ jobs: [{ job_id: JOB, status: "completed", result_url: "https://cdn.example/out.mp4" }], all_terminal: true }),
    });
    const fetchImpl = downloads({ "https://cdn.example/out.mp4": MP4 }, "video/mp4");
    const provider = createHiggsfieldPlanVideoProvider(higgsfieldPlanClient(callTool, { fetchImpl }));

    const result = await provider.generate({
      prompt: "The boat drifts",
      model: "kling-2.5-turbo-pro",
      durationSeconds: 10,
      sourceImage: { bytes: PNG, contentType: "image/png" },
    });

    expect(calls.map((call) => call.name)).toEqual(["media_upload", "media_confirm", "generate_video_batch", "jobs_wait"]);
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("https://upload.example/put");
    expect(put[1]!.headers).toEqual({ "content-type": "image/png", "if-none-match": "*" });
    expect(calls[1]!.args).toEqual({ media_id: "media-1", type: "image" });
    expect(calls[2]!.args).toEqual({
      requests: [
        {
          index: 0,
          params: {
            model: "kling3_0_turbo",
            resolution: "1080p",
            duration: 10,
            prompt: "The boat drifts",
            medias: [{ role: "start_image", value: "media-1" }],
            use_unlim: false,
          },
        },
      ],
    });
    expect(result.video.contentType).toBe("video/mp4");
    expect(result.providerRequestId).toBe(JOB);
  });

  it("maps Hailuo onto its own variant and prices every model and length once, then from the cache", async () => {
    const { calls, callTool } = mcp({ generate_video: () => text({ cost: { credits: 6 } }) });
    const client = higgsfieldPlanClient(callTool);
    const costs = await planClipCosts(client);
    expect(costs["hailuo-2.3"]).toEqual({ 6: 6, 10: 6 });
    const hailuo = calls.find((call) => (call.args.params as Record<string, unknown>).model === "minimax_hailuo")!;
    expect(hailuo.args.params).toMatchObject({ variant: "minimax-2.3", get_cost: true, use_unlim: false });
    const first = calls.length;
    await planClipCosts(client);
    expect(calls.length).toBe(first);
  });

  it("turns a Higgsfield out-of-credits error into a plain message with the plan page", async () => {
    const { callTool } = mcp({
      generate_image_batch: () => ({ isError: true, content: [{ type: "text", text: "Insufficient credits for this generation" }] }),
    });
    const provider = createHiggsfieldPlanImageProvider(higgsfieldPlanClient(callTool));
    const failure = await provider.generate({ prompt: "A red bicycle", aspectRatio: "1:1" }).catch((error) => error);
    expect(failure).toBeInstanceOf(ImageGenerationError);
    expect(failure.code).toBe("credits");
    expect(failure.message).toContain(HIGGSFIELD_PLAN_URL);
  });

  it("reports a declined job as a content refusal and never shows raw provider text", async () => {
    const { callTool } = mcp({
      generate_image_batch: () => text({ jobs: [{ index: 0, job_id: JOB }] }),
      jobs_wait: () => text({ jobs: [{ job_id: JOB, status: "nsfw" }], all_terminal: true }),
    });
    const failure = await createHiggsfieldPlanImageProvider(higgsfieldPlanClient(callTool))
      .generate({ prompt: "x y z", aspectRatio: "1:1" })
      .catch((error) => error);
    expect(failure.code).toBe("rejected");
    expect(() => planToolPayload({ isError: true, content: [{ type: "text", text: "stack trace at line 9" }] })).toThrow(
      "Higgsfield could not do that. Please try again.",
    );
  });
});

function plan(credits: number | null, agentsMaySpend = false): HiggsfieldPlan {
  const { callTool } = mcp({ balance: () => text({ credits, subscription_plan_type: "basic" }) });
  return { connectionId: "conn-1", agentsMaySpend, client: higgsfieldPlanClient(callTool) };
}

describe("Higgsfield plan choice and spend guard", () => {
  const api = { id: "higgsfield" };
  const planProvider = () => ({ id: "higgsfield_plan" });

  it("defaults people to the plan when both are there, and keeps the API key on request", () => {
    const connected = plan(312);
    expect(pickStudioProvider({ requested: undefined, envProvider: api, plan: connected, planProvider, isAgent: false, kind: "image" }).provider).toEqual({ id: "higgsfield_plan" });
    expect(pickStudioProvider({ requested: "higgsfield", envProvider: api, plan: connected, planProvider, isAgent: false, kind: "image" }).provider).toBe(api);
    expect(pickStudioProvider({ requested: undefined, envProvider: api, plan: null, planProvider, isAgent: false, kind: "image" }).provider).toBe(api);
  });

  it("is hidden without the connection: asking for the plan then fails clearly", () => {
    expect(() => pickStudioProvider({ requested: "higgsfield_plan", envProvider: api, plan: null, planProvider, isAgent: false, kind: "image" })).toThrow(
      /Connect it under Apps/,
    );
    expect(describeImageGeneration(null, null)).toEqual({ configured: false, provider: null, providerLabel: null, model: null, local: null });
  });

  it("keeps agents off the plan by default, falling back to the API key, and lets them on when allowed", () => {
    expect(pickStudioProvider({ requested: undefined, envProvider: api, plan: plan(312), planProvider, isAgent: true, kind: "video" }).provider).toBe(api);
    expect(pickStudioProvider({ requested: undefined, envProvider: api, plan: plan(312, true), planProvider, isAgent: true, kind: "video" }).provider).toEqual({ id: "higgsfield_plan" });
  });

  it("never picks the plan over practice mode unasked", () => {
    expect(pickStudioProvider({ requested: undefined, envProvider: { id: "mock" }, plan: plan(312), planProvider, isAgent: false, kind: "image" }).provider).toEqual({ id: "mock" });
  });

  it("refuses an agent the board has not allowed, and a request the credits cannot cover", async () => {
    await expect(assertPlanCanSpend(plan(312), true, 1)).rejects.toMatchObject({ details: { code: "higgsfield_plan_agents_off" } });
    await expect(assertPlanCanSpend(plan(312), false, 1)).resolves.toBeUndefined();
    await expect(assertPlanCanSpend(plan(0), false, null)).rejects.toMatchObject({
      details: { code: "higgsfield_plan_no_credits", planUrl: HIGGSFIELD_PLAN_URL },
    });
    await expect(assertPlanCanSpend(plan(5), false, 7.5)).rejects.toMatchObject({ details: { code: "higgsfield_plan_no_credits" } });
    // A low balance warns in the studio but does not block.
    await expect(assertPlanCanSpend(plan(20), false, 1)).resolves.toBeUndefined();
  });
});
