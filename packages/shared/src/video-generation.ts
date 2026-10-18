import { z } from "zod";
import { studioCameraSchema, studioCameraWords, type StudioCameraSettings } from "./studio/camera.js";

// Video generation: the image studio's moving-picture side. A clip is made
// from a written description (text to video) or by animating a finished
// studio image (image to video). The server picks the service from its
// environment, as it does for images; nothing here names a key.

export const VIDEO_GENERATION_PROVIDERS = ["higgsfield", "mock"] as const;
export type VideoGenerationProviderId = (typeof VIDEO_GENERATION_PROVIDERS)[number];

export const VIDEO_GENERATION_PROVIDER_LABELS: Record<VideoGenerationProviderId, string> = {
  higgsfield: "Higgsfield",
  mock: "Practice mode",
};

/**
 * Video models GSAM can ask Higgsfield for. Paths and durations come from
 * Higgsfield's published OpenAPI document (docs.higgsfield.ai, checked
 * 17 Oct 2026). A model without a textPath only animates an image.
 */
export const VIDEO_MODELS = [
  {
    id: "kling-2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    hint: "Best motion and detail",
    textPath: "kling-video/v2.5-turbo/pro/text-to-video",
    imagePath: "kling-video/v2.5-turbo/pro/image-to-video",
    durations: [5, 10],
  },
  {
    id: "kling-2.5-turbo-standard",
    label: "Kling 2.5 Turbo",
    hint: "Cheaper, animates an image only",
    textPath: null,
    imagePath: "kling-video/v2.5-turbo/standard/image-to-video",
    durations: [5, 10],
  },
  {
    id: "hailuo-2.3",
    label: "Hailuo 2.3",
    hint: "Lively and expressive",
    textPath: "minimax/hailuo-2.3/standard/text-to-video",
    imagePath: "minimax/hailuo-2.3/standard/image-to-video",
    durations: [6, 10],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  textPath: string | null;
  imagePath: string;
  durations: readonly number[];
}>;

export type VideoModelId = (typeof VIDEO_MODELS)[number]["id"];
export const VIDEO_MODEL_IDS = VIDEO_MODELS.map((model) => model.id) as [VideoModelId, ...VideoModelId[]];
export const DEFAULT_VIDEO_MODEL: VideoModelId = "kling-2.5-turbo-pro";

export function videoModel(id: string | null | undefined) {
  return VIDEO_MODELS.find((model) => model.id === id) ?? null;
}

export function videoModelLabel(id: string | null | undefined): string {
  return videoModel(id)?.label ?? id ?? "Video";
}

/** Ready-made motion people can add instead of writing camera directions. */
export const VIDEO_MOTION_PRESETS = [
  { id: "slow-push", label: "Slow push in", words: "slow cinematic push in towards the subject" },
  { id: "orbit", label: "Orbit", words: "smooth camera orbit around the subject" },
  { id: "pan", label: "Pan across", words: "steady sideways tracking pan" },
  { id: "drone", label: "Drone rise", words: "aerial drone shot rising and revealing the scene" },
  { id: "handheld", label: "Handheld", words: "natural handheld camera movement" },
  { id: "still", label: "Locked off", words: "static locked-off camera, only the subject moves" },
] as const;
export type VideoMotionPresetId = (typeof VIDEO_MOTION_PRESETS)[number]["id"];
export const VIDEO_MOTION_IDS = VIDEO_MOTION_PRESETS.map((preset) => preset.id) as [
  VideoMotionPresetId,
  ...VideoMotionPresetId[],
];

export function videoMotionLabel(id: string | null | undefined): string | null {
  return VIDEO_MOTION_PRESETS.find((preset) => preset.id === id)?.label ?? null;
}

/** The text the video service receives: the person's words, then the motion, then the camera wording. */
export function composeVideoPrompt(
  prompt: string,
  motion: string | null | undefined,
  camera?: StudioCameraSettings | null,
): string {
  const parts = [prompt.trim().replace(/[.,;\s]+$/, "")];
  const preset = VIDEO_MOTION_PRESETS.find((item) => item.id === motion);
  if (preset) parts.push(preset.words);
  const cameraWords = studioCameraWords(camera);
  if (cameraWords) parts.push(cameraWords);
  return parts.join(", ");
}

export const GENERATED_VIDEO_STATUSES = ["pending", "completed", "failed"] as const;
export type GeneratedVideoStatus = (typeof GENERATED_VIDEO_STATUSES)[number];

export const GENERATED_VIDEO_PROMPT_MIN_LENGTH = 3;
export const GENERATED_VIDEO_PROMPT_MAX_LENGTH = 2000;
/** Unfinished clips one company may have at once. Video costs more than images, so the cap is lower. */
export const GENERATED_VIDEOS_MAX_PENDING_PER_COMPANY = 3;
export const GENERATED_VIDEOS_DEFAULT_LIMIT = 60;
export const GENERATED_VIDEOS_MAX_LIMIT = 200;

export const createGeneratedVideoSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(GENERATED_VIDEO_PROMPT_MIN_LENGTH, "Describe the clip in a few words")
      .max(GENERATED_VIDEO_PROMPT_MAX_LENGTH, `Keep the description under ${GENERATED_VIDEO_PROMPT_MAX_LENGTH} characters`),
    model: z.enum(VIDEO_MODEL_IDS).default(DEFAULT_VIDEO_MODEL),
    /** Seconds; must be one the model offers. Defaults to the model's shortest. */
    duration: z.number().int().positive().optional(),
    /** A finished studio image to animate. Without it the clip is made from the words alone. */
    sourceImageId: z.string().uuid().nullable().optional(),
    motion: z.enum(VIDEO_MOTION_IDS).nullable().optional(),
    camera: studioCameraSchema.nullable().optional(),
    /** A saved house look; its camera and words fill in what the request leaves out. */
    lookId: z.string().uuid().nullable().optional(),
    issueId: z.string().uuid().nullable().optional(),
    organisationId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    const model = videoModel(value.model)!;
    if (value.duration !== undefined && !(model.durations as readonly number[]).includes(value.duration)) {
      context.addIssue({
        code: "custom",
        path: ["duration"],
        message: `${model.label} makes ${model.durations.join(" or ")} second clips`,
      });
    }
    if (!value.sourceImageId && !model.textPath) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageId"],
        message: `${model.label} only animates an image. Pick an image, or choose another model.`,
      });
    }
  });
export type CreateGeneratedVideo = z.input<typeof createGeneratedVideoSchema>;

export const generatedVideosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GENERATED_VIDEOS_MAX_LIMIT).default(GENERATED_VIDEOS_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(200).optional(),
  issueId: z.string().uuid().optional(),
  organisationId: z.string().uuid().optional(),
});
export type GeneratedVideosQuery = z.infer<typeof generatedVideosQuerySchema>;

export interface GeneratedVideo {
  id: string;
  companyId: string;
  prompt: string;
  model: VideoModelId;
  provider: VideoGenerationProviderId;
  durationSeconds: number;
  motion: VideoMotionPresetId | null;
  camera: StudioCameraSettings | null;
  /** The studio image animated, when the clip was made from one. */
  sourceImage: { id: string; contentPath: string | null; altText: string } | null;
  status: GeneratedVideoStatus;
  error: string | null;
  assetId: string | null;
  /** Where the finished clip can be played or downloaded; null until it is ready. */
  contentPath: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  issue: { id: string; identifier: string | null; title: string } | null;
  organisation: { id: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface GeneratedVideosResponse {
  videos: GeneratedVideo[];
  total: number;
  nextOffset: number | null;
}

export interface VideoGenerationStatus {
  configured: boolean;
  provider: VideoGenerationProviderId | null;
  providerLabel: string | null;
}
