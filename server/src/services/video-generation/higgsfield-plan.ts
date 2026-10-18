import { VIDEO_MODELS, type VideoModelId } from "@greatstone/shared";
import type { HiggsfieldPlanClient } from "../image-generation/higgsfield-plan.js";
import { downloadVideo, VideoGenerationError, type VideoGenerationInput, type VideoGenerationProvider, type VideoGenerationResult } from "./types.js";

// Studio clips on the Higgsfield plan (see image-generation/higgsfield-plan.ts).
// The studio's video models are Higgsfield API paths; the plan's MCP catalogue
// (models_explore, 18 Oct 2026) has no Kling 2.5, so Kling picks map to Kling
// 3.0 Turbo, the nearest Kling there, and Hailuo 2.3 maps to its own variant.
// Both animate a picture as the start_image.

// Local models (provider "local") run on this PC and have no plan mapping.
export const HIGGSFIELD_PLAN_VIDEO_MODELS: Partial<Record<VideoModelId, { model: string; params: Record<string, unknown> }>> = {
  "kling-2.5-turbo-pro": { model: "kling3_0_turbo", params: { resolution: "1080p" } },
  "kling-2.5-turbo-standard": { model: "kling3_0_turbo", params: { resolution: "720p" } },
  "hailuo-2.3": { model: "minimax_hailuo", params: { variant: "minimax-2.3" } },
};

/** The MCP params for one clip, without the prompt and picture. */
export function planVideoParams(model: VideoModelId, durationSeconds: number) {
  const mapped = HIGGSFIELD_PLAN_VIDEO_MODELS[model];
  if (!mapped) throw new VideoGenerationError("That video model is not on the Higgsfield plan.", "rejected");
  return { model: mapped.model, ...mapped.params, duration: durationSeconds };
}

/** Credits per studio model and length, from Higgsfield's price check. */
export async function planClipCosts(client: HiggsfieldPlanClient) {
  const entries = await Promise.all(
    VIDEO_MODELS.filter((model) => HIGGSFIELD_PLAN_VIDEO_MODELS[model.id]).map(async (model) => {
      const byDuration: Record<number, number | null> = {};
      for (const duration of model.durations) {
        byDuration[duration] = await client.cost("generate_video", { ...planVideoParams(model.id, duration), prompt: "price check" });
      }
      return [model.id, byDuration] as const;
    }),
  );
  return Object.fromEntries(entries) as Partial<Record<VideoModelId, Record<number, number | null>>>;
}

export function createHiggsfieldPlanVideoProvider(
  client: HiggsfieldPlanClient,
  options: { timeoutMs?: number } = {},
): VideoGenerationProvider {
  return {
    id: "higgsfield_plan",
    async generate({ prompt, model, durationSeconds, sourceImage, signal }: VideoGenerationInput): Promise<VideoGenerationResult> {
      const params: Record<string, unknown> = { ...planVideoParams(model, durationSeconds), prompt };
      if (sourceImage) params.medias = [{ role: "start_image", value: await client.uploadImage(sourceImage) }];
      const jobId = await client.submit("generate_video_batch", params);
      const url = await client.wait(jobId, options.timeoutMs ?? 15 * 60_000);
      return { video: await downloadVideo(client.fetchImpl, url, "Higgsfield", signal), providerRequestId: jobId };
    },
  };
}
