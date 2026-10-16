import type { ImageAspectRatio } from "@greatstone/shared";
import {
  downloadImage,
  errorForHttpStatus,
  ImageGenerationError,
  type FetchLike,
  type ImageGenerationInput,
  type ImageGenerationProvider,
  type ImageGenerationResult,
} from "./types.js";

// Higgsfield (docs.higgsfield.ai, checked 15 Oct 2026): submit to
// POST {base}/{model} with "Authorization: Key <id>:<secret>", get back a
// request_id and status_url, poll until completed, then fetch images[0].url.
// Statuses: queued, in_progress, completed, failed, nsfw, canceled.

export const HIGGSFIELD_DEFAULT_BASE_URL = "https://api.higgsfield.ai";
export const HIGGSFIELD_DEFAULT_IMAGE_MODEL = "higgsfield-ai/soul/standard";

const LABEL = "Higgsfield";

export interface HiggsfieldOptions {
  keyId: string;
  keySecret: string;
  model?: string;
  baseUrl?: string;
  resolution?: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface HiggsfieldRequestStatus {
  status?: string;
  request_id?: string;
  status_url?: string;
  error?: string | null;
  images?: Array<{ url?: string }>;
}

/** Reads Higgsfield credentials from the environment; null when none are set. */
export function higgsfieldCredentialsFromEnv(env: NodeJS.ProcessEnv): { keyId: string; keySecret: string } | null {
  const keyId = env.HIGGSFIELD_API_KEY_ID?.trim() || env.HF_API_KEY_ID?.trim() || "";
  const keySecret = env.HIGGSFIELD_API_KEY_SECRET?.trim() || env.HF_API_KEY_SECRET?.trim() || "";
  if (keyId && keySecret) return { keyId, keySecret };
  // The console also shows the pair as one "id:secret" value.
  const combined = env.HIGGSFIELD_API_KEY?.trim() || env.HF_KEY?.trim() || "";
  const separator = combined.indexOf(":");
  if (separator > 0 && separator < combined.length - 1) {
    return { keyId: combined.slice(0, separator), keySecret: combined.slice(separator + 1) };
  }
  return null;
}

export function createHiggsfieldProvider(options: HiggsfieldOptions): ImageGenerationProvider {
  const model = (options.model?.trim() || HIGGSFIELD_DEFAULT_IMAGE_MODEL).replace(/^\/+|\/+$/g, "");
  const baseUrl = (options.baseUrl?.trim() || HIGGSFIELD_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const pollIntervalMs = options.pollIntervalMs ?? 2_500;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = {
    authorization: `Key ${options.keyId}:${options.keySecret}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  async function readStatus(response: Response): Promise<HiggsfieldRequestStatus> {
    if (!response.ok) throw errorForHttpStatus(response.status, LABEL);
    try {
      return (await response.json()) as HiggsfieldRequestStatus;
    } catch {
      throw new ImageGenerationError(`${LABEL} sent a reply GSAM could not read. Please try again.`, "provider_error");
    }
  }

  return {
    id: "higgsfield",
    model,
    async generate({ prompt, aspectRatio, signal }: ImageGenerationInput): Promise<ImageGenerationResult> {
      const body: Record<string, unknown> = {
        prompt,
        aspect_ratio: aspectRatio satisfies ImageAspectRatio,
        num_images: 1,
      };
      if (options.resolution?.trim()) body.resolution = options.resolution.trim();

      let status = await readStatus(
        await fetchImpl(`${baseUrl}/${model}`, { method: "POST", headers, body: JSON.stringify(body), signal }),
      );
      const requestId = status.request_id ?? null;
      const statusUrl = status.status_url || (requestId ? `${baseUrl}/requests/${requestId}/status` : null);
      const deadline = Date.now() + timeoutMs;

      while (status.status === "queued" || status.status === "in_progress") {
        if (!statusUrl) break;
        if (Date.now() > deadline) {
          throw new ImageGenerationError(`${LABEL} took too long to make the image. Please try again.`, "timeout");
        }
        await sleep(pollIntervalMs);
        if (signal?.aborted) throw new ImageGenerationError("The image request was stopped.", "timeout");
        status = await readStatus(await fetchImpl(statusUrl, { method: "GET", headers, signal }));
      }

      if (status.status === "nsfw") {
        throw new ImageGenerationError(
          `${LABEL} declined this description under its content rules. Try describing it differently.`,
          "rejected",
        );
      }
      if (status.status === "canceled") {
        throw new ImageGenerationError("The image request was cancelled before it started.", "provider_error");
      }
      if (status.status !== "completed") {
        throw new ImageGenerationError(`${LABEL} could not make this image. Please try again.`, "provider_error");
      }
      const url = status.images?.find((image) => typeof image.url === "string" && image.url)?.url;
      if (!url) {
        throw new ImageGenerationError(`${LABEL} finished without returning an image. Please try again.`, "provider_error");
      }
      return { image: await downloadImage(fetchImpl, url, signal), providerRequestId: requestId };
    },
  };
}
