import {
  checkWebsiteEditorOrigin,
  isWebsiteFrameAssetUrl,
  type WebsiteFrameInsertMediaResult,
  type WebsiteMediaItem,
  type WebsitePageEditorLoad,
  type WebsiteRevision,
  type WebsiteSaveResult,
  type WebsiteSite,
} from "@greatstone/shared";
import { ApiError } from "../api/client";
import type { WebsiteFrameConnection, WebsiteFrameDraft, WebsiteFrameSaveAnswer, WebsiteFrameSaveRequest } from "./website-frame-host";

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

function findBlockProps(items: unknown, blockId: string, depth = 0): Record<string, unknown> | null {
  if (!Array.isArray(items) || depth > 20) return null;
  for (const item of items) {
    const props = (item as { props?: unknown } | null)?.props;
    if (typeof props !== "object" || props === null) continue;
    const record = props as Record<string, unknown>;
    if (record.id === blockId) return record;
    for (const value of Object.values(record)) {
      const found = findBlockProps(value, blockId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The block field `insert-media` names. GSAM does not know the site's block
 * schemas, so it guesses from the block's props: a field that already holds a
 * `media:` reference first, then a field with a usual media name. The frame
 * checks the field and answers `field_not_found` or `field_not_media` when the
 * guess is wrong.
 */
export function insertMediaField(data: unknown, blockId: string, kind: InsertMediaKind): string {
  const props = findBlockProps((data as { content?: unknown } | null)?.content, blockId) ?? {};
  const names = Object.keys(props).filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name));
  const holdsMedia = names.find((name) => typeof props[name] === "string" && (props[name] as string).startsWith("media:"));
  if (holdsMedia) return holdsMedia;
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

/** What the media panel says after the frame answered `insert-media`. */
export function insertMediaMessage(result: WebsiteFrameInsertMediaResult): string {
  if (result.ok) return "Put in the selected block. Save the page in the editor to keep it.";
  const kept = "It is in Website media, so you can pick it in a block's image field.";
  switch (result.code) {
    case "block_not_found":
      return `The selected block is no longer on this page, so nothing changed. ${kept}`;
    case "field_not_found":
    case "field_not_media":
      return `The selected block has no image or video field for this. ${kept}`;
    case "invalid_payload":
      return `The site's editor could not use this item. ${kept}`;
    default:
      return `The site's editor did not put it in${result.message ? `: ${result.message}` : "."} ${kept}`;
  }
}
