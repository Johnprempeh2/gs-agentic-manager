import { z } from "zod";
import {
  createGeneratedImageSchema,
  IMAGE_STYLE_PRESETS,
  mcpToolHints,
  STUDIO_APERTURES,
  STUDIO_CAMERAS,
  STUDIO_FOCAL_LENGTHS,
  STUDIO_LENSES,
  STUDIO_MAX_VARIATIONS,
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
});

const STUDIO_MAKE_IMAGE_DESCRIPTION = [
  "Make one or more images from a written description in the GSAM image studio. Answers at once with pending images;",
  "poll studio_get_image until status is completed (contentPath set) or failed (error says why). Each image costs money, so make what the task needs.",
  `aspectRatio: 1:1, 16:9, 9:16, 4:3 or 3:4. style: ${IMAGE_STYLE_PRESETS.map((preset) => preset.id).join(", ")}.`,
  `camera (all optional): camera ${STUDIO_CAMERAS.map((item) => item.id).join(", ")}; lens ${STUDIO_LENSES.map((item) => item.id).join(", ")};`,
  `focalLength ${STUDIO_FOCAL_LENGTHS.map((item) => item.value).join(", ")}; aperture ${STUDIO_APERTURES.map((item) => item.id).join(", ")}.`,
  `count: 1 to ${STUDIO_MAX_VARIATIONS} versions. issueId links the image to a task; organisationId to a client.`,
].join(" ");

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
      async ({ companyId, count, ...body }) => {
        const path = `/companies/${client.resolveCompanyId(companyId)}/generated-images`;
        const images: unknown[] = [];
        for (let index = 0; index < count; index += 1) {
          images.push(await client.requestJson("POST", path, { body }));
        }
        return { images };
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
  ];
}
