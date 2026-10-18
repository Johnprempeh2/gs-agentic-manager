import { z } from "zod";
import { studioCameraSchema, studioCameraWords, type StudioCameraSettings } from "./studio/camera.js";

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

/**
 * Where Higgsfield API keys are made (docs.higgsfield.ai/docs/authentication,
 * checked 16 Oct 2026). API use needs no higgsfield.ai plan: it draws on its
 * own prepaid US dollar balance.
 */
export const HIGGSFIELD_API_KEYS_URL = "https://console.higgsfield.ai";

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

/**
 * Looks people can pick instead of writing prompt craft. The guidance is added
 * to the description before it reaches the image service; the gallery shows
 * the person's own words and the style name.
 */
export const IMAGE_STYLE_PRESETS = [
  {
    id: "greatstone-brand",
    label: "Greatstone brand",
    hint: "Charcoal and neon lime, modern and premium",
    guidance:
      "In the Greatstone brand look: charcoal grey background, neon lime green accents with small touches of teal and soft purple, flowing spiral wave line art, modern, minimal and premium, plenty of clear space, no text or logos.",
    aspectRatio: "16:9",
  },
  {
    id: "client-proposal",
    label: "Client proposal",
    hint: "Clean and professional, room for words",
    guidance:
      "Styled for a client proposal: clean, professional and trustworthy, calm neutral colours, soft natural light, uncluttered composition with clear space for a heading, no text.",
    aspectRatio: "16:9",
  },
  {
    id: "social-post",
    label: "Social post",
    hint: "Bright and eye-catching for feeds",
    guidance:
      "Made for a social media post: bright, bold and eye-catching, strong single focal point, vivid colours, works at small sizes, no text.",
    aspectRatio: "1:1",
  },
  {
    id: "photo",
    label: "Real photo",
    hint: "Looks like a real photograph",
    guidance: "As a realistic high quality photograph, natural lighting, true to life colours and detail, no text.",
    aspectRatio: "4:3",
  },
  {
    id: "illustration",
    label: "Illustration",
    hint: "Friendly flat drawing",
    guidance: "As a friendly flat vector illustration, simple shapes, warm limited colour palette, no text.",
    aspectRatio: "4:3",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  guidance: string;
  aspectRatio: ImageAspectRatio;
}>;

export type ImageStylePresetId = (typeof IMAGE_STYLE_PRESETS)[number]["id"];
export const IMAGE_STYLE_IDS = IMAGE_STYLE_PRESETS.map((preset) => preset.id) as [ImageStylePresetId, ...ImageStylePresetId[]];

export function imageStylePreset(style: string | null | undefined) {
  return IMAGE_STYLE_PRESETS.find((preset) => preset.id === style) ?? null;
}

export function imageStyleLabel(style: string | null | undefined): string | null {
  return imageStylePreset(style)?.label ?? null;
}

/** Accepts a style id ("social-post") or its label ("Social post"); null when neither matches. */
export function parseImageStyle(value: string | null | undefined): ImageStylePresetId | null {
  const normalised = (value ?? "").trim().toLowerCase();
  if (!normalised) return null;
  return IMAGE_STYLE_PRESETS.find((preset) => preset.id === normalised || preset.label.toLowerCase() === normalised)?.id ?? null;
}

/**
 * The text the image service receives: the person's words, then the camera
 * wording (when a camera is picked), then the style's guidance.
 */
export function composeImagePrompt(
  prompt: string,
  style: string | null | undefined,
  camera?: StudioCameraSettings | null,
): string {
  const preset = imageStylePreset(style);
  const cameraWords = studioCameraWords(camera);
  let text = prompt.trim();
  if (cameraWords) text = `${text.replace(/[.,;\s]+$/, "")}, ${cameraWords}`;
  if (!preset) return text;
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return `${sentence} ${preset.guidance}`;
}

// Directions to the image service that say nothing about what the picture
// shows, so they are left out of the alt text.
const ALT_TEXT_NOISE = [
  /\bno (?:text|words|letters|logos?|watermarks?)\b/gi,
  /\b(?:high|ultra)[ -]?(?:res(?:olution)?|detail(?:ed)?|quality)\b/gi,
  /\b(?:4k|8k|hd|photorealistic|hyper[ -]?realistic|trending on \w+)\b/gi,
  /\bplenty of (?:empty|negative) space\b/gi,
];

export const IMAGE_ALT_TEXT_MAX_LENGTH = 150;

/**
 * Alt text for a generated image, written from its description so screen
 * readers and search have plain words for it. It keeps what the picture shows,
 * drops directions such as "no text" or "4k", and stays short.
 */
export function imageAltText(prompt: string, style?: string | null): string {
  let text = prompt.replace(/\s+/g, " ").trim();
  for (const pattern of ALT_TEXT_NOISE) text = text.replace(pattern, "");
  text = text
    .replace(/\s*,\s*(?=,|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:]+|[\s,;:]+$/g, "")
    .trim();
  if (!text) text = "Generated image";
  if (text.length > IMAGE_ALT_TEXT_MAX_LENGTH) {
    const cut = text.slice(0, IMAGE_ALT_TEXT_MAX_LENGTH - 1);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}...`;
  }
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const preset = imageStylePreset(style);
  if (preset?.id === "illustration") return `Illustration: ${text}`;
  return text;
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
  style: z.enum(IMAGE_STYLE_IDS).nullable().optional(),
  /** Cinema camera picks (camera, lens, focal length, aperture); their wording is added to the prompt. */
  camera: studioCameraSchema.nullable().optional(),
  /** A saved house look; its style, camera and words fill in what the request leaves out. */
  lookId: z.string().uuid().nullable().optional(),
  /** The task the image is for, when it is made from a task. */
  issueId: z.string().uuid().nullable().optional(),
  /** The client the image is for. */
  organisationId: z.string().uuid().nullable().optional(),
});
export type CreateGeneratedImage = z.input<typeof createGeneratedImageSchema>;

/** Most pictures one variations request may make; it must also fit under the pending cap. */
export const GENERATED_IMAGE_VARIATIONS_MAX = 4;

/** Longest single shot line in a storyboard. */
export const GENERATED_IMAGE_SHOT_MAX_LENGTH = 300;

/**
 * Joins a storyboard shot to the description every shot shares, so each
 * picture shows its own moment in the same setting and look.
 */
export function composeStoryboardPrompt(shot: string, shared: string): string {
  const moment = shot.trim().replace(/[.\s]+$/, "");
  return `${moment}. ${shared.trim()}`.slice(0, GENERATED_IMAGE_PROMPT_MAX_LENGTH);
}

/**
 * Several takes on one brief, side by side: `count` copies of the same
 * request (with its `lookId`, if any), one picture per house look in
 * `lookIds` to compare looks, or one picture per line in `shots` for a
 * storyboard that shares the description and look.
 */
export const createGeneratedImageVariationsSchema = createGeneratedImageSchema
  .extend({
    count: z.coerce.number().int().min(2).max(GENERATED_IMAGE_VARIATIONS_MAX).optional(),
    lookIds: z.array(z.string().uuid()).min(2).max(GENERATED_IMAGE_VARIATIONS_MAX).optional(),
    shots: z
      .array(z.string().trim().min(GENERATED_IMAGE_PROMPT_MIN_LENGTH, "Describe each shot in a few words").max(GENERATED_IMAGE_SHOT_MAX_LENGTH))
      .min(2)
      .max(GENERATED_IMAGE_VARIATIONS_MAX)
      .optional(),
  })
  .refine((value) => [value.count, value.lookIds, value.shots].filter((item) => item !== undefined).length === 1, {
    message: "Say how many takes (count), which looks to compare (lookIds) or which shots to make (shots): one of them",
  })
  .refine((value) => !(value.lookIds && value.lookId), {
    message: "Use lookIds to compare looks, or lookId with count, not both",
    path: ["lookId"],
  })
  .refine((value) => !value.lookIds || new Set(value.lookIds).size === value.lookIds.length, {
    message: "Pick each look once",
    path: ["lookIds"],
  });
export type CreateGeneratedImageVariations = z.input<typeof createGeneratedImageVariationsSchema>;

export const generatedImagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GENERATED_IMAGES_MAX_LIMIT).default(GENERATED_IMAGES_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  /** Words to look for in the description. */
  q: z.string().trim().max(200).optional(),
  issueId: z.string().uuid().optional(),
  organisationId: z.string().uuid().optional(),
});
export type GeneratedImagesQuery = z.infer<typeof generatedImagesQuerySchema>;

/** Show (or stop showing) a finished image on the card of the task or client it is linked to. */
export const updateGeneratedImageCoverSchema = z
  .object({
    issueCover: z.boolean().optional(),
    organisationCover: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.issueCover !== undefined || value.organisationCover !== undefined, {
    message: "Say issueCover or organisationCover",
  });
export type UpdateGeneratedImageCover = z.infer<typeof updateGeneratedImageCoverSchema>;

/** Cover pictures by task id and by client id, each the image's contentPath and alt text. */
export interface GeneratedImageCovers {
  issues: Record<string, { imageId: string; contentPath: string; altText: string }>;
  organisations: Record<string, { imageId: string; contentPath: string; altText: string }>;
}

export interface GeneratedImage {
  id: string;
  companyId: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  style: ImageStylePresetId | null;
  /** Cinema camera picks, or null when none were made. */
  camera: StudioCameraSettings | null;
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
  /** The task it was made for, if any. */
  issue: { id: string; identifier: string | null; title: string } | null;
  /** The client it was made for, if any. */
  organisation: { id: string; name: string } | null;
  /** Short plain description for screen readers and search, written from the prompt. */
  altText: string;
  /** True when this image shows on its task's card. */
  issueCover: boolean;
  /** True when this image shows on its client's card. */
  organisationCover: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface GeneratedImageVariationsResponse {
  images: GeneratedImage[];
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
