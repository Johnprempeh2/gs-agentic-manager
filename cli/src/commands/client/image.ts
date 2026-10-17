import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  IMAGE_SHAPE_OPTIONS,
  IMAGE_STYLE_PRESETS,
  parseImageShape,
  parseImageStyle,
  parseStudioChoice,
  STUDIO_APERTURES,
  STUDIO_CAMERAS,
  STUDIO_FOCAL_LENGTHS,
  STUDIO_LENSES,
  STUDIO_MAX_VARIATIONS,
  type StudioCameraSettings,
  type GeneratedImage,
  type GeneratedImagesResponse,
  type ImageGenerationStatus,
} from "@greatstone/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

interface ImageGenerateOptions extends BaseClientOptions {
  prompt?: string;
  shape?: string;
  style?: string;
  issueId?: string;
  out?: string;
  wait?: boolean;
  timeout?: string;
  camera?: string;
  lens?: string;
  focal?: string;
  aperture?: string;
  count?: string;
}

interface ImageListOptions extends BaseClientOptions {
  limit?: string;
}

const SHAPE_HELP = IMAGE_SHAPE_OPTIONS.map((option) => `${option.cliName} (${option.value})`).join(", ");
const STYLE_HELP = IMAGE_STYLE_PRESETS.map((preset) => `${preset.id} (${preset.label})`).join(", ");
const CAMERA_HELP = STUDIO_CAMERAS.map((item) => item.id).join(", ");
const LENS_HELP = STUDIO_LENSES.map((item) => item.id).join(", ");
const FOCAL_HELP = STUDIO_FOCAL_LENGTHS.map((item) => item.value).join(", ");
const APERTURE_HELP = STUDIO_APERTURES.map((item) => item.label).join(", ");
const POLL_INTERVAL_MS = 3_000;

function unknownChoice(flag: string, raw: string, help: string): never {
  throw new Error(`Unknown ${flag} "${raw}". Use one of: ${help}`);
}

/** Reads the --camera, --lens, --focal and --aperture flags; throws on an unknown value. */
export function cameraFromOptions(opts: Pick<ImageGenerateOptions, "camera" | "lens" | "focal" | "aperture">): StudioCameraSettings | null {
  const settings: StudioCameraSettings = {};
  if (opts.camera?.trim()) {
    settings.camera = (parseStudioChoice(STUDIO_CAMERAS, opts.camera) ?? unknownChoice("camera", opts.camera, CAMERA_HELP)).id;
  }
  if (opts.lens?.trim()) {
    settings.lens = (parseStudioChoice(STUDIO_LENSES, opts.lens) ?? unknownChoice("lens", opts.lens, LENS_HELP)).id;
  }
  if (opts.focal?.trim()) {
    settings.focalLength = (
      parseStudioChoice(STUDIO_FOCAL_LENGTHS, opts.focal) ?? unknownChoice("focal length", opts.focal, FOCAL_HELP)
    ).value;
  }
  if (opts.aperture?.trim()) {
    settings.aperture = (
      parseStudioChoice(STUDIO_APERTURES, opts.aperture) ?? unknownChoice("aperture", opts.aperture, APERTURE_HELP)
    ).id;
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

export function registerImageCommands(program: Command): void {
  const image = program.command("image").description("Make images from a description");

  addCommonClientOptions(
    image
      .command("generate")
      .description("Make an image from a description, wait for it, and optionally attach it to a task")
      .requiredOption("--prompt <text>", "What the image should show")
      .option("--shape <shape>", `Image shape: ${SHAPE_HELP}`, "square")
      .option("--style <style>", `Optional look: ${STYLE_HELP}`)
      .option("--issue-id <id>", "Link the image to this task and attach it when finished")
      .option("--camera <camera>", `Optional cinema camera: ${CAMERA_HELP}`)
      .option("--lens <lens>", `Optional lens: ${LENS_HELP}`)
      .option("--focal <mm>", `Optional focal length in mm: ${FOCAL_HELP}`)
      .option("--aperture <f>", `Optional aperture: ${APERTURE_HELP}`)
      .option("--count <n>", `How many versions to make, 1 to ${STUDIO_MAX_VARIATIONS}`, "1")
      .option("--out <path>", "Also save the finished image to this file (with --count, a number is added)")
      .option("--no-wait", "Return as soon as the request is accepted")
      .option("--timeout <seconds>", "How long to wait for the image", "300")
      .action(async (opts: ImageGenerateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const aspectRatio = parseImageShape(opts.shape);
          if (!aspectRatio) throw new Error(`Unknown shape "${opts.shape}". Use one of: ${SHAPE_HELP}`);
          const style = opts.style?.trim() ? parseImageStyle(opts.style) : null;
          if (opts.style?.trim() && !style) throw new Error(`Unknown style "${opts.style}". Use one of: ${STYLE_HELP}`);
          const camera = cameraFromOptions(opts);
          const count = Number(opts.count ?? "1");
          if (!Number.isInteger(count) || count < 1 || count > STUDIO_MAX_VARIATIONS) {
            throw new Error(`--count must be a whole number from 1 to ${STUDIO_MAX_VARIATIONS}`);
          }
          const issueId = opts.issueId?.trim() || null;
          const requests: GeneratedImage[] = [];
          for (let index = 0; index < count; index += 1) {
            const created = await ctx.api.post<GeneratedImage>(
              apiPath`/api/companies/${ctx.companyId}/generated-images`,
              {
                prompt: opts.prompt,
                aspectRatio,
                ...(style ? { style } : {}),
                ...(camera ? { camera } : {}),
                ...(issueId ? { issueId } : {}),
              },
            );
            if (!created) throw new Error("The server did not return the image request");
            requests.push(created);
          }
          if (opts.wait === false) {
            printOutput(count === 1 ? requests[0] : { images: requests }, { json: ctx.json });
            return;
          }
          const timeoutSeconds = Number(opts.timeout);
          const timeoutMs = Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 300_000;
          const results: Array<Record<string, unknown>> = [];
          for (const [index, request] of requests.entries()) {
            const finished = await waitForImage(ctx, request.id, timeoutMs);
            if (finished.status === "failed") {
              if (count === 1) throw new Error(finished.error ?? "The image could not be made");
              results.push({ image: finished });
              continue;
            }
            if (finished.status !== "completed" || !finished.assetId) {
              if (count === 1) {
                throw new Error(`The image is still being made. Check it later with: gsam image get ${finished.id}`);
              }
              results.push({ image: finished });
              continue;
            }
            const result: Record<string, unknown> = { image: finished };
            if (opts.out?.trim() || issueId) {
              const bytes = await downloadAsset(ctx, finished.assetId);
              if (opts.out?.trim()) {
                const out = count === 1 ? opts.out : numberedPath(opts.out, index + 1);
                await writeFile(out, bytes.body);
                result.out = out;
              }
              if (issueId) result.attachment = await attachToIssue(ctx, issueId, bytes, finished);
            }
            results.push(result);
          }
          if (count > 1 && results.every((result) => (result.image as GeneratedImage).status !== "completed")) {
            throw new Error("None of the images could be made");
          }
          printOutput(count === 1 ? results[0] : { images: results }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    image
      .command("get")
      .description("Show one generated image and its status")
      .argument("<imageId>", "Generated image ID")
      .action(async (imageId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get<GeneratedImage>(apiPath`/api/generated-images/${imageId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    image
      .command("list")
      .description("List images made for the company, newest first")
      .option("--limit <n>", "How many to show", "20")
      .action(async (opts: ImageListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const response = await ctx.api.get<GeneratedImagesResponse>(
            `${apiPath`/api/companies/${ctx.companyId}/generated-images`}?limit=${encodeURIComponent(opts.limit ?? "20")}`,
          );
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          printOutput(
            (response?.images ?? []).map((item) => ({
              id: item.id,
              status: item.status,
              shape: item.aspectRatio,
              prompt: item.prompt.length > 60 ? `${item.prompt.slice(0, 57)}...` : item.prompt,
            })),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    image
      .command("status")
      .description("Show whether image generation is set up and which service it uses")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get<ImageGenerationStatus>(apiPath`/api/companies/${ctx.companyId}/image-generation`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

export async function waitForImage(
  ctx: Pick<ResolvedClientContext, "api">,
  imageId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<GeneratedImage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await ctx.api.get<GeneratedImage>(apiPath`/api/generated-images/${imageId}`);
    if (!current) throw new Error("Image not found");
    if (current.status !== "pending" || Date.now() >= deadline) return current;
    await sleep(POLL_INTERVAL_MS);
  }
}

function authHeaders(ctx: ResolvedClientContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ctx.api.apiKey) headers.authorization = `Bearer ${ctx.api.apiKey}`;
  if (ctx.api.runId) headers["x-paperclip-run-id"] = ctx.api.runId;
  return headers;
}

async function downloadAsset(ctx: ResolvedClientContext, assetId: string) {
  const response = await fetch(buildApiUrl(ctx.api.apiBase, apiPath`/api/assets/${assetId}/content`), {
    headers: authHeaders(ctx),
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, `Could not download the image (status ${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "image/png";
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}

async function attachToIssue(
  ctx: ResolvedClientContext,
  issueId: string,
  file: { body: Buffer; contentType: string },
  image: GeneratedImage,
) {
  const extension = file.contentType === "image/jpeg" ? "jpg" : file.contentType === "image/webp" ? "webp" : "png";
  const slug = image.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "image";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file.body)], { type: file.contentType }), `${slug}.${extension}`);
  const response = await fetch(
    buildApiUrl(ctx.api.apiBase, apiPath`/api/companies/${ctx.companyId}/issues/${issueId}/attachments`),
    { method: "POST", headers: authHeaders(ctx), body: form },
  );
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Could not attach the image to the task (status ${response.status})`;
    throw new ApiRequestError(response.status, message, undefined, parsed);
  }
  return parsed;
}

/** image.png becomes image-2.png, for the second version. */
export function numberedPath(path: string, number: number): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash + 1) return `${path}-${number}`;
  return `${path.slice(0, dot)}-${number}${path.slice(dot)}`;
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
