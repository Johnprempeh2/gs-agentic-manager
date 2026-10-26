import {
  checkWebsiteEditorOrigin,
  isWebsiteFrameAssetUrl,
  type WebsiteFrameInsertMediaResult,
  type WebsiteFrameMediaEntry,
  type WebsiteFrameSetMotionResult,
  type WebsiteMotionChoice,
  type WebsiteBackgroundSurface,
  type WebsiteMotionColour,
  type WebsiteMotionIntensity,
  type WebsiteMotionSpeed,
  type WebsiteMediaItem,
  type WebsitePageEditorLoad,
  type WebsiteRevision,
  type WebsiteSaveResult,
  type WebsiteSite,
} from "@greatstone/shared";
import { ApiError } from "../api/client";
import type {
  WebsiteFrameConnection,
  WebsiteFrameDraft,
  WebsiteFrameMotionCapabilities,
  WebsiteFrameSaveAnswer,
  WebsiteFrameSaveRequest,
} from "./website-frame-host";

// Glue between the Website editor workspace and the frame host session
// (GRE-2118): what GSAM sends the frame, and how GSAM's save answers become
// the frame contract's `save-result`. No React, so it is tested directly.

/** Rule C1.1 again on open: GSAM never frames an origin it is served from, or the public site. */
export function editorOpenProblem(
  site: Pick<WebsiteSite, "domain" | "editorFrameOrigin">,
  gsamOrigin: string,
  allowLocalhost: boolean,
): string | null {
  if (!site.editorFrameOrigin) return "missing";
  const problem = checkWebsiteEditorOrigin(site.editorFrameOrigin, {
    publicOrigin: `https://${site.domain}`,
    gsamOrigins: [gsamOrigin],
    allowLocalhost,
  });
  return problem;
}

export type FetchBlob = (path: string) => Promise<Blob>;

export const fetchAssetBlob: FetchBlob = async (path) => {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`An image could not be loaded (${response.status}).`);
  return response.blob();
};

/** `load-draft.media`: each image as a `Blob`, keyed by asset id, so the frame never calls GSAM. */
export async function frameMedia(media: WebsiteMediaItem[], fetchBlob: FetchBlob): Promise<WebsiteFrameDraft["media"]> {
  const entries = await Promise.all(
    media.map(async (item) => [item.assetId, { blob: await fetchBlob(item.contentPath), alt: item.alt, width: item.width, height: item.height }] as const),
  );
  return Object.fromEntries(entries);
}

/** The frame's draft from the editor-load answer. `content` replaces the data (live preview shows the published revision). */
export async function frameDraft(
  load: WebsitePageEditorLoad,
  fetchBlob: FetchBlob,
  override?: { revisionId: string; data: unknown },
): Promise<WebsiteFrameDraft> {
  return {
    revisionId: override?.revisionId ?? load.revisionId,
    data: override?.data ?? load.data,
    theme: load.theme,
    media: await frameMedia(load.media, fetchBlob),
    site: load.site,
  };
}

/**
 * `insert-media.media`: the picked item as a `Blob`, like a `load-draft.media`
 * entry, so the frame shows it before save and reload (GRE-2226). Undefined
 * when it cannot be fetched: `insert-media` still goes, without it.
 */
export async function insertMediaEntry(
  item: { contentPath: string; alt: string; width: number | null; height: number | null },
  fetchBlob: FetchBlob,
): Promise<WebsiteFrameMediaEntry | undefined> {
  try {
    return { blob: await fetchBlob(item.contentPath), alt: item.alt, width: item.width, height: item.height };
  } catch {
    return undefined;
  }
}

const NOT_RETRYABLE = new Set(["origin-changed", "invalid", "archived"]);

export interface SaveDependencies {
  save: (body: { baseRevisionId: string; content: unknown; editorOrigin: string }) => Promise<WebsiteSaveResult>;
  /** The page's latest content and history, read after a conflict. */
  latest: () => Promise<{ content: unknown; revisions: WebsiteRevision[] }>;
  now?: () => Date;
}

/** One save from the frame through GSAM's API, answered in the frame contract's terms. */
export async function saveThroughGsam(request: WebsiteFrameSaveRequest, deps: SaveDependencies): Promise<WebsiteFrameSaveAnswer> {
  let result: WebsiteSaveResult;
  try {
    result = await deps.save({ baseRevisionId: request.baseRevisionId, content: request.data, editorOrigin: request.editorOrigin });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return {
        outcome: "failed",
        code: error.status === 403 ? "forbidden" : "not-found",
        message: error.status === 403 ? "You can view this site but not edit its pages." : "This page is gone. Reload the page list.",
        retryable: false,
      };
    }
    throw error;
  }
  if (result.state === "saved") {
    return { outcome: "saved", revisionId: result.revisionId, savedAt: (deps.now?.() ?? new Date()).toISOString() };
  }
  if (result.state === "failed") {
    const code = result.code ?? "error";
    return { outcome: "failed", code, message: result.message, retryable: !NOT_RETRYABLE.has(code) };
  }
  const latest = await deps.latest();
  const newest = latest.revisions[0];
  return {
    outcome: "conflict",
    currentRevisionId: newest?.id ?? result.latestRevisionId ?? "",
    currentData: latest.content,
    // The frame already holds every media item from load-draft.
    currentMedia: {},
    savedBy: newest?.createdByAgentId ? "an agent" : "a teammate",
    savedAt: newest?.createdAt ?? new Date().toISOString(),
  };
}

/** What the workspace says about the frame's connection (contract section 5.1), or null when it is working. */
export function frameConnectionMessage(connection: WebsiteFrameConnection, editorOrigin: string): string | null {
  switch (connection.phase) {
    case "no-answer":
      return `The site's editor did not answer. Check that ${editorOrigin} is deployed and that GSAM_EDITOR_ORIGINS includes this GSAM address.`;
    case "refused-protocol":
      return `This site's editor speaks protocol ${connection.supported.join(", ") || "none"}; GSAM speaks 1. Update the site engine or GSAM.`;
    case "refused-site":
      return "This address serves a different site.";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- insert-media (GRE-2206)

export type InsertMediaKind = "image" | "animation";

const MEDIA_FIELD_NAMES: Record<InsertMediaKind, readonly string[]> = {
  image: ["image", "media", "photo", "picture", "background", "video"],
  animation: ["video", "animation", "clip", "media", "image", "background"],
};

const MEDIA_PATH_PATTERNS: Record<InsertMediaKind, RegExp> = {
  image: /^[^\s]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^\s]*)?$/i,
  animation: /^[^\s]+\.(?:gif|m4v|mov|mp4|ogv|webm)(?:[?#][^\s]*)?$/i,
};

function findBlock(items: unknown, blockId: string, depth = 0): { type: unknown; props: Record<string, unknown> } | null {
  if (!Array.isArray(items) || depth > 20) return null;
  for (const item of items) {
    const props = (item as { props?: unknown } | null)?.props;
    if (typeof props !== "object" || props === null) continue;
    const record = props as Record<string, unknown>;
    if (record.id === blockId) return { type: (item as { type?: unknown }).type, props: record };
    for (const value of Object.values(record)) {
      const found = findBlock(value, blockId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findBlockProps(items: unknown, blockId: string): Record<string, unknown> | null {
  return findBlock(items, blockId)?.props ?? null;
}

/**
 * The block field `insert-media` names. GSAM does not know the site's block
 * schemas, so it guesses from the block's props: a field that already holds a
 * `media:` reference first, then a field that holds a site path or URL of the
 * kind's file type (for example `/images/before.jpg`), then a field with a
 * usual media name. The frame
 * checks the field and answers `field_not_found` or `field_not_media` when the
 * guess is wrong.
 */
export function insertMediaField(data: unknown, blockId: string, kind: InsertMediaKind): string {
  const props = findBlockProps((data as { content?: unknown } | null)?.content, blockId) ?? {};
  const names = Object.keys(props).filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name));
  const holdsMedia = names.find((name) => typeof props[name] === "string" && (props[name] as string).startsWith("media:"));
  if (holdsMedia) return holdsMedia;
  const holdsPath = names.find((name) => typeof props[name] === "string" && MEDIA_PATH_PATTERNS[kind].test(props[name] as string));
  if (holdsPath) return holdsPath;
  const preferred = MEDIA_FIELD_NAMES[kind];
  return preferred.find((name) => names.includes(name)) ?? preferred[0]!;
}

/**
 * `insert-media.assetUrl`: GSAM's asset address as an absolute https URL when
 * GSAM is served over https, otherwise the root-relative path. The frame only
 * uses it to show the item until the next load; the saved page keeps the
 * `media:` reference.
 */
export function insertMediaAssetUrl(contentPath: string, gsamOrigin: string): string {
  try {
    const absolute = new URL(contentPath, gsamOrigin).href;
    if (isWebsiteFrameAssetUrl(absolute)) return absolute;
  } catch {
    // fall through to the path
  }
  return contentPath;
}

const KIND_NOUN: Record<InsertMediaKind, string> = { image: "image", animation: "animation" };

/**
 * What the media panel says after the frame answered `insert-media`, naming
 * the block. The site's own `message` is not shown; it goes to the console.
 */
export function insertMediaMessage(result: WebsiteFrameInsertMediaResult, blockName: string, kind: InsertMediaKind): string {
  const noun = KIND_NOUN[kind];
  if (result.ok) return `Put in ${blockName}. Save the page to keep it.`;
  const kept = `The ${noun} is saved in Website media.`;
  switch (result.code) {
    case "block_not_found":
      return `${blockName} is no longer on this page, so nothing changed. ${kept}`;
    case "field_not_found":
    case "field_not_media":
      return `${blockName} has no image or video field, so nothing changed. ${kept} Pick it from an image field in the editor.`;
    case "invalid_payload":
      return `The site's editor could not use this ${noun}, so nothing changed. ${kept}`;
    default:
      if (result.message) console.warn("insert-media refused:", result.message);
      return `The site's editor did not put the ${noun} in ${blockName}, so nothing changed. ${kept}`;
  }
}

// ---------------------------------------------------------------- set-motion (GRE-2219, GRE-2526)

/** The safe settings an effect takes, from the engine's `hello-ack`. */
export interface MotionEffectSettings {
  intensity: WebsiteMotionIntensity[];
  speed: WebsiteMotionSpeed[];
  colour: WebsiteMotionColour[];
  defaults: { intensity: WebsiteMotionIntensity; speed: WebsiteMotionSpeed; colour: WebsiteMotionColour };
}

/** One choice in the Background panel. `still` and `preview` are paths on the editor origin; None has neither. */
export interface MotionOption {
  id: string;
  label: string;
  still: string | null;
  /** The Animation Lab study the effect comes from, for example `016`. */
  study: string | null;
  /** One line on what the effect looks like. Null on an engine from before GRE-2522. */
  description?: string | null;
  /** A live, animated page of the effect. Null on an engine from before GRE-2522. */
  preview?: string | null;
  /** Speed and colour choices. Null: the effect takes strength only. */
  settings?: MotionEffectSettings | null;
}

/** What the block's Background holds: an effect with its settings, or a plain surface. */
export interface BackgroundSelection {
  effect: string;
  intensity: WebsiteMotionIntensity;
  speed?: WebsiteMotionSpeed;
  colour?: WebsiteMotionColour;
  /** A site surface id, or `none`. Only with effect `none`. */
  surface: string;
}

export interface BlockMotionOptions {
  blockType: string;
  options: MotionOption[];
  /** The plain site surfaces the block can take. Empty on an engine from before GRE-2522. */
  surfaces: WebsiteBackgroundSurface[];
  /** What the block holds in the page GSAM last loaded, or the block's default. */
  current: WebsiteMotionChoice;
  /** The block's saved surface, `none` when it has none. */
  currentSurface: string;
}

export const MOTION_INTENSITY_LABELS: Record<WebsiteMotionIntensity, string> = { off: "Off", subtle: "Subtle", full: "Full" };
export const MOTION_SPEED_LABELS: Record<WebsiteMotionSpeed, string> = { still: "Still", slow: "Slow", normal: "Normal" };
export const MOTION_COLOUR_LABELS: Record<WebsiteMotionColour, string> = { emerald: "Emerald", teal: "Teal" };

const NONE_OPTION: MotionOption = { id: "none", label: "None", still: null, study: null };

/**
 * GRE-2522: the Two Doors home page is frozen. GSAM offers no Background on
 * any Two Doors block, or on any block of a home page that holds Two Doors,
 * without John's explicit yes. The engine refuses it too (`frozen_page`).
 */
export function isFrozenBackground(pageSlug: string | null | undefined, blockType: string | null | undefined, data: unknown): boolean {
  if (isTwoDoorsType(blockType)) return true;
  const slug = (pageSlug ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (slug !== "" && slug !== "home") return false;
  return hasTwoDoorsBlock((data as { content?: unknown } | null)?.content);
}

function isTwoDoorsType(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("TwoDoors");
}

function hasTwoDoorsBlock(items: unknown, depth = 0): boolean {
  if (!Array.isArray(items) || depth > 8) return false;
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const { type, props } = item as { type?: unknown; props?: Record<string, unknown> };
    if (isTwoDoorsType(type)) return true;
    return Object.values(props ?? {}).some((value) => hasTwoDoorsBlock(value, depth + 1));
  });
}

function savedSurface(props: Record<string, unknown>, surfaces: readonly WebsiteBackgroundSurface[]): string {
  const section = props._section as { surface?: unknown } | undefined;
  const surface = section && typeof section.surface === "string" ? section.surface : "none";
  return surfaces.some((entry) => entry.id === surface) ? surface : "none";
}

/**
 * The effects the engine lets this block take, in the engine's order, with
 * their names, stills and settings. Null when the block is not on the page or
 * takes no motion. An effect the engine lists for the block but does not
 * describe is left out: GSAM keeps no copy of the effect list.
 */
export function blockMotionOptions(
  capabilities: WebsiteFrameMotionCapabilities,
  data: unknown,
  blockId: string,
): BlockMotionOptions | null {
  const block = findBlock((data as { content?: unknown } | null)?.content, blockId);
  if (!block || typeof block.type !== "string") return null;
  const allowed = capabilities.blocks.get(block.type);
  if (!allowed) return null;
  const options = allowed.effects.flatMap((id): MotionOption[] => {
    if (id === "none") return [NONE_OPTION];
    const effect = capabilities.effects.find((entry) => entry.id === id);
    if (!effect) return [];
    return [
      {
        id,
        label: effect.label,
        still: effect.still,
        study: effect.study ?? null,
        description: effect.description ?? null,
        preview: effect.preview ?? null,
        settings: effect.settings ?? null,
      },
    ];
  });
  const surfaces = (capabilities.surfaces ?? []).filter((entry) => entry.id !== "none");
  if (!options.some((option) => option.id !== "none") && surfaces.length === 0) return null;
  const saved = block.props.motion as Partial<WebsiteMotionChoice> | undefined;
  const current: WebsiteMotionChoice =
    saved && typeof saved.effect === "string" && options.some((option) => option.id === saved.effect) && saved.intensity && saved.intensity in MOTION_INTENSITY_LABELS
      ? {
          effect: saved.effect,
          intensity: saved.intensity,
          ...(saved.speed && saved.speed in MOTION_SPEED_LABELS ? { speed: saved.speed } : {}),
          ...(saved.colour && saved.colour in MOTION_COLOUR_LABELS ? { colour: saved.colour } : {}),
        }
      : { effect: allowed.default.effect, intensity: allowed.default.intensity };
  const currentSurface = current.effect === "none" ? savedSurface(block.props, surfaces) : "none";
  return { blockType: block.type, options, surfaces, current, currentSurface };
}

/** The option a GS Studio hand-off names: an effect id, or a Lab study number such as `016`. */
export function motionOptionFor(options: readonly MotionOption[], wanted: string | null): MotionOption | null {
  if (!wanted) return null;
  return options.find((option) => option.id === wanted || option.study === wanted) ?? null;
}

/** A choice the frame accepts: None is always Off, and an effect is never Off. */
export function motionChoice(effect: string, intensity: WebsiteMotionIntensity): WebsiteMotionChoice {
  if (effect === "none") return { effect, intensity: "off" };
  return { effect, intensity: intensity === "off" ? "subtle" : intensity };
}

/**
 * The `set-motion` body for a Background selection, inside the effect's safe
 * ranges. Speed and colour go only when the effect lists them, and a surface
 * only when the engine offers surfaces: an older engine gets what it knows.
 */
export function backgroundRequest(
  selection: BackgroundSelection,
  option: MotionOption | null,
  surfacesOffered: boolean,
): { motion: WebsiteMotionChoice; surface?: string } {
  if (selection.effect === "none") {
    return { motion: { effect: "none", intensity: "off" }, ...(surfacesOffered ? { surface: selection.surface || "none" } : {}) };
  }
  const settings = option?.settings ?? null;
  const base = motionChoice(selection.effect, selection.intensity);
  if (settings?.intensity.length && !settings.intensity.includes(base.intensity)) base.intensity = settings.defaults.intensity;
  if (base.intensity === "off") base.intensity = "subtle";
  const motion: WebsiteMotionChoice = { ...base };
  if (settings?.speed.length) {
    motion.speed = selection.speed && settings.speed.includes(selection.speed) ? selection.speed : settings.defaults.speed;
  }
  if (settings?.colour.length) {
    motion.colour = selection.colour && settings.colour.includes(selection.colour) ? selection.colour : settings.defaults.colour;
  }
  return { motion };
}

/** The settings in words, for messages and agent requests: `Subtle, slow, emerald`. */
export function backgroundSettingsText(motion: WebsiteMotionChoice): string {
  const parts: string[] = [MOTION_INTENSITY_LABELS[motion.intensity]];
  if (motion.speed) parts.push(MOTION_SPEED_LABELS[motion.speed].toLowerCase());
  if (motion.colour) parts.push(MOTION_COLOUR_LABELS[motion.colour].toLowerCase());
  return parts.join(", ");
}

/**
 * The request an agent gets from Ask an agent in the Background panel: the
 * block, the library effect id and its settings, in the same ids the engine
 * and agents use, then room for what the person wants.
 */
export function backgroundAgentRequest(input: {
  blockId: string;
  blockName: string;
  option: MotionOption | null;
  surface: WebsiteBackgroundSurface | null;
  motion: WebsiteMotionChoice;
}): string {
  const lines = [`Background for ${input.blockName} (block id \`${input.blockId}\`):`];
  if (input.motion.effect !== "none" && input.option) {
    lines.push(`- Effect: \`${input.option.id}\` (${input.option.label})`);
    lines.push(`- Intensity: \`${input.motion.intensity}\``);
    if (input.motion.speed) lines.push(`- Speed: \`${input.motion.speed}\``);
    if (input.motion.colour) lines.push(`- Colour: \`${input.motion.colour}\``);
  } else if (input.surface && input.surface.id !== "none") {
    lines.push(`- Surface: \`${input.surface.id}\` (${input.surface.label})`);
  } else {
    lines.push("- No background (effect `none`)");
  }
  lines.push("- Keep the text-safety rule: quiet zone behind copy, body contrast at least 7:1, no lime behind copy, reduced motion respected.");
  lines.push("", "What I want: ");
  return lines.join("\n");
}

/**
 * What the Background panel says after `set-motion`, naming the block. Null means
 * the frame did not answer: an older engine. The site's own `message` goes to the console.
 */
export function setMotionMessage(result: WebsiteFrameSetMotionResult | null, blockName: string, effectLabel: string, intensity: WebsiteMotionIntensity, settingsText?: string): string {
  if (!result) return "The site's editor did not answer, so nothing changed. Set the background in the block's own fields.";
  if (result.ok) {
    return effectLabel === "None"
      ? `${blockName} has no background now. Save the page in the editor to keep it.`
      : `${effectLabel}, ${settingsText ?? MOTION_INTENSITY_LABELS[intensity]}, is in ${blockName}. Save the page in the editor to keep it.`;
  }
  switch (result.code) {
    case "block_not_found":
      return `${blockName} is no longer on this page, so nothing changed.`;
    case "block_has_no_motion":
      return `${blockName} takes no background, so nothing changed.`;
    case "effect_not_allowed":
      return `${blockName} does not take ${effectLabel}, so nothing changed. Pick another background.`;
    case "frozen_page":
      return "The Two Doors home page is frozen, so nothing changed. Its background changes only with John's yes.";
    default:
      if (result.message) console.warn("set-motion refused:", result.message);
      return `The site's editor did not set the background in ${blockName}, so nothing changed.`;
  }
}

/**
 * The full-screen editor's address (GRE-2296): `/website/edit`, with the
 * website, the page to open and a GS Studio motion hand-off when known.
 */
export function websiteEditorPath(input: { propertyId?: string | null; pageId?: string | null; motion?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (input.propertyId) params.set("property", input.propertyId);
  if (input.pageId) params.set("page", input.pageId);
  if (input.motion) params.set("motion", input.motion);
  const query = params.toString();
  return query ? `/website/edit?${query}` : "/website/edit";
}
