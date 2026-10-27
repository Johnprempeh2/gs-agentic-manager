import {
  WEBSITE_CHANGE_IMAGE_MAX_BYTES,
  WEBSITE_CHANGE_IMAGE_TYPES,
  WEBSITE_CHANGE_MAX_ATTACHMENTS,
  WEBSITE_CHANGE_NOTE_MAX,
  type WebsiteChangeAttachment,
} from "@greatstone/shared";

// Ask an agent, slice 2 (GRE-2527): what the person adds to show what they
// mean. Uploads and pasted images are files the panel attaches to the task
// after it is made; media, links and effects travel in the request itself.

export type DraftAttachment =
  | { key: string; kind: "upload"; file: File; previewUrl: string; note: string }
  | { key: string; kind: "media"; source: "website" | "studio"; assetId: string; label: string; contentPath: string; note: string }
  | { key: string; kind: "link"; url: string; note: string }
  | { key: string; kind: "effect"; effectId: string; label: string; note: string };

/** What the panel adds besides files: the key and the note come with it. */
export type NewDraftAttachment =
  | { kind: "media"; source: "website" | "studio"; assetId: string; label: string; contentPath: string }
  | { kind: "link"; url: string }
  | { kind: "effect"; effectId: string; label: string };

export const MAX_ATTACHMENTS = WEBSITE_CHANGE_MAX_ATTACHMENTS;
export const NOTE_MAX = WEBSITE_CHANGE_NOTE_MAX;
/** For the file input's `accept`: the phone's photo picker offers only these. */
export const IMAGE_ACCEPT = WEBSITE_CHANGE_IMAGE_TYPES.join(",");

const MB = 1024 * 1024;

/** Why this file cannot be attached, or null when it can. The server checks the bytes again. */
export function imageFileProblem(file: File): string | null {
  if (!(WEBSITE_CHANGE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || "That file"} is not a PNG, JPEG, WebP or GIF image.`;
  }
  if (file.size > WEBSITE_CHANGE_IMAGE_MAX_BYTES) {
    return `${file.name || "That image"} is larger than ${WEBSITE_CHANGE_IMAGE_MAX_BYTES / MB} MB.`;
  }
  if (file.size === 0) return `${file.name || "That image"} is empty.`;
  return null;
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * The file under a name no other upload on this request has, so each line of
 * the task names one file. A pasted image (often `image.png`) becomes `pasted-1.png`.
 */
export function uniqueImageFile(file: File, taken: readonly string[], pasted = false): File {
  const extension = EXTENSIONS[file.type] ?? "png";
  const base = pasted
    ? "pasted"
    : (file.name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9 _.-]+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "").slice(0, 80) || "image");
  let name = pasted ? `${base}-1.${extension}` : `${base}.${extension}`;
  for (let n = 2; taken.includes(name); n += 1) name = `${base}-${n}.${extension}`;
  return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/** The address the person typed as an http(s) URL, or null. A bare `example.com` gets `https://`. */
export function normaliseLink(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

/** The note as the request takes it: one line, at most the limit, or nothing. */
function noteOf(note: string) {
  const line = note.replace(/[\r\n]+/g, " ").trim().slice(0, NOTE_MAX);
  return line ? { note: line } : {};
}

/** The drafts as the request lists them, in the order added. */
export function requestAttachments(drafts: readonly DraftAttachment[]): WebsiteChangeAttachment[] {
  return drafts.map((draft) => {
    switch (draft.kind) {
      case "upload":
        return { kind: "upload", name: draft.file.name, ...noteOf(draft.note) };
      case "media":
        return { kind: "media", source: draft.source, assetId: draft.assetId, label: draft.label.slice(0, 200), ...noteOf(draft.note) };
      case "link":
        return { kind: "link", url: draft.url, ...noteOf(draft.note) };
      case "effect":
        return { kind: "effect", effectId: draft.effectId, label: draft.label.slice(0, 120), ...noteOf(draft.note) };
    }
  });
}

/** Image files from a paste: screenshots and copied images. Text pastes give none. */
export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...(data.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) return files;
  return [...(data.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
