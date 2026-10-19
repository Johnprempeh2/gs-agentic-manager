import type { ImageAspectRatio, ImageGenerationProviderId } from "@greatstone/shared";

export interface ImageGenerationInput {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  /** Only local models use these two. */
  seed?: number;
  negativePrompt?: string | null;
  /** The generated image id, so the local GPU queue can say where it is. */
  jobId?: string;
  signal?: AbortSignal;
}

export interface GeneratedImageBytes {
  bytes: Buffer;
  contentType: string;
}

export interface ImageGenerationResult {
  image: GeneratedImageBytes;
  providerRequestId: string | null;
}

/** One image service GSAM can ask for a picture. */
export interface ImageGenerationProvider {
  id: ImageGenerationProviderId;
  model: string;
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

/**
 * A failure worth showing to the person who asked: the message is written for
 * a non-technical reader and never carries keys or raw provider payloads.
 */
export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "auth"
      | "credits"
      | "rejected"
      | "rate_limited"
      | "timeout"
      | "provider_error",
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const IMAGE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

export async function downloadImage(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<GeneratedImageBytes> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new ImageGenerationError("The finished image could not be downloaded. Please try again.", "provider_error");
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) {
    throw new ImageGenerationError("The image service returned an unusable file. Please try again.", "provider_error");
  }
  return { bytes, contentType: contentType.startsWith("image/") ? contentType : sniffImageType(bytes) };
}

export function sniffImageType(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png";
}

export function errorForHttpStatus(status: number, providerLabel: string): ImageGenerationError {
  if (status === 401 || status === 403) {
    return new ImageGenerationError(`${providerLabel} did not accept the API key. Ask your admin to check it.`, "auth");
  }
  if (status === 402) {
    return new ImageGenerationError(`The ${providerLabel} account has run out of credits. Ask your admin to top it up.`, "credits");
  }
  if (status === 429) {
    return new ImageGenerationError(`${providerLabel} is busy right now. Wait a minute and try again.`, "rate_limited");
  }
  if (status === 400 || status === 422) {
    return new ImageGenerationError(`${providerLabel} could not use that description. Try rewording it.`, "rejected");
  }
  return new ImageGenerationError(`${providerLabel} had a problem making the image. Please try again.`, "provider_error");
}
