import { z } from "zod";
import {
  createGeneratedImageSchema,
  createGeneratedVideoSchema,
  createStudioLookSchema,
  IMAGE_STYLE_PRESETS,
  mcpToolHints,
  STUDIO_APERTURES,
  STUDIO_CAMERAS,
  STUDIO_FOCAL_LENGTHS,
  STUDIO_LENSES,
  STUDIO_MAX_VARIATIONS,
  VIDEO_MODELS,
  VIDEO_MOTION_PRESETS,
} from "@greatstone/shared";
import type { PaperclipApiClient } from "./client.js";
import { makeTool, type ToolDefinition } from "./tools.js";

// Image studio tools. Named like the connection tools rather than paperclip*,
// and kept out of tools.ts, so the frozen legacy capability inventory and its
// source anchors are unchanged.

const companyIdOptional = z.string().guid().optional().nullable();

const studioMakeImageSchema = createGeneratedImageSchema.extend({
  companyId: companyIdOptional,
  count: z.number().int().min(1).max(STUDIO_MAX_VARIATIONS).optional().default(1),
  lookIds: z.array(z.string().guid()).min(2).max(STUDIO_MAX_VARIATIONS).optional(),
});

const STUDIO_MAKE_IMAGE_DESCRIPTION = [
  "Make one or more images from a written description in the GSAM image studio. Answers at once with pending images;",
  "poll studio_get_image until status is completed (contentPath set) or failed (error says why). Each image costs money, so make what the task needs.",
  `aspectRatio: 1:1, 16:9, 9:16, 4:3 or 3:4. style: ${IMAGE_STYLE_PRESETS.map((preset) => preset.id).join(", ")}.`,
  `camera (all optional): camera ${STUDIO_CAMERAS.map((item) => item.id).join(", ")}; lens ${STUDIO_LENSES.map((item) => item.id).join(", ")};`,
  `focalLength ${STUDIO_FOCAL_LENGTHS.map((item) => item.value).join(", ")}; aperture ${STUDIO_APERTURES.map((item) => item.id).join(", ")}.`,
  `count: 1 to ${STUDIO_MAX_VARIATIONS} versions. lookId applies a saved house look (studio_list_looks); your own picks win.`,
  `lookIds: 2 to ${STUDIO_MAX_VARIATIONS} house looks to compare; makes one image in each (leave out count and lookId).`,
  "Several versions start together or not at all.",
  "issueId links the image to a task; organisationId to a client.",
].join(" ");

const STUDIO_MAKE_VIDEO_DESCRIPTION = [
  "Make a short video clip in the GSAM studio, from words alone or by animating a finished studio image (sourceImageId).",
  "Answers at once with a pending clip; poll studio_get_video until status is completed (contentPath set) or failed. Clips can take minutes and cost more than images.",
  `model: ${VIDEO_MODELS.map((model) => `${model.id} (${model.durations.join(" or ")} s${model.textPath ? "" : ", needs sourceImageId"})`).join("; ")}.`,
  `motion: ${VIDEO_MOTION_PRESETS.map((preset) => preset.id).join(", ")}. camera takes the same fields as studio_make_image.`,
  "lookId applies a saved house look's camera and words. issueId links the clip to a task; organisationId to a client.",
].join(" ");

const studioMakeVideoSchema = createGeneratedVideoSchema.safeExtend({ companyId: companyIdOptional });

interface StudioMadeFile {
  companyId: string;
  prompt: string;
  status: string;
  assetId: string | null;
  issue: { id: string } | null;
}

const STUDIO_FILE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** A readable file name from the description, such as "a-lighthouse-at-dawn.png". */
export function studioFileName(prompt: string, contentType: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "studio";
  return `${slug}.${STUDIO_FILE_EXTENSIONS[contentType.split(";")[0]!.trim()] ?? "bin"}`;
}

export function studioTools(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "studio_status",
      "Say whether the GSAM image studio is switched on and which image service it uses. configured false means ask the board to add a key; do not try other services.",
      mcpToolHints("read"),
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/image-generation`),
    ),
    makeTool(
      "studio_make_image",
      STUDIO_MAKE_IMAGE_DESCRIPTION,
      mcpToolHints("write"),
      studioMakeImageSchema,
      async ({ companyId, count, lookIds, ...body }) => {
        const path = `/companies/${client.resolveCompanyId(companyId)}/generated-images`;
        if (lookIds) return client.requestJson("POST", `${path}/variations`, { body: { ...body, lookIds } });
        if (count > 1) return client.requestJson("POST", `${path}/variations`, { body: { ...body, count } });
        return { images: [await client.requestJson("POST", path, { body })] };
      },
    ),
    makeTool(
      "studio_get_image",
      "Get one studio image and its status. When completed, contentPath is where to download it and altText is its description for alt text.",
      mcpToolHints("read"),
      z.object({ imageId: z.string().guid() }),
      async ({ imageId }) => client.requestJson("GET", `/generated-images/${encodeURIComponent(imageId)}`),
    ),
    makeTool(
      "studio_list_images",
      "List studio images for the company, newest first. Filter by words in the description (q), a task (issueId) or a client (organisationId).",
      mcpToolHints("read"),
      z.object({
        companyId: companyIdOptional,
        q: z.string().trim().max(200).optional(),
        issueId: z.string().guid().optional(),
        organisationId: z.string().guid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      async ({ companyId, q, issueId, organisationId, limit }) => {
        const search = new URLSearchParams();
        if (q) search.set("q", q);
        if (issueId) search.set("issueId", issueId);
        if (organisationId) search.set("organisationId", organisationId);
        search.set("limit", String(limit ?? 20));
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/generated-images?${search}`);
      },
    ),
    makeTool(
      "studio_video_status",
      "Say whether the GSAM studio can make video clips and which service it uses. configured false means ask the board to add the Higgsfield key; do not try other services.",
      mcpToolHints("read"),
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/video-generation`),
    ),
    makeTool(
      "studio_make_video",
      STUDIO_MAKE_VIDEO_DESCRIPTION,
      mcpToolHints("write"),
      studioMakeVideoSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/generated-videos`, { body }),
    ),
    makeTool(
      "studio_get_video",
      "Get one studio video clip and its status. When completed, contentPath is where to play or download it.",
      mcpToolHints("read"),
      z.object({ videoId: z.string().guid() }),
      async ({ videoId }) => client.requestJson("GET", `/generated-videos/${encodeURIComponent(videoId)}`),
    ),
    makeTool(
      "studio_list_videos",
      "List studio video clips for the company, newest first. Filter by words in the description (q), a task (issueId) or a client (organisationId).",
      mcpToolHints("read"),
      z.object({
        companyId: companyIdOptional,
        q: z.string().trim().max(200).optional(),
        issueId: z.string().guid().optional(),
        organisationId: z.string().guid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      async ({ companyId, q, issueId, organisationId, limit }) => {
        const search = new URLSearchParams();
        if (q) search.set("q", q);
        if (issueId) search.set("issueId", issueId);
        if (organisationId) search.set("organisationId", organisationId);
        search.set("limit", String(limit ?? 20));
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/generated-videos?${search}`);
      },
    ),
    makeTool(
      "studio_attach_to_task",
      "Attach a finished studio image (imageId) or clip (videoId) to a task as a file, so it sits with the task's attachments for the board. issueId defaults to the task it was made for. Large clips can be over the attachment size limit; then link the clip instead.",
      mcpToolHints("write"),
      z.object({
        imageId: z.string().guid().optional(),
        videoId: z.string().guid().optional(),
        issueId: z.string().guid().optional(),
      }),
      async ({ imageId, videoId, issueId }) => {
        if (Boolean(imageId) === Boolean(videoId)) throw new Error("Give imageId or videoId, not both");
        const kind = imageId ? "image" : "clip";
        const made = await client.requestJson<StudioMadeFile>(
          "GET",
          imageId ? `/generated-images/${encodeURIComponent(imageId)}` : `/generated-videos/${encodeURIComponent(videoId!)}`,
        );
        if (made.status !== "completed" || !made.assetId) {
          throw new Error(`That ${kind} is not finished yet (status ${made.status}). Wait until it is completed, then attach it.`);
        }
        const target = issueId ?? made.issue?.id;
        if (!target) throw new Error(`That ${kind} is not linked to a task; say which task with issueId`);
        const file = await client.requestBytes(`/assets/${encodeURIComponent(made.assetId)}/content`);
        const form = new FormData();
        form.set("file", new Blob([file.body], { type: file.contentType }), studioFileName(made.prompt, file.contentType));
        const attachment = await client.requestForm(
          `/companies/${encodeURIComponent(made.companyId)}/issues/${encodeURIComponent(target)}/attachments`,
          form,
        );
        return { issueId: target, ...(imageId ? { imageId } : { videoId }), attachment };
      },
    ),
    makeTool(
      "studio_list_looks",
      "List the company's house looks: saved style, camera and words by name. Use one when a client's images or clips must match; pass its id as lookId.",
      mcpToolHints("read"),
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/studio-looks`),
    ),
    makeTool(
      "studio_save_look",
      "Save a house look (name, optional description, style, camera and words to add every time) so later images and clips match. Names must be unique in the company.",
      mcpToolHints("write"),
      createStudioLookSchema.extend({ companyId: companyIdOptional }),
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/studio-looks`, { body }),
    ),
  ];
}
