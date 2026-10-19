import { VIDEO_GENERATION_PROVIDER_LABELS, type LocalGpuStatus, type VideoGenerationStatus } from "@greatstone/shared";
import { higgsfieldCredentialsFromEnv } from "../image-generation/higgsfield.js";
import { PRACTICE_VIDEO_MP4_BASE64 } from "./practice-video.js";
import { createHiggsfieldVideoProvider } from "./higgsfield.js";
import type { VideoGenerationProvider } from "./types.js";

export { createHiggsfieldPlanVideoProvider } from "./higgsfield-plan.js";

/** Practice mode: returns a short labelled clip, with no service and no cost. */
export function createMockVideoProvider(options: { delayMs?: number } = {}): VideoGenerationProvider {
  return {
    id: "mock",
    async generate() {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return { video: { bytes: Buffer.from(PRACTICE_VIDEO_MP4_BASE64, "base64"), contentType: "video/mp4" }, providerRequestId: null };
    },
  };
}

/**
 * Picks the video service from the server environment. It follows the image
 * setting so one switch covers the studio: GSAM_VIDEO_PROVIDER names one
 * (higgsfield or mock); otherwise GSAM_IMAGE_PROVIDER=mock means practice
 * mode, and the Higgsfield key turns on real clips.
 */
export function resolveVideoGenerationProvider(env: NodeJS.ProcessEnv = process.env): VideoGenerationProvider | null {
  const named = env.GSAM_VIDEO_PROVIDER?.trim().toLowerCase() ?? "";
  const imageNamed = env.GSAM_IMAGE_PROVIDER?.trim().toLowerCase() ?? "";
  if (named === "mock" || (!named && imageNamed === "mock")) return createMockVideoProvider();
  const higgsfield = higgsfieldCredentialsFromEnv(env);
  if ((named === "" || named === "higgsfield") && higgsfield) {
    return createHiggsfieldVideoProvider({ ...higgsfield, baseUrl: env.HIGGSFIELD_API_BASE_URL });
  }
  return null;
}

/**
 * The studio's clip status. A connected Higgsfield plan is the default
 * service; otherwise the API key service, otherwise the local GPU.
 */
export function describeVideoGeneration(
  provider: VideoGenerationProvider | null,
  local: LocalGpuStatus | null = null,
  plan?: VideoGenerationStatus["plan"],
): VideoGenerationStatus {
  if (plan) {
    return {
      configured: true,
      provider: "higgsfield_plan",
      providerLabel: VIDEO_GENERATION_PROVIDER_LABELS.higgsfield_plan,
      local,
      plan,
      alsoAvailable: provider ? { provider: provider.id, providerLabel: VIDEO_GENERATION_PROVIDER_LABELS[provider.id] } : null,
    };
  }
  const id = provider?.id ?? (local?.videoModels.length ? "local" : null);
  if (!id) return { configured: false, provider: null, providerLabel: null, local };
  return { configured: true, provider: id, providerLabel: VIDEO_GENERATION_PROVIDER_LABELS[id], local };
}
