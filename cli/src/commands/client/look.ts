import { Command } from "commander";
import {
  IMAGE_STYLE_PRESETS,
  parseImageStyle,
  type StudioLook,
  type StudioLooksResponse,
} from "@greatstone/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";
import { cameraFromOptions } from "./image.js";

interface LookSaveOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  style?: string;
  camera?: string;
  lens?: string;
  focal?: string;
  aperture?: string;
  words?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STYLE_HELP = IMAGE_STYLE_PRESETS.map((preset) => preset.id).join(", ");

/** Turns a house look name (any case) or id into its id, saying which looks exist when none match. */
export async function resolveLookId(
  ctx: Pick<ResolvedClientContext, "api" | "companyId">,
  value: string | undefined,
): Promise<string | null> {
  const wanted = value?.trim();
  if (!wanted) return null;
  if (UUID.test(wanted)) return wanted;
  const response = await ctx.api.get<StudioLooksResponse>(apiPath`/api/companies/${ctx.companyId!}/studio-looks`);
  const looks = response?.looks ?? [];
  const match = looks.find((look) => look.name.toLowerCase() === wanted.toLowerCase());
  if (match) return match.id;
  throw new Error(
    looks.length
      ? `No house look called "${wanted}". Saved looks: ${looks.map((look) => look.name).join(", ")}`
      : `No house look called "${wanted}". None are saved yet; add one with gsam look save.`,
  );
}

export function registerLookCommands(program: Command): void {
  const look = program
    .command("look")
    .description("House looks: a company's saved style, camera and words for matching images and clips");

  addCommonClientOptions(
    look
      .command("list")
      .description("List the company's house looks")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const response = await ctx.api.get<StudioLooksResponse>(apiPath`/api/companies/${ctx.companyId}/studio-looks`);
          if (ctx.json) {
            printOutput(response, { json: true });
            return;
          }
          printOutput(
            (response?.looks ?? []).map((item) => ({
              id: item.id,
              name: item.name,
              style: item.style ?? "",
              words: item.words ?? "",
            })),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    look
      .command("save")
      .description("Save a house look. Use it with --look on gsam image generate or gsam video generate")
      .requiredOption("--name <name>", "What to call the look, such as \"Acme product shots\"")
      .option("--description <text>", "When to use it")
      .option("--style <style>", `Optional style: ${STYLE_HELP}`)
      .option("--camera <camera>", "Optional cinema camera, as for gsam image generate")
      .option("--lens <lens>", "Optional lens, as for gsam image generate")
      .option("--focal <mm>", "Optional focal length, as for gsam image generate")
      .option("--aperture <f>", "Optional aperture, as for gsam image generate")
      .option("--words <text>", "Words to add to every description, such as brand colours or lighting")
      .action(async (opts: LookSaveOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const style = opts.style?.trim() ? parseImageStyle(opts.style) : null;
          if (opts.style?.trim() && !style) throw new Error(`Unknown style "${opts.style}". Use one of: ${STYLE_HELP}`);
          const camera = cameraFromOptions(opts);
          const saved = await ctx.api.post<StudioLook>(apiPath`/api/companies/${ctx.companyId}/studio-looks`, {
            name: opts.name,
            ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
            ...(style ? { style } : {}),
            ...(camera ? { camera } : {}),
            ...(opts.words?.trim() ? { words: opts.words.trim() } : {}),
          });
          printOutput(saved, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    look
      .command("delete")
      .description("Delete a house look. Images and clips already made keep their settings")
      .argument("<look>", "The look's name or id")
      .action(async (value: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const id = await resolveLookId(ctx, value);
          await ctx.api.delete(apiPath`/api/studio-looks/${id!}`);
          printOutput({ deleted: id }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
