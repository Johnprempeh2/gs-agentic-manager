import {
  checkWebsiteEditorOrigin,
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
