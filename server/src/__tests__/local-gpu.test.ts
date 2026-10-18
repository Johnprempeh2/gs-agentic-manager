import { describe, expect, it } from "vitest";
import {
  buildImageWorkflow,
  buildVideoWorkflow,
  createLocalGpu,
  localGpuFromEnv,
  localGpuProgress,
  localVideoFrames,
  runOnGpu,
} from "../services/local-gpu.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const INSTALLED: Record<string, string[]> = {
  checkpoints: ["flux1-schnell-fp8.safetensors", "sd_xl_base_1.0.safetensors"],
  diffusion_models: ["wan2.2_ti2v_5B_fp16.safetensors"],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["wan2.2_vae.safetensors"],
};

/** A pretend ComfyUI: history is empty for `pendingPolls` polls, then shows the result. */
function fakeComfy(options: { pendingPolls?: number; history?: (promptId: string) => unknown; installed?: Record<string, string[]> } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let prompts = 0;
  const polls = new Map<string, number>();
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = url.replace("http://127.0.0.1:8188", "");
    const method = init?.method ?? "GET";
    calls.push({ url: path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const folder = path.match(/^\/models\/(\w+)$/)?.[1];
    if (folder) return json((options.installed ?? INSTALLED)[folder] ?? []);
    if (path === "/prompt") return json({ prompt_id: `p${++prompts}`, number: prompts });
    if (path === "/upload/image") return json({ name: "gsam-start.png", subfolder: "", type: "input" });
    const history = path.match(/^\/history\/(\w+)$/)?.[1];
    if (history) {
      const seen = (polls.get(history) ?? 0) + 1;
      polls.set(history, seen);
      if (seen <= (options.pendingPolls ?? 1)) return json({});
      return json(
        options.history?.(history) ?? {
          [history]: {
            status: { status_str: "success", completed: true, messages: [] },
            outputs: { "7": { images: [{ filename: `${history}.png`, subfolder: "", type: "temp" }] } },
          },
        },
      );
    }
    if (path.startsWith("/view?")) {
      return path.includes(".mp4")
        ? new Response(MP4, { headers: { "content-type": "video/mp4" } })
        : new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (path === "/interrupt" || path === "/queue") return json({});
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { calls, fetchImpl };
}

function gpu(comfy: ReturnType<typeof fakeComfy>) {
  return createLocalGpu({ fetchImpl: comfy.fetchImpl, sleep: async () => undefined, openSocket: null });
}

describe("local GPU workflows", () => {
  it("builds a four-step FLUX schnell workflow that ignores the negative prompt", () => {
    const workflow = buildImageWorkflow({ model: "flux-schnell", prompt: "A lighthouse", negativePrompt: "fog", aspectRatio: "16:9", seed: 7 });
    expect(workflow["1"]!.inputs.ckpt_name).toBe("flux1-schnell-fp8.safetensors");
    expect(workflow["2"]!.inputs.text).toBe("A lighthouse");
    expect(workflow["3"]!.inputs.text).toBe("");
    expect(workflow["4"]).toEqual({ class_type: "EmptySD3LatentImage", inputs: { width: 1344, height: 768, batch_size: 1 } });
    expect(workflow["5"]!.inputs).toMatchObject({ seed: 7, steps: 4, cfg: 1, sampler_name: "euler" });
    expect(workflow["7"]!.class_type).toBe("PreviewImage");
  });

  it("builds an SDXL workflow with the words to leave out", () => {
    const workflow = buildImageWorkflow({ model: "sdxl", prompt: "A lighthouse", negativePrompt: "fog", aspectRatio: "3:4", seed: 9 });
    expect(workflow["1"]!.inputs.ckpt_name).toBe("sd_xl_base_1.0.safetensors");
    expect(workflow["3"]!.inputs.text).toBe("fog");
    expect(workflow["4"]).toEqual({ class_type: "EmptyLatentImage", inputs: { width: 896, height: 1152, batch_size: 1 } });
    expect(workflow["5"]!.inputs).toMatchObject({ seed: 9, steps: 25, cfg: 7 });
  });

  it("builds a Wan 2.2 clip workflow, with a start picture only for image to video", () => {
    expect(localVideoFrames(5)).toBe(121);
    expect(localVideoFrames(3)).toBe(73);
    const words = buildVideoWorkflow({ prompt: "Waves", durationSeconds: 5, seed: 1, startImage: null });
    expect(words["7"]!.inputs).toMatchObject({ length: 121, width: 1280, height: 704 });
    expect(words["7"]!.inputs.start_image).toBeUndefined();
    expect(words["10"]).toBeUndefined();
    const animated = buildVideoWorkflow({ prompt: "Waves", durationSeconds: 3, seed: 1, startImage: "start.png" });
    expect(animated["7"]!.inputs.start_image).toEqual(["10", 0]);
    expect(animated["10"]).toEqual({ class_type: "LoadImage", inputs: { image: "start.png" } });
  });
});

describe("local GPU status", () => {
  it("lists the models whose files are all installed", async () => {
    const comfy = fakeComfy({ installed: { checkpoints: ["flux1-schnell-fp8.safetensors"], diffusion_models: ["wan2.2_ti2v_5B_fp16.safetensors"] } });
    expect(await gpu(comfy).status()).toEqual({ label: "This PC (local GPU)", imageModels: ["flux-schnell"], videoModels: [], queued: 0 });
  });

  it("is null when ComfyUI does not answer", async () => {
    const down = createLocalGpu({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await down.status()).toBeNull();
  });

  it("can be switched off", () => {
    expect(localGpuFromEnv({ GSAM_COMFYUI_URL: "off" })).toBeNull();
    expect(localGpuFromEnv({})).not.toBeNull();
  });
});

describe("local GPU providers", () => {
  it("queues the workflow, polls history and fetches the picture", async () => {
    const comfy = fakeComfy({ pendingPolls: 2 });
    const result = await gpu(comfy).imageProvider("sdxl").generate({
      prompt: "A lighthouse",
      aspectRatio: "1:1",
      seed: 42,
      negativePrompt: "fog",
      jobId: "job-image",
    });
    expect(result.image.contentType).toBe("image/png");
    expect(result.image.bytes.equals(PNG)).toBe(true);
    expect(result.providerRequestId).toBe("p1");
    const queued = comfy.calls.find((call) => call.url === "/prompt")!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    expect(queued.prompt["5"]!.inputs.seed).toBe(42);
    expect(queued.prompt["3"]!.inputs.text).toBe("fog");
    expect(comfy.calls.filter((call) => call.url.startsWith("/history/")).length).toBe(3);
    expect(comfy.calls.at(-1)!.url).toBe("/view?filename=p1.png&subfolder=&type=temp");
  });

  it("uploads the picture to animate and returns the clip", async () => {
    const comfy = fakeComfy({
      history: (id) => ({
        [id]: {
          status: { status_str: "success", completed: true },
          outputs: { "12": { images: [{ filename: "gsam/clip_00001.mp4", subfolder: "gsam", type: "output" }], animated: [true] } },
        },
      }),
    });
    const result = await gpu(comfy).videoProvider().generate({
      prompt: "Steam rises",
      model: "wan-2.2-5b",
      durationSeconds: 3,
      sourceImage: { bytes: PNG, contentType: "image/png" },
      jobId: "job-clip",
    });
    expect(result.video.contentType).toBe("video/mp4");
    expect(comfy.calls[0]!.url).toBe("/upload/image");
    const queued = comfy.calls.find((call) => call.url === "/prompt")!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    expect(queued.prompt["10"]!.inputs.image).toBe("gsam-start.png");
    expect(queued.prompt["7"]!.inputs.length).toBe(73);
  });

  it("says plainly when the graphics card runs out of memory", async () => {
    const comfy = fakeComfy({
      history: (id) => ({
        [id]: {
          status: {
            status_str: "error",
            completed: false,
            messages: [["execution_error", { exception_type: "torch.OutOfMemoryError", exception_message: "CUDA out of memory" }]],
          },
          outputs: {},
        },
      }),
    });
    await expect(gpu(comfy).imageProvider("flux-schnell").generate({ prompt: "x", aspectRatio: "1:1" })).rejects.toThrow(
      /ran out of memory/,
    );
  });

  it("says plainly when the PC's server is down", async () => {
    const down = createLocalGpu({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async () => undefined,
      openSocket: null,
    });
    await expect(down.imageProvider("flux-schnell").generate({ prompt: "x", aspectRatio: "1:1" })).rejects.toThrow(/not answering/);
  });

  it("reports sampling progress from the websocket", async () => {
    const comfy = fakeComfy({ pendingPolls: 1 });
    let socket: { onmessage: ((event: { data: unknown }) => void) | null; close(): void } | null = null;
    let seen: ReturnType<typeof localGpuProgress> = null;
    const local = createLocalGpu({
      fetchImpl: async (url, init) => {
        if (url.includes("/history/") && socket?.onmessage) {
          socket.onmessage({ data: JSON.stringify({ type: "progress", data: { value: 5, max: 20 } }) });
          seen = localGpuProgress("job-progress");
        }
        return comfy.fetchImpl(url, init);
      },
      sleep: async () => undefined,
      openSocket: () => (socket = { onmessage: null, close: () => undefined }),
    });
    await local.imageProvider("flux-schnell").generate({ prompt: "x", aspectRatio: "1:1", jobId: "job-progress" });
    expect(seen).toEqual({ queuePosition: 0, percent: 25 });
  });
});

describe("one job at a time on the graphics card", () => {
  it("runs local jobs one after another and says where each one is", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = runOnGpu("first", async () => {
      order.push("first started");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first finished");
    });
    const second = runOnGpu("second", async () => {
      order.push("second started");
    });
    await Promise.resolve();
    expect(localGpuProgress("first")).toEqual({ queuePosition: 0, percent: null });
    expect(localGpuProgress("second")).toEqual({ queuePosition: 1, percent: null });
    expect(order).toEqual(["first started"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first started", "first finished", "second started"]);
    expect(localGpuProgress("second")).toBeNull();
  });

  it("drops a cancelled job that is still waiting, without running it", async () => {
    let releaseFirst!: () => void;
    const first = runOnGpu("busy", () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const controller = new AbortController();
    let ran = false;
    const waiting = runOnGpu("waiting", async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("Cancelled.");
    expect(localGpuProgress("waiting")).toBeNull();
    releaseFirst();
    await first;
    expect(ran).toBe(false);
  });

  it("interrupts ComfyUI when the running job is cancelled", async () => {
    const comfy = fakeComfy({ pendingPolls: 1_000 });
    const controller = new AbortController();
    const local = createLocalGpu({
      fetchImpl: async (url, init) => {
        if (url.includes("/history/")) controller.abort();
        return comfy.fetchImpl(url, init);
      },
      sleep: async () => undefined,
      openSocket: null,
    });
    await expect(
      local.imageProvider("flux-schnell").generate({ prompt: "x", aspectRatio: "1:1", signal: controller.signal }),
    ).rejects.toThrow("Cancelled.");
    expect(comfy.calls.some((call) => call.url === "/interrupt")).toBe(true);
    expect(comfy.calls.find((call) => call.url === "/queue")?.body).toEqual({ delete: ["p1"] });
  });
});
