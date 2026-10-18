import { videoModel } from "@greatstone/shared";
import { errorForHttpStatus } from "../image-generation/types.js";
import { HIGGSFIELD_DEFAULT_BASE_URL } from "../image-generation/higgsfield.js";
import {
  downloadVideo,
  VideoGenerationError,
  type FetchLike,
  type VideoGenerationInput,
  type VideoGenerationProvider,
  type VideoGenerationResult,
} from "./types.js";

// Higgsfield video (docs.higgsfield.ai, checked 17 Oct 2026). Same request
// flow as images: POST {base}/{model path} with "Authorization: Key id:secret",
// poll status_url until completed, then fetch video.url. Image to video needs
// the picture at a public URL, so GSAM first uploads it: POST
// /files/generate-upload-url with its content type, PUT the bytes to
// upload_url with upload_headers (and no Higgsfield key), then send
// public_url as image_url.

const LABEL = "Higgsfield";

export interface HiggsfieldVideoOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface HiggsfieldVideoStatus {
  status?: string;
  request_id?: string;
  status_url?: string;
  video?: { url?: string } | null;
  videos?: Array<{ url?: string }>;
}

interface HiggsfieldUploadUrl {
  public_url?: string;
  upload_url?: string;
  upload_headers?: Record<string, string>;
}

export function createHiggsfieldVideoProvider(options: HiggsfieldVideoOptions): VideoGenerationProvider {
  const baseUrl = (options.baseUrl?.trim() || HIGGSFIELD_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  // Clips take longer than pictures.
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = {
    authorization: `Key ${options.keyId}:${options.keySecret}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  async function readJson<T>(response: Response): Promise<T> {
    if (!response.ok) throw errorForHttpStatus(response.status, LABEL);
    try {
      return (await response.json()) as T;
    } catch {
      throw new VideoGenerationError(`${LABEL} sent a reply GSAM could not read. Please try again.`, "provider_error");
    }
  }

  async function uploadImage(image: { bytes: Buffer; contentType: string }, signal?: AbortSignal): Promise<string> {
    const target = await readJson<HiggsfieldUploadUrl>(
      await fetchImpl(`${baseUrl}/files/generate-upload-url`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content_type: image.contentType }),
        signal,
      }),
    );
    if (!target.upload_url || !target.public_url) {
      throw new VideoGenerationError(`${LABEL} did not give GSAM somewhere to send the picture. Please try again.`, "provider_error");
    }
    const uploaded = await fetchImpl(target.upload_url, {
      method: "PUT",
      headers: { "content-type": image.contentType, ...(target.upload_headers ?? {}) },
      body: new Uint8Array(image.bytes),
      signal,
    });
    if (!uploaded.ok) {
      throw new VideoGenerationError("The picture could not be sent to Higgsfield. Please try again.", "provider_error");
    }
    return target.public_url;
  }

  return {
    id: "higgsfield",
    async generate({ prompt, model: modelId, durationSeconds, sourceImage, signal }: VideoGenerationInput): Promise<VideoGenerationResult> {
      const model = videoModel(modelId);
      if (!model) throw new VideoGenerationError("That video model is not available.", "rejected");
      const path = sourceImage ? model.imagePath : model.textPath;
      if (!path) throw new VideoGenerationError(`${model.label} only animates an image.`, "rejected");

      const body: Record<string, unknown> = { prompt, duration: durationSeconds };
      if (sourceImage) body.image_url = await uploadImage(sourceImage, signal);

      let status = await readJson<HiggsfieldVideoStatus>(
        await fetchImpl(`${baseUrl}/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal }),
      );
      const requestId = status.request_id ?? null;
      const statusUrl = status.status_url || (requestId ? `${baseUrl}/requests/${requestId}/status` : null);
      const deadline = Date.now() + timeoutMs;

      while (status.status === "queued" || status.status === "in_progress") {
        if (!statusUrl) break;
        if (Date.now() > deadline) {
          throw new VideoGenerationError(`${LABEL} took too long to make the clip. Please try again.`, "timeout");
        }
        await sleep(pollIntervalMs);
        if (signal?.aborted) throw new VideoGenerationError("The clip request was stopped.", "timeout");
        status = await readJson<HiggsfieldVideoStatus>(await fetchImpl(statusUrl, { method: "GET", headers, signal }));
      }

      if (status.status === "nsfw") {
        throw new VideoGenerationError(
          `${LABEL} declined this description under its content rules. Try describing it differently.`,
          "rejected",
        );
      }
      if (status.status === "canceled") {
        throw new VideoGenerationError("The clip request was cancelled before it started.", "provider_error");
      }
      if (status.status !== "completed") {
        throw new VideoGenerationError(`${LABEL} could not make this clip. Please try again.`, "provider_error");
      }
      const url = status.video?.url || status.videos?.find((video) => typeof video.url === "string" && video.url)?.url;
      if (!url) {
        throw new VideoGenerationError(`${LABEL} finished without returning a clip. Please try again.`, "provider_error");
      }
      return { video: await downloadVideo(fetchImpl, url, LABEL, signal), providerRequestId: requestId };
    },
  };
}
