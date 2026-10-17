import type { VideoGenerationProviderId, VideoModelId } from "@greatstone/shared";
import { ImageGenerationError, type FetchLike } from "../image-generation/types.js";

export interface VideoGenerationInput {
  prompt: string;
  model: VideoModelId;
  durationSeconds: number;
  /** The picture to animate, for image to video. */
  sourceImage: { bytes: Buffer; contentType: string } | null;
  signal?: AbortSignal;
}

export interface VideoGenerationResult {
  video: { bytes: Buffer; contentType: string };
  providerRequestId: string | null;
}

/** One video service GSAM can ask for a clip. */
export interface VideoGenerationProvider {
  id: VideoGenerationProviderId;
  generate(input: VideoGenerationInput): Promise<VideoGenerationResult>;
}

/** Same plain-language failure as for images; the message is safe to show. */
export { ImageGenerationError as VideoGenerationError };
export type { FetchLike };

export const VIDEO_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

export async function downloadVideo(fetchImpl: FetchLike, url: string, label: string, signal?: AbortSignal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new ImageGenerationError("The finished clip could not be downloaded. Please try again.", "provider_error");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > VIDEO_DOWNLOAD_MAX_BYTES) {
    throw new ImageGenerationError(`${label} returned a clip too large to keep.`, "provider_error");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > VIDEO_DOWNLOAD_MAX_BYTES) {
    throw new ImageGenerationError(`${label} returned an unusable clip. Please try again.`, "provider_error");
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return { bytes, contentType: contentType.startsWith("video/") ? contentType : sniffVideoType(bytes) };
}

export function sniffVideoType(bytes: Buffer): string {
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return "video/mp4";
}
