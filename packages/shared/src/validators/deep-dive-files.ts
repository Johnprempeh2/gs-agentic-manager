import { z } from "zod";
import { DEEP_DIVE_VISIBILITIES } from "../deep-dive.js";

/** POST /api/cases/:id/deep-dive-files — link one client file or document request to a Deep Dive item. */
export const linkDeepDiveFileSchema = z.union([
  z.object({
    evidenceId: z.string().guid(),
    visibility: z.enum(DEEP_DIVE_VISIBILITIES).optional(),
  }).strict(),
  z.object({
    documentRequestId: z.string().guid(),
    visibility: z.enum(DEEP_DIVE_VISIBILITIES).optional(),
  }).strict(),
]);
export type LinkDeepDiveFile = z.infer<typeof linkDeepDiveFileSchema>;

/** PATCH /api/cases/:id/deep-dive-files/:linkId — Internal or Shared. */
export const patchDeepDiveFileSchema = z.object({
  visibility: z.enum(DEEP_DIVE_VISIBILITIES),
}).strict();
export type PatchDeepDiveFile = z.infer<typeof patchDeepDiveFileSchema>;
