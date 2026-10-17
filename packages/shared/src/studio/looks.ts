import { z } from "zod";
import { IMAGE_STYLE_IDS, type ImageStylePresetId } from "../image-generation.js";
import { studioCameraSchema, type StudioCameraSettings } from "./camera.js";

// House looks: a company's saved studio settings (a style, camera picks and
// extra words) under a name such as "Brand hero". People and agents pass the
// look with a request so every image or clip for a client comes out the same
// way; anything the request sets itself wins over the look.

export const STUDIO_LOOK_NAME_MAX_LENGTH = 60;
export const STUDIO_LOOK_WORDS_MAX_LENGTH = 400;
export const STUDIO_LOOKS_MAX_PER_COMPANY = 50;

export const createStudioLookSchema = z.object({
  name: z.string().trim().min(1, "Give the look a name").max(STUDIO_LOOK_NAME_MAX_LENGTH),
  description: z.string().trim().max(200).nullable().optional(),
  style: z.enum(IMAGE_STYLE_IDS).nullable().optional(),
  camera: studioCameraSchema.nullable().optional(),
  /** Words added after the person's description, such as lighting or brand colours. */
  words: z.string().trim().max(STUDIO_LOOK_WORDS_MAX_LENGTH).nullable().optional(),
});
export type CreateStudioLook = z.input<typeof createStudioLookSchema>;

export const updateStudioLookSchema = createStudioLookSchema.partial();
export type UpdateStudioLook = z.input<typeof updateStudioLookSchema>;

export interface StudioLook {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  style: ImageStylePresetId | null;
  camera: StudioCameraSettings | null;
  words: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioLooksResponse {
  looks: StudioLook[];
}

/** The description with a look's words added, trimmed so the two read as one phrase. */
export function applyStudioLookWords(prompt: string, words: string | null | undefined): string {
  const extra = words?.trim().replace(/^[.,;\s]+/, "");
  if (!extra) return prompt;
  return `${prompt.trim().replace(/[.,;\s]+$/, "")}, ${extra}`;
}
