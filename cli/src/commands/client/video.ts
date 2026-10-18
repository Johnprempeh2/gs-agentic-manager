import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  VIDEO_MODELS,
  VIDEO_MOTION_PRESETS,
  type GeneratedVideo,
  type GeneratedVideosResponse,
  type VideoGenerationStatus,
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
import { resolveLookId } from "./look.js";
import { authHeaders, buildApiUrl, cameraFromOptions } from "./image.js";

interface VideoGenerateOptions extends BaseClientOptions {
  look?: string;
  prompt?: string;
  model?: string;
  duration?: string;
  image?: string;
  motion?: string;
  camera?: string;
  lens?: string;
  focal?: string;
  aperture?: string;
  issueId?: string;
  out?: string;
  wait?: boolean;
  timeout?: string;
}

const MODEL_HELP = VIDEO_MODELS.map((model) => `${model.id} (${model.durations.join(" or ")}s${model.textPath ? "" : ", needs --image"})`).join(", ");
const MOTION_HELP = VIDEO_MOTION_PRESETS.map((preset) => preset.id).join(", ");
const POLL_INTERVAL_MS = 5_000;

export function registerVideoCommands(program: Command): void {
  const video = program.command("video").description("Make short videos from a description or an image");

  addCommonClientOptions(
    video
      .command("generate")
      .description("Make a short clip, wait for it, and optionally attach it to a task")
      .requiredOption("--prompt <text>", "What the clip should show, or what should happen in the image")
      .option("--model <model>", `Video model: ${MODEL_HELP}`, "kling-2.5-turbo-pro")
      .option("--duration <seconds>", "Clip length the model offers; defaults to its shortest")
      .option("--image <imageId>", "Animate this finished studio image (from gsam image generate or list)")
      .option("--motion <motion>", `Optional camera movement: ${MOTION_HELP}`)
      .option("--camera <camera>", "Optional cinema camera, as for gsam image generate")
      .option("--lens <lens>", "Optional lens, as for gsam image generate")
      .option("--focal <mm>", "Optional focal length, as for gsam image generate")
      .option("--aperture <f>", "Optional aperture, as for gsam image generate")
      .option("--look <name>", "Use a saved house look (see gsam look list); your own flags win")
      .option("--issue-id <id>", "Link the clip to this task and attach it when finished")
      .option("--out <path>", "Also save the finished clip to this file")
      .option("--no-wait", "Return as soon as the request is accepted")
      .option("--timeout <seconds>", "How long to wait for the clip", "900")
      .action(async (opts: VideoGenerateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const model = VIDEO_MODELS.find((item) => item.id === opts.model?.trim().toLowerCase());
          if (!model) throw new Error(`Unknown model "${opts.model}". Use one of: ${MODEL_HELP}`);
          const motion = opts.motion?.trim() ? VIDEO_MOTION_PRESETS.find((item) => item.id === opts.motion?.trim().toLowerCase()) : null;
          if (opts.motion?.trim() && !motion) throw new Error(`Unknown motion "${opts.motion}". Use one of: ${MOTION_HELP}`);
          const duration = opts.duration?.trim() ? Number(opts.duration) : undefined;
          if (duration !== undefined && !(model.durations as readonly number[]).includes(duration)) {
            throw new Error(`${model.label} makes ${model.durations.join(" or ")} second clips`);
          }
          const sourceImageId = opts.image?.trim() || null;
          if (!sourceImageId && !model.textPath) throw new Error(`${model.label} only animates an image. Add --image <imageId>.`);
          const camera = cameraFromOptions(opts);
          const lookId = await resolveLookId(ctx, opts.look);
          const issueId = opts.issueId?.trim() || null;
          const created = await ctx.api.post<GeneratedVideo>(apiPath`/api/companies/${ctx.companyId}/generated-videos`, {
            prompt: opts.prompt,
            model: model.id,
            ...(duration ? { duration } : {}),
            ...(motion ? { motion: motion.id } : {}),
            ...(camera ? { camera } : {}),
            ...(lookId ? { lookId } : {}),
            ...(sourceImageId ? { sourceImageId } : {}),
            ...(issueId ? { issueId } : {}),
          });
          if (!created) throw new Error("The server did not return the clip request");
          if (opts.wait === false) {
            printOutput(created, { json: ctx.json });
            return;
          }
          const timeoutSeconds = Number(opts.timeout);
          const finished = await waitForVideo(ctx, created.id, Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 900_000);
          if (finished.status === "failed") throw new Error(finished.error ?? "The clip could not be made");
          if (finished.status !== "completed" || !finished.assetId) {
            throw new Error(`The clip is still being made. Check it later with: gsam video get ${finished.id}`);
          }
          const result: Record<string, unknown> = { video: finished };
          if (opts.out?.trim() || issueId) {
            const file = await downloadClip(ctx, finished.assetId);
            if (opts.out?.trim()) {
              await writeFile(opts.out, file.body);
              result.out = opts.out;
            }
            if (issueId) result.attachment = await attachClip(ctx, issueId, file, finished);
          }
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    video
      .command("get")
      .description("Show one clip and its status")
      .argument("<videoId>", "Generated video ID")
      .action(async (videoId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get<GeneratedVideo>(apiPath`/api/generated-videos/${videoId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    video
      .command("list")
      .description("List clips made for the company, newest first")
      .option("--limit <n>", "How many to show", "20")
      .option("--favourites", "Show only clips starred as favourites")
      .action(async (opts: BaseClientOptions & { limit?: string; favourites?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const search = new URLSearchParams({ limit: opts.limit ?? "20" });
          if (opts.favourites) search.set("favourite", "true");
          const response = await ctx.api.get<GeneratedVideosResponse>(
            `${apiPath`/api/companies/${ctx.companyId}/generated-videos`}?${search}`,
          );
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          printOutput(
            (response?.videos ?? []).map((item) => ({
              id: item.id,
              status: item.status,
              model: item.model,
              seconds: item.durationSeconds,
              favourite: item.favourite ? "yes" : "",
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
    video
      .command("cancel")
      .description("Stop a clip that is waiting or being made (for example, a long one on this PC's graphics card)")
      .argument("<videoId>", "Generated video ID")
      .action(async (videoId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post<GeneratedVideo>(apiPath`/api/generated-videos/${videoId}/cancel`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    video
      .command("favourite")
      .description("Star a finished clip as a favourite (a keeper), or unstar it with --off")
      .argument("<videoId>", "Generated video ID")
      .option("--off", "Remove the star")
      .action(async (videoId: string, opts: BaseClientOptions & { off?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(
            await ctx.api.patch<GeneratedVideo>(apiPath`/api/generated-videos/${videoId}/favourite`, { favourite: !opts.off }),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    video
      .command("status")
      .description("Show whether video making is set up")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get<VideoGenerationStatus>(apiPath`/api/companies/${ctx.companyId}/video-generation`), {
            json: ctx.json,
          });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

export async function waitForVideo(
  ctx: Pick<ResolvedClientContext, "api">,
  videoId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<GeneratedVideo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await ctx.api.get<GeneratedVideo>(apiPath`/api/generated-videos/${videoId}`);
    if (!current) throw new Error("Clip not found");
    if (current.status !== "pending" || Date.now() >= deadline) return current;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function downloadClip(ctx: ResolvedClientContext, assetId: string) {
  const response = await fetch(buildApiUrl(ctx.api.apiBase, apiPath`/api/assets/${assetId}/content`), { headers: authHeaders(ctx) });
  if (!response.ok) throw new ApiRequestError(response.status, `Could not download the clip (status ${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "video/mp4";
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}

async function attachClip(ctx: ResolvedClientContext, issueId: string, file: { body: Buffer; contentType: string }, clip: GeneratedVideo) {
  const slug = clip.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "clip";
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file.body)], { type: file.contentType }), `${slug}.${file.contentType === "video/webm" ? "webm" : "mp4"}`);
  const response = await fetch(buildApiUrl(ctx.api.apiBase, apiPath`/api/companies/${ctx.companyId}/issues/${issueId}/attachments`), {
    method: "POST",
    headers: authHeaders(ctx),
    body: form,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Could not attach the clip to the task (status ${response.status})`;
    throw new ApiRequestError(response.status, message, undefined, parsed);
  }
  return parsed;
}
