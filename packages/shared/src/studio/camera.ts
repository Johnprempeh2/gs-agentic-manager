import { z } from "zod";

// Cinema camera settings for the image studio. The wording each choice adds to
// a description comes from Open Higgsfield AI's promptUtils.js (MIT, see
// LICENSE and PROVENANCE.md in this folder). People pick a camera, lens,
// focal length and aperture; the server turns the picks into prompt words.

export const STUDIO_CAMERAS = [
  { id: "modular-8k", label: "Modular 8K Digital", hint: "Crisp, modern blockbuster look", words: "modular 8K digital cinema camera" },
  { id: "full-frame-cine", label: "Full-Frame Cine Digital", hint: "Rich, wide and filmic", words: "full-frame digital cinema camera" },
  { id: "70mm-film", label: "Grand Format 70mm Film", hint: "Epic, detailed film", words: "grand format 70mm film camera" },
  { id: "studio-s35", label: "Studio Digital S35", hint: "Classic TV and film look", words: "Super 35 studio digital camera" },
  { id: "16mm-film", label: "Classic 16mm Film", hint: "Grainy, nostalgic film", words: "classic 16mm film camera" },
  { id: "large-format", label: "Premium Large Format Digital", hint: "Polished, high-end advert look", words: "premium large-format digital cinema camera" },
] as const;

export const STUDIO_LENSES = [
  { id: "premium-modern-prime", label: "Premium Modern Prime", hint: "Clean and sharp", words: "premium modern prime lens" },
  { id: "clinical-sharp-prime", label: "Clinical Sharp Prime", hint: "Very sharp detail", words: "ultra-sharp clinical prime lens" },
  { id: "warm-cinema-prime", label: "Warm Cinema Prime", hint: "Soft, warm tones", words: "warm-toned cinema prime lens" },
  { id: "vintage-prime", label: "Vintage Prime", hint: "Gentle, old-film character", words: "vintage prime lens" },
  { id: "70s-cinema-prime", label: "70s Cinema Prime", hint: "Retro 1970s feel", words: "1970s cinema prime lens" },
  { id: "classic-anamorphic", label: "Classic Anamorphic", hint: "Wide film look with lens flares", words: "classic anamorphic lens" },
  { id: "compact-anamorphic", label: "Compact Anamorphic", hint: "Subtle widescreen character", words: "compact anamorphic lens" },
  { id: "swirl-bokeh-portrait", label: "Swirl Bokeh Portrait", hint: "Dreamy swirling background", words: "swirl bokeh portrait lens" },
  { id: "halation-diffusion", label: "Halation Diffusion", hint: "Glowing highlights", words: "halation diffusion filter" },
  { id: "creative-tilt", label: "Creative Tilt Lens", hint: "Miniature, tilted focus", words: "creative tilt lens effect" },
  { id: "extreme-macro", label: "Extreme Macro", hint: "Very close-up detail", words: "extreme macro lens" },
] as const;

export const STUDIO_FOCAL_LENGTHS = [
  { value: 8, label: "8mm", hint: "Ultra wide", words: "ultra-wide perspective" },
  { value: 14, label: "14mm", hint: "Very wide", words: "wide-angle perspective" },
  { value: 24, label: "24mm", hint: "Wide and dynamic", words: "wide-angle dynamic perspective" },
  { value: 35, label: "35mm", hint: "Natural, like the eye", words: "natural cinematic perspective" },
  { value: 50, label: "50mm", hint: "Standard portrait", words: "standard portrait perspective" },
  { value: 85, label: "85mm", hint: "Flattering close portrait", words: "classic portrait perspective" },
] as const;

export const STUDIO_APERTURES = [
  { id: "f1.4", label: "f/1.4", hint: "Blurred background", words: "shallow depth of field, creamy bokeh" },
  { id: "f4", label: "f/4", hint: "Balanced", words: "balanced depth of field" },
  { id: "f11", label: "f/11", hint: "Everything sharp", words: "deep focus clarity, sharp foreground to background" },
] as const;

export type StudioCameraId = (typeof STUDIO_CAMERAS)[number]["id"];
export type StudioLensId = (typeof STUDIO_LENSES)[number]["id"];
export type StudioFocalLength = (typeof STUDIO_FOCAL_LENGTHS)[number]["value"];
export type StudioApertureId = (typeof STUDIO_APERTURES)[number]["id"];

const cameraIds = STUDIO_CAMERAS.map((item) => item.id) as [StudioCameraId, ...StudioCameraId[]];
const lensIds = STUDIO_LENSES.map((item) => item.id) as [StudioLensId, ...StudioLensId[]];
const apertureIds = STUDIO_APERTURES.map((item) => item.id) as [StudioApertureId, ...StudioApertureId[]];
const focalLengths = STUDIO_FOCAL_LENGTHS.map((item) => item.value);

/** Any of the four can be left out; an empty object means no camera wording. */
export const studioCameraSchema = z
  .object({
    camera: z.enum(cameraIds).optional(),
    lens: z.enum(lensIds).optional(),
    focalLength: z
      .number()
      .int()
      .refine((value) => focalLengths.includes(value as StudioFocalLength), {
        message: `Focal length must be one of ${focalLengths.join(", ")}`,
      })
      .optional(),
    aperture: z.enum(apertureIds).optional(),
  })
  .strict();
export type StudioCameraSettings = z.infer<typeof studioCameraSchema>;

function findCamera(id: string | undefined) {
  return STUDIO_CAMERAS.find((item) => item.id === id) ?? null;
}
function findLens(id: string | undefined) {
  return STUDIO_LENSES.find((item) => item.id === id) ?? null;
}
function findFocal(value: number | undefined) {
  return STUDIO_FOCAL_LENGTHS.find((item) => item.value === value) ?? null;
}
function findAperture(id: string | undefined) {
  return STUDIO_APERTURES.find((item) => item.id === id) ?? null;
}

/** True when at least one camera setting is picked. */
export function hasStudioCamera(settings: StudioCameraSettings | null | undefined): settings is StudioCameraSettings {
  return !!settings && !!(settings.camera || settings.lens || settings.focalLength || settings.aperture);
}

/**
 * The words the picks add to a description, in the order Open Higgsfield AI
 * uses: camera, lens with focal length and perspective, aperture and its depth
 * effect, then a short finish. Empty when nothing is picked.
 */
export function studioCameraWords(settings: StudioCameraSettings | null | undefined): string {
  if (!hasStudioCamera(settings)) return "";
  const camera = findCamera(settings.camera);
  const lens = findLens(settings.lens);
  const focal = findFocal(settings.focalLength);
  const aperture = findAperture(settings.aperture);
  const parts: string[] = [];
  if (camera) parts.push(`shot on a ${camera.words}`);
  if (lens && focal) parts.push(`using a ${lens.words} at ${focal.value}mm (${focal.words})`);
  else if (lens) parts.push(`using a ${lens.words}`);
  else if (focal) parts.push(`at ${focal.value}mm (${focal.words})`);
  if (aperture) parts.push(`aperture ${aperture.label}`, aperture.words);
  parts.push("cinematic lighting", "natural colour science", "high dynamic range");
  return parts.join(", ");
}

/** A short label for the gallery, such as "70mm film, Classic Anamorphic, 35mm, f/1.4". */
export function studioCameraLabel(settings: StudioCameraSettings | null | undefined): string | null {
  if (!hasStudioCamera(settings)) return null;
  return [
    findCamera(settings.camera)?.label,
    findLens(settings.lens)?.label,
    findFocal(settings.focalLength)?.label,
    findAperture(settings.aperture)?.label,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Reads a camera setting from a CLI value: its id or its label, any case. */
export function parseStudioChoice<T extends { label: string }>(
  list: ReadonlyArray<T & ({ id: string } | { value: number })>,
  raw: string | null | undefined,
): T | null {
  const value = (raw ?? "").trim().toLowerCase().replace(/mm$/, "");
  if (!value) return null;
  return (
    list.find((item) => {
      const key = "id" in item ? item.id : String(item.value);
      return key.toLowerCase() === value || item.label.toLowerCase().replace(/mm$/, "") === value;
    }) ?? null
  );
}

/**
 * Words people can add to a description with one tap. Grouped as in Open
 * Higgsfield AI's prompt enhancer, minus resolution claims that image services
 * ignore.
 */
export const STUDIO_PROMPT_BOOSTERS = [
  {
    id: "lighting",
    label: "Lighting",
    options: ["cinematic lighting", "golden hour", "dramatic studio lighting", "soft diffused light", "neon glow", "volumetric rays"],
  },
  {
    id: "mood",
    label: "Mood",
    options: ["moody atmosphere", "serene and peaceful", "epic and dramatic", "warm and cosy", "dark and mysterious"],
  },
  {
    id: "look",
    label: "Look",
    options: ["photorealistic", "oil painting", "watercolour", "digital art", "concept art", "anime style", "cyberpunk aesthetic"],
  },
  {
    id: "finish",
    label: "Finish",
    options: ["professional photography", "ultra-detailed", "high dynamic range", "award-winning"],
  },
] as const;

/** Adds a booster to a description once, comma separated. */
export function addPromptBooster(prompt: string, booster: string): string {
  const trimmed = prompt.trim().replace(/[,\s]+$/, "");
  if (!trimmed) return booster;
  if (trimmed.toLowerCase().includes(booster.toLowerCase())) return trimmed;
  return `${trimmed}, ${booster}`;
}

/** How many versions of one description the studio makes in one go. */
export const STUDIO_VARIATION_COUNTS = [1, 2, 4] as const;
export const STUDIO_MAX_VARIATIONS = 4;
