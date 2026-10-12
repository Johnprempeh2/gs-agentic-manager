/**
 * Attachment preview panel helpers (GRE-1036). A plain click on an
 * `/api/attachments/<id>/content` link in the issue view opens the file in a
 * side panel instead of leaving the page; these decide which links and which
 * clicks qualify.
 */

export type AttachmentPreviewKind = "html" | "image" | "pdf";

export interface AttachmentPreviewTarget {
  href: string;
  name?: string | null;
  contentType?: string | null;
}

/** What the panel shows; kept in router state so browser Back closes it. */
export interface AttachmentPreviewState {
  attachmentId: string;
  name: string;
  kind: AttachmentPreviewKind;
  /** The page the panel was opened on, so the state never follows a link. */
  pathname: string;
}

export const ATTACHMENT_PREVIEW_STATE_KEY = "attachmentPreview";

const ATTACHMENT_CONTENT_PATH_RE = /^\/api\/attachments\/([^/?#]+)\/content\/?$/;

/**
 * The attachment id of a same-origin attachment content link, or null. Links
 * that ask for a download (`?download=1`) are left alone.
 */
export function parseAttachmentContentHref(
  href: string | null | undefined,
  origin: string = window.location.origin,
): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.searchParams.has("download")) return null;
  const match = url.pathname.match(ATTACHMENT_CONTENT_PATH_RE);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function attachmentContentPath(attachmentId: string) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

/**
 * How the panel can show a file, or null when it cannot (zip, docx, …) and the
 * link should keep its normal behaviour. The stored content type wins; the
 * file name extension is the fallback for unknown or generic types.
 */
export function attachmentPreviewKind(input: {
  contentType?: string | null;
  name?: string | null;
}): AttachmentPreviewKind | null {
  const type = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type && type !== "application/octet-stream") return null;

  const extension = (input.name ?? "").trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension) return null;
  if (extension === "html" || extension === "htm" || extension === "xhtml") return "html";
  if (extension === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return null;
}

/**
 * True for a plain left click. Cmd/Ctrl/Shift/Alt-clicks and middle clicks keep
 * the browser's own behaviour (new tab, new window, download).
 */
export function isPlainPrimaryClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

export function readAttachmentPreviewState(
  locationState: unknown,
  pathname: string,
): AttachmentPreviewState | null {
  if (typeof locationState !== "object" || locationState === null) return null;
  const value = (locationState as Record<string, unknown>)[ATTACHMENT_PREVIEW_STATE_KEY];
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AttachmentPreviewState>;
  if (
    typeof candidate.attachmentId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.pathname !== "string" ||
    candidate.pathname !== pathname ||
    (candidate.kind !== "html" && candidate.kind !== "image" && candidate.kind !== "pdf")
  ) {
    return null;
  }
  return candidate as AttachmentPreviewState;
}

export function withoutAttachmentPreviewState(locationState: unknown): unknown {
  if (typeof locationState !== "object" || locationState === null) return locationState;
  if (!(ATTACHMENT_PREVIEW_STATE_KEY in locationState)) return locationState;
  const { [ATTACHMENT_PREVIEW_STATE_KEY]: _removed, ...rest } = locationState as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : null;
}
