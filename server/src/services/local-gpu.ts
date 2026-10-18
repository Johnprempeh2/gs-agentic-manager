import { randomInt, randomUUID } from "node:crypto";
import {
  LOCAL_GPU_LABEL,
  LOCAL_IMAGE_MODELS,
  type GeneratedVideoProgress,
  type ImageAspectRatio,
  type LocalGpuStatus,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { ImageGenerationError, IMAGE_DOWNLOAD_MAX_BYTES, sniffImageType, type FetchLike } from "./image-generation/types.js";
import type { ImageGenerationProvider } from "./image-generation/types.js";
import { VIDEO_DOWNLOAD_MAX_BYTES, sniffVideoType, type VideoGenerationProvider } from "./video-generation/types.js";

// Pictures and clips made on this PC's graphics card by ComfyUI
// (github.com/comfyanonymous/ComfyUI), which runs beside GSAM on 127.0.0.1.
// Its HTTP API: POST /prompt queues a workflow and answers a prompt_id,
// GET /history/{id} is empty until the workflow has finished, GET /view
// fetches a file it made, POST /upload/image takes a picture to animate,
// POST /interrupt stops the running workflow, GET /models/{folder} lists
// installed model files, and the /ws websocket reports sampling progress.
//
// The card can only do one thing at a time, so every local job, picture or
// clip, waits its turn in one queue in this process.

export const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";
const LABEL = "This PC";
const IMAGE_TIMEOUT_MS = 5 * 60_000;
const VIDEO_TIMEOUT_MS = 45 * 60_000;
const HEALTH_TIMEOUT_MS = 2_000;

/** The files each local model needs, by ComfyUI model folder. */
export const LOCAL_MODEL_FILES = {
  "flux-schnell": { checkpoints: "flux1-schnell-fp8.safetensors" },
  sdxl: { checkpoints: "sd_xl_base_1.0.safetensors" },
  "wan-2.2-5b": {
    diffusion_models: "wan2.2_ti2v_5B_fp16.safetensors",
    text_encoders: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    vae: "wan2.2_vae.safetensors",
  },
} as const;
type LocalModelId = keyof typeof LOCAL_MODEL_FILES;
const LOCAL_VIDEO_MODEL_IDS = ["wan-2.2-5b"] as const;

/** Picture sizes per shape; multiples of 64 that both FLUX and SDXL handle well. */
export const LOCAL_IMAGE_SIZES: Record<ImageAspectRatio, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
};

/**
 * Clip size and rate. Wan 2.2 5B is trained at 1280x704, 24 fps; frame counts
 * must be 4n+1. Measured on the RTX 5080 (see ~/GSAM/local-ai/MODELS.md).
 */
export const LOCAL_VIDEO_SETTINGS = { width: 1280, height: 704, fps: 24, steps: 20 };

export function localVideoFrames(seconds: number) {
  return Math.round((seconds * LOCAL_VIDEO_SETTINGS.fps) / 4) * 4 + 1;
}

const VIDEO_NEGATIVE =
  "blurry, low quality, distorted, deformed, extra limbs, jittery, flickering, static frame, watermark, text, subtitles";

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export function randomSeed() {
  return randomInt(0, 2 ** 32);
}

/** The ComfyUI workflow for one picture. PreviewImage keeps it in ComfyUI's temp folder, cleared on restart. */
export function buildImageWorkflow(input: {
  model: "flux-schnell" | "sdxl";
  prompt: string;
  negativePrompt?: string | null;
  aspectRatio: ImageAspectRatio;
  seed: number;
}): Workflow {
  const [width, height] = LOCAL_IMAGE_SIZES[input.aspectRatio];
  const flux = input.model === "flux-schnell";
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: LOCAL_MODEL_FILES[input.model].checkpoints } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: input.prompt, clip: ["1", 1] } },
    // FLUX schnell runs at cfg 1, where the negative is ignored; it still needs one.
    "3": { class_type: "CLIPTextEncode", inputs: { text: flux ? "" : input.negativePrompt ?? "", clip: ["1", 1] } },
    "4": {
      class_type: flux ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        seed: input.seed,
        ...(flux
          ? { steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple" }
          : { steps: 25, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras" }),
        denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
  };
}

/** The ComfyUI workflow for one Wan 2.2 clip, from words or from an uploaded picture. */
export function buildVideoWorkflow(input: { prompt: string; durationSeconds: number; seed: number; startImage: string | null }): Workflow {
  const files = LOCAL_MODEL_FILES["wan-2.2-5b"];
  const workflow: Workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: files.diffusion_models, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: files.text_encoders, type: "wan", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: files.vae } },
    "4": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: input.prompt, clip: ["2", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: VIDEO_NEGATIVE, clip: ["2", 0] } },
    "7": {
      class_type: "Wan22ImageToVideoLatent",
      inputs: {
        vae: ["3", 0],
        width: LOCAL_VIDEO_SETTINGS.width,
        height: LOCAL_VIDEO_SETTINGS.height,
        length: localVideoFrames(input.durationSeconds),
        batch_size: 1,
        ...(input.startImage ? { start_image: ["10", 0] } : {}),
      },
    },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["5", 0],
        negative: ["6", 0],
        latent_image: ["7", 0],
        seed: input.seed,
        steps: LOCAL_VIDEO_SETTINGS.steps,
        cfg: 5,
        sampler_name: "uni_pc",
        scheduler: "simple",
        denoise: 1,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "11": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: LOCAL_VIDEO_SETTINGS.fps } },
    "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: "gsam/clip", format: "mp4", codec: "h264" } },
  };
  if (input.startImage) workflow["10"] = { class_type: "LoadImage", inputs: { image: input.startImage } };
  return workflow;
}

// ---- One job at a time on the graphics card ---------------------------------

interface GpuJob {
  id: string;
  start: () => void;
  percent: number | null;
}
const gpuQueue: GpuJob[] = [];

/**
 * Runs `work` when every local job queued before it has finished. A job
 * cancelled while it waits leaves the queue without running.
 */
export function runOnGpu<T>(jobId: string, work: (job: GpuJob) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: GpuJob = {
      id: jobId,
      percent: null,
      start: () => {
        if (signal?.aborted) return next(job, () => reject(cancelled()));
        work(job).then(
          (value) => next(job, () => resolve(value)),
          (error) => next(job, () => reject(error)),
        );
      },
    };
    signal?.addEventListener(
      "abort",
      () => {
        const index = gpuQueue.indexOf(job);
        if (index > 0) {
          gpuQueue.splice(index, 1);
          reject(cancelled());
        }
      },
      { once: true },
    );
    gpuQueue.push(job);
    if (gpuQueue.length === 1) job.start();
  });
}

function next(job: GpuJob, settle: () => void) {
  const index = gpuQueue.indexOf(job);
  if (index >= 0) gpuQueue.splice(index, 1);
  settle();
  if (index === 0) gpuQueue[0]?.start();
}

function cancelled() {
  return new ImageGenerationError("Cancelled.", "provider_error");
}

/** Where a local job is: 0 is on the card now. Null when it is not a local job waiting or running. */
export function localGpuProgress(jobId: string): GeneratedVideoProgress | null {
  const index = gpuQueue.findIndex((job) => job.id === jobId);
  if (index < 0) return null;
  return { queuePosition: index, percent: index === 0 ? gpuQueue[0]!.percent : null };
}

export function localGpuQueueLength() {
  return gpuQueue.length;
}

// ---- ComfyUI client ------------------------------------------------------------

export interface LocalGpu {
  /** What is installed and ready; null when ComfyUI does not answer. */
  status(): Promise<LocalGpuStatus | null>;
  imageProvider(model: "flux-schnell" | "sdxl"): ImageGenerationProvider;
  videoProvider(): VideoGenerationProvider;
}

export interface LocalGpuOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Opens the progress socket; tests leave it out. */
  openSocket?: ((url: string) => { onmessage: ((event: { data: unknown }) => void) | null; close(): void }) | null;
}

/** The local GPU from GSAM_COMFYUI_URL (default 127.0.0.1:8188); "off" switches it off. */
export function localGpuFromEnv(env: NodeJS.ProcessEnv = process.env): LocalGpu | null {
  const url = env.GSAM_COMFYUI_URL?.trim();
  if (url?.toLowerCase() === "off") return null;
  return createLocalGpu({ baseUrl: url || DEFAULT_COMFYUI_URL });
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
  outputs?: Record<string, Record<string, unknown>>;
}

interface OutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

export function createLocalGpu(options: LocalGpuOptions = {}): LocalGpu {
  const baseUrl = (options.baseUrl ?? DEFAULT_COMFYUI_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const openSocket =
    options.openSocket === undefined
      ? typeof WebSocket === "function"
        ? (url: string) => new WebSocket(url)
        : null
      : options.openSocket;

  async function call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw cancelled();
      throw new ImageGenerationError(
        "This PC's image server (ComfyUI) is not answering. Check it is running on the PC, then try again.",
        "provider_error",
      );
    }
  }

  async function json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn({ status: response.status, body: text.slice(0, 500) }, "ComfyUI refused a request");
      throw new ImageGenerationError(`${LABEL} could not use that request. Please try again.`, "provider_error");
    }
    return (await response.json()) as T;
  }

  async function listFolder(folder: string, signal: AbortSignal): Promise<string[]> {
    const response = await fetchImpl(`${baseUrl}/models/${folder}`, { signal });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? body.filter((item): item is string => typeof item === "string") : [];
  }

  async function status(): Promise<LocalGpuStatus | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const folders = ["checkpoints", "diffusion_models", "text_encoders", "vae"] as const;
      const listed = await Promise.all(folders.map((folder) => listFolder(folder, controller.signal)));
      const installed = new Map(folders.map((folder, index) => [folder, new Set(listed[index])]));
      const ready = (id: LocalModelId) =>
        Object.entries(LOCAL_MODEL_FILES[id]).every(([folder, file]) => installed.get(folder as (typeof folders)[number])?.has(file));
      return {
        label: LOCAL_GPU_LABEL,
        imageModels: LOCAL_IMAGE_MODELS.map((model) => model.id).filter(ready),
        videoModels: LOCAL_VIDEO_MODEL_IDS.filter(ready),
        queued: localGpuQueueLength(),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Queues a workflow, waits for it, and fetches the first file it made. */
  async function execute(
    job: GpuJob,
    workflow: Workflow,
    { timeoutMs, maxBytes, signal }: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
  ) {
    const clientId = randomUUID();
    const socket = openProgressSocket(clientId, job);
    let promptId: string | null = null;
    const stop = () => {
      void call("/interrupt", { method: "POST" }).catch(() => undefined);
      if (promptId) {
        void call("/queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ delete: [promptId] }),
        }).catch(() => undefined);
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const queued = await json<{ prompt_id?: string }>(
        await call("/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        }),
      );
      promptId = queued.prompt_id ?? null;
      if (!promptId) throw new ImageGenerationError(`${LABEL} did not accept the request. Please try again.`, "provider_error");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) throw cancelled();
        const history = await json<Record<string, HistoryEntry>>(await call(`/history/${encodeURIComponent(promptId)}`));
        const entry = history[promptId];
        if (entry?.status?.status_str === "error") throw failureFrom(entry);
        if (entry?.status?.completed || entry?.status?.status_str === "success") {
          const file = firstOutputFile(entry);
          if (!file) throw new ImageGenerationError(`${LABEL} finished without making anything. Please try again.`, "provider_error");
          const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
          const response = await call(`/view?${query}`);
          if (!response.ok) throw new ImageGenerationError("The finished file could not be fetched. Please try again.", "provider_error");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length === 0 || bytes.length > maxBytes) {
            throw new ImageGenerationError(`${LABEL} made an unusable file. Please try again.`, "provider_error");
          }
          const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
          return { bytes, contentType, promptId };
        }
        if (Date.now() > deadline) {
          stop();
          throw new ImageGenerationError(
            `${LABEL}'s graphics card took too long. It may be busy with something else; try again in a few minutes.`,
            "timeout",
          );
        }
        await sleep(pollIntervalMs);
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      socket?.close();
    }
  }

  function openProgressSocket(clientId: string, job: GpuJob) {
    if (!openSocket) return null;
    try {
      const socket = openSocket(`${baseUrl.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
      socket.onmessage = (event: { data: unknown }) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; data?: { value?: number; max?: number } };
          if (message.type === "progress" && message.data?.max) {
            job.percent = Math.min(100, Math.round(((message.data.value ?? 0) / message.data.max) * 100));
          }
        } catch {
          // Progress is a nicety; a bad message is ignored.
        }
      };
      return socket;
    } catch {
      return null;
    }
  }

  async function uploadImage(image: { bytes: Buffer; contentType: string }, signal?: AbortSignal) {
    const form = new FormData();
    const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType === "image/webp" ? "webp" : "png";
    form.set("image", new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), `gsam-${randomUUID()}.${extension}`);
    form.set("overwrite", "true");
    const uploaded = await json<{ name?: string; subfolder?: string }>(await call("/upload/image", { method: "POST", body: form, signal }));
    if (!uploaded.name) throw new ImageGenerationError(`${LABEL} could not take the picture to animate.`, "provider_error");
    return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  }

  return {
    status,

    imageProvider(model) {
      return {
        id: "local",
        model,
        async generate({ prompt, aspectRatio, seed, negativePrompt, jobId, signal }) {
          return runOnGpu(
            jobId ?? randomUUID(),
            async (job) => {
              const made = await execute(
                job,
                buildImageWorkflow({ model, prompt, negativePrompt, aspectRatio, seed: seed ?? randomSeed() }),
                { timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: IMAGE_DOWNLOAD_MAX_BYTES, signal },
              );
              const contentType = made.contentType.startsWith("image/") ? made.contentType : sniffImageType(made.bytes);
              return { image: { bytes: made.bytes, contentType }, providerRequestId: made.promptId };
            },
            signal,
          );
        },
      };
    },

    videoProvider() {
      return {
        id: "local",
        async generate({ prompt, durationSeconds, sourceImage, jobId, signal }) {
          return runOnGpu(
            jobId ?? randomUUID(),
            async (job) => {
              const startImage = sourceImage ? await uploadImage(sourceImage, signal) : null;
              const made = await execute(
                job,
                buildVideoWorkflow({ prompt, durationSeconds, seed: randomSeed(), startImage }),
                { timeoutMs: VIDEO_TIMEOUT_MS, maxBytes: VIDEO_DOWNLOAD_MAX_BYTES, signal },
              );
              const contentType = made.contentType.startsWith("video/") ? made.contentType : sniffVideoType(made.bytes);
              return { video: { bytes: made.bytes, contentType }, providerRequestId: made.promptId };
            },
            signal,
          );
        },
      };
    },
  };
}

function firstOutputFile(entry: HistoryEntry): OutputFile | null {
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ["images", "videos", "gifs"]) {
      const files = output[key];
      if (!Array.isArray(files)) continue;
      const file = files.find((item): item is OutputFile => typeof item?.filename === "string");
      if (file) return file;
    }
  }
  return null;
}

/** A plain reason from ComfyUI's execution_error message; out of memory gets its own. */
export function failureFrom(entry: HistoryEntry): ImageGenerationError {
  const error = entry.status?.messages?.find(([type]) => type === "execution_error")?.[1] ?? {};
  const detail = `${String(error.exception_type ?? "")} ${String(error.exception_message ?? "")}`;
  logger.warn({ detail: detail.slice(0, 500) }, "ComfyUI workflow failed");
  if (/out ?of ?memory|OutOfMemory|Allocation on device/i.test(detail)) {
    return new ImageGenerationError(
      `${LABEL}'s graphics card ran out of memory. Close other GPU work on the PC, or pick a smaller shape, and try again.`,
      "provider_error",
    );
  }
  if (/interrupt/i.test(detail)) return cancelled();
  return new ImageGenerationError(`${LABEL} could not make this. Please try again.`, "provider_error");
}
