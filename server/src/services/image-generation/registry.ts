import {
  IMAGE_GENERATION_PROVIDER_LABELS,
  type ImageGenerationProviderId,
  type ImageGenerationStatus,
  type LocalGpuStatus,
} from "@greatstone/shared";
import { createHiggsfieldProvider, higgsfieldCredentialsFromEnv } from "./higgsfield.js";
import { createMockImageProvider } from "./mock.js";
import { createOpenAiImageProvider } from "./openai.js";
import type { ImageGenerationProvider } from "./types.js";

export { createHiggsfieldPlanImageProvider, higgsfieldPlanResolver } from "./higgsfield-plan.js";

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

/**
 * The studio's image status. A connected Higgsfield plan is the default
 * service; otherwise the API key service, otherwise the local GPU's first model.
 */
export function describeImageGeneration(
  provider: ImageGenerationProvider | null,
  local: LocalGpuStatus | null = null,
  plan?: ImageGenerationStatus["plan"],
): ImageGenerationStatus {
  if (plan) {
    return {
      configured: true,
      provider: "higgsfield_plan",
      providerLabel: IMAGE_GENERATION_PROVIDER_LABELS.higgsfield_plan,
      model: plan.model,
      local,
      plan,
      alsoAvailable: provider ? { provider: provider.id, providerLabel: IMAGE_GENERATION_PROVIDER_LABELS[provider.id] } : null,
    };
  }
  const fallback = provider ?? (local?.imageModels[0] ? { id: "local" as const, model: local.imageModels[0] } : null);
  if (!fallback) return { configured: false, provider: null, providerLabel: null, model: null, local };
  return {
    configured: true,
    provider: fallback.id,
    providerLabel: IMAGE_GENERATION_PROVIDER_LABELS[fallback.id],
    model: fallback.model,
    local,
  };
}
