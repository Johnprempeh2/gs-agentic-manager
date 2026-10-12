import { describe, expect, it } from "vitest";
import {
  attachmentPreviewKind,
  isPlainPrimaryClick,
  parseAttachmentContentHref,
  readAttachmentPreviewState,
  withoutAttachmentPreviewState,
} from "./attachment-preview";

const ORIGIN = "http://localhost:3100";

function click(overrides: Partial<Parameters<typeof isPlainPrimaryClick>[0]> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("parseAttachmentContentHref", () => {
  it("reads the id from relative and same-origin absolute content links", () => {
    expect(parseAttachmentContentHref("/api/attachments/att-1/content", ORIGIN)).toBe("att-1");
    expect(parseAttachmentContentHref(`${ORIGIN}/api/attachments/att-2/content`, ORIGIN)).toBe("att-2");
    expect(parseAttachmentContentHref("/api/attachments/att-3/content#top", ORIGIN)).toBe("att-3");
  });

  it("ignores other origins, other paths and download links", () => {
    expect(parseAttachmentContentHref("https://evil.example/api/attachments/att-1/content", ORIGIN)).toBeNull();
    expect(parseAttachmentContentHref("/api/assets/asset-1/content", ORIGIN)).toBeNull();
    expect(parseAttachmentContentHref("/api/attachments/att-1", ORIGIN)).toBeNull();
    expect(parseAttachmentContentHref("/api/attachments/att-1/content?download=1", ORIGIN)).toBeNull();
    expect(parseAttachmentContentHref(undefined, ORIGIN)).toBeNull();
  });
});

describe("attachmentPreviewKind", () => {
  it("previews HTML, PDF and images by content type", () => {
    expect(attachmentPreviewKind({ contentType: "text/html; charset=utf-8" })).toBe("html");
    expect(attachmentPreviewKind({ contentType: "application/pdf" })).toBe("pdf");
    expect(attachmentPreviewKind({ contentType: "image/png" })).toBe("image");
  });

  it("falls back to the file name only when the type is missing or generic", () => {
    expect(attachmentPreviewKind({ name: "mock-up.html" })).toBe("html");
    expect(attachmentPreviewKind({ contentType: "application/octet-stream", name: "brief.PDF" })).toBe("pdf");
    expect(attachmentPreviewKind({ name: "shot.webp" })).toBe("image");
    expect(attachmentPreviewKind({ contentType: "application/zip", name: "fake.html" })).toBeNull();
    expect(attachmentPreviewKind({ name: "report.docx" })).toBeNull();
    expect(attachmentPreviewKind({})).toBeNull();
  });
});

describe("isPlainPrimaryClick", () => {
  it("accepts only an unmodified left click", () => {
    expect(isPlainPrimaryClick(click())).toBe(true);
    expect(isPlainPrimaryClick(click({ metaKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ ctrlKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ shiftKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ altKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ button: 1 }))).toBe(false);
    expect(isPlainPrimaryClick(click({ defaultPrevented: true }))).toBe(false);
  });
});

describe("router state", () => {
  const preview = { attachmentId: "att-1", name: "a.html", kind: "html", pathname: "/GRE/issues/GRE-1" };

  it("only opens the panel on the page it was opened from", () => {
    const state = { attachmentPreview: preview, issueDetailSource: "inbox" };
    expect(readAttachmentPreviewState(state, "/GRE/issues/GRE-1")).toEqual(preview);
    expect(readAttachmentPreviewState(state, "/GRE/issues/GRE-2")).toBeNull();
    expect(readAttachmentPreviewState({ attachmentPreview: { ...preview, kind: "zip" } }, "/GRE/issues/GRE-1")).toBeNull();
  });

  it("keeps other page state when the preview is removed", () => {
    expect(withoutAttachmentPreviewState({ attachmentPreview: preview, issueDetailSource: "inbox" })).toEqual({
      issueDetailSource: "inbox",
    });
    expect(withoutAttachmentPreviewState({ attachmentPreview: preview })).toBeNull();
    expect(withoutAttachmentPreviewState(null)).toBeNull();
  });
});
