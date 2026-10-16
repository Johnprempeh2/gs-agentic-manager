import type { ImageAspectRatio } from "@greatstone/shared";
import {
  errorForHttpStatus,
  ImageGenerationError,
  sniffImageType,
  type FetchLike,
  type ImageGenerationInput,
  type ImageGenerationProvider,
  type ImageGenerationResult,
} from "./types.js";

export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-1";
const LABEL = "OpenAI";

const SIZE_BY_ASPECT: Record<ImageAspectRatio, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
};

export interface OpenAiImageOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createOpenAiImageProvider(options: OpenAiImageOptions): ImageGenerationProvider {
  const model = options.model?.trim() || OPENAI_DEFAULT_IMAGE_MODEL;
  const baseUrl = (options.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    id: "openai",
    model,
    async generate({ prompt, aspectRatio, signal }: ImageGenerationInput): Promise<ImageGenerationResult> {
      const response = await fetchImpl(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, size: SIZE_BY_ASPECT[aspectRatio] }),
        signal,
      });
      if (!response.ok) throw errorForHttpStatus(response.status, LABEL);
      const payload = (await response.json().catch(() => null)) as { data?: Array<{ b64_json?: string }> } | null;
      const encoded = payload?.data?.[0]?.b64_json;
      if (!encoded) {
        throw new ImageGenerationError(`${LABEL} finished without returning an image. Please try again.`, "provider_error");
      }
      const bytes = Buffer.from(encoded, "base64");
      return { image: { bytes, contentType: sniffImageType(bytes) }, providerRequestId: null };
    },
  };
}
