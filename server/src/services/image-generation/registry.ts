import {
  IMAGE_GENERATION_PROVIDER_LABELS,
  type ImageGenerationProviderId,
  type ImageGenerationStatus,
} from "@greatstone/shared";
import { createHiggsfieldProvider, higgsfieldCredentialsFromEnv } from "./higgsfield.js";
import { createMockImageProvider } from "./mock.js";
import { createOpenAiImageProvider } from "./openai.js";
import type { ImageGenerationProvider } from "./types.js";

/**
 * Picks the image service from the server environment.
 *
 * GSAM_IMAGE_PROVIDER names one explicitly (higgsfield, openai or mock). With
 * nothing named, Higgsfield is used when its key is set. OpenAI is never picked
 * on its own, because OPENAI_API_KEY is often there for agents rather than for
 * paid image generation.
 */
export function resolveImageGenerationProvider(env: NodeJS.ProcessEnv = process.env): ImageGenerationProvider | null {
  const named = env.GSAM_IMAGE_PROVIDER?.trim().toLowerCase() as ImageGenerationProviderId | "" | undefined;
  const higgsfield = higgsfieldCredentialsFromEnv(env);

  if (named === "mock") return createMockImageProvider();
  if (named === "openai") {
    const apiKey = env.GSAM_IMAGE_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    return createOpenAiImageProvider({
      apiKey,
      model: env.OPENAI_IMAGE_MODEL,
      baseUrl: env.GSAM_IMAGE_OPENAI_BASE_URL,
    });
  }
  if ((named === "higgsfield" || !named) && higgsfield) {
    return createHiggsfieldProvider({
      ...higgsfield,
      model: env.HIGGSFIELD_IMAGE_MODEL,
      baseUrl: env.HIGGSFIELD_API_BASE_URL,
      resolution: env.HIGGSFIELD_IMAGE_RESOLUTION,
    });
  }
  return null;
}

export function describeImageGeneration(provider: ImageGenerationProvider | null): ImageGenerationStatus {
  if (!provider) return { configured: false, provider: null, providerLabel: null, model: null };
  return {
    configured: true,
    provider: provider.id,
    providerLabel: IMAGE_GENERATION_PROVIDER_LABELS[provider.id],
    model: provider.model,
  };
}
