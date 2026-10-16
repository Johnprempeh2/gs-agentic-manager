import { z } from "zod";

// Image generation: agents and board users ask for a picture from a written
// description and GSAM keeps the result as a company image. The provider is
// chosen by the server from its environment; nothing here names a key.

export const IMAGE_GENERATION_PROVIDERS = ["higgsfield", "openai", "mock"] as const;
export type ImageGenerationProviderId = (typeof IMAGE_GENERATION_PROVIDERS)[number];

export const IMAGE_GENERATION_PROVIDER_LABELS: Record<ImageGenerationProviderId, string> = {
  higgsfield: "Higgsfield",
  openai: "OpenAI",
  mock: "Practice mode",
};

export const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = "1:1";

/** Plain names for each shape, so nobody has to know what 16:9 means. */
export const IMAGE_SHAPE_OPTIONS: ReadonlyArray<{
  value: ImageAspectRatio;
  label: string;
  hint: string;
  cliName: string;
}> = [
  { value: "1:1", label: "Square", hint: "Social posts and avatars", cliName: "square" },
  { value: "16:9", label: "Wide", hint: "Slides and banners", cliName: "wide" },
  { value: "9:16", label: "Tall", hint: "Stories and phones", cliName: "tall" },
  { value: "4:3", label: "Landscape", hint: "Documents and reports", cliName: "landscape" },
  { value: "3:4", label: "Portrait", hint: "Posters and flyers", cliName: "portrait" },
];

/** Accepts a shape name ("wide") or a ratio ("16:9"); null when neither matches. */
export function parseImageShape(value: string | null | undefined): ImageAspectRatio | null {
  const normalised = (value ?? "").trim().toLowerCase();
  if (!normalised) return null;
  const match = IMAGE_SHAPE_OPTIONS.find(
    (option) => option.value === normalised || option.cliName === normalised || option.label.toLowerCase() === normalised,
  );
  return match?.value ?? null;
}

export function imageShapeLabel(aspectRatio: string): string {
  return IMAGE_SHAPE_OPTIONS.find((option) => option.value === aspectRatio)?.label ?? aspectRatio;
}

export const GENERATED_IMAGE_STATUSES = ["pending", "completed", "failed"] as const;
export type GeneratedImageStatus = (typeof GENERATED_IMAGE_STATUSES)[number];

export const GENERATED_IMAGE_PROMPT_MIN_LENGTH = 3;
export const GENERATED_IMAGE_PROMPT_MAX_LENGTH = 2000;
export const GENERATED_IMAGES_DEFAULT_LIMIT = 60;
export const GENERATED_IMAGES_MAX_LIMIT = 200;
/** Unfinished images one company may have at once; stops a runaway loop spending credits. */
export const GENERATED_IMAGES_MAX_PENDING_PER_COMPANY = 6;

export const createGeneratedImageSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(GENERATED_IMAGE_PROMPT_MIN_LENGTH, "Describe the image in a few words")
    .max(GENERATED_IMAGE_PROMPT_MAX_LENGTH, `Keep the description under ${GENERATED_IMAGE_PROMPT_MAX_LENGTH} characters`),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default(DEFAULT_IMAGE_ASPECT_RATIO),
});
export type CreateGeneratedImage = z.input<typeof createGeneratedImageSchema>;

export const generatedImagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GENERATED_IMAGES_MAX_LIMIT).default(GENERATED_IMAGES_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GeneratedImagesQuery = z.infer<typeof generatedImagesQuerySchema>;

export interface GeneratedImage {
  id: string;
  companyId: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  provider: ImageGenerationProviderId;
  model: string;
  status: GeneratedImageStatus;
  /** Plain-language reason when status is failed. */
  error: string | null;
  assetId: string | null;
  /** Where the finished image can be fetched; null until it is ready. */
  contentPath: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface GeneratedImagesResponse {
  images: GeneratedImage[];
  total: number;
  nextOffset: number | null;
}

export interface ImageGenerationStatus {
  configured: boolean;
  provider: ImageGenerationProviderId | null;
  providerLabel: string | null;
  model: string | null;
}
