import { describe, expect, it, vi } from "vitest";
import type { WebsitePageEditorLoad, WebsiteRevision } from "@greatstone/shared";
import { ApiError } from "../api/client";
import {
  editorOpenProblem,
  frameConnectionMessage,
  frameDraft,
  insertMediaAssetUrl,
  insertMediaField,
  insertMediaMessage,
  saveThroughGsam,
} from "./website-editor";

const request = { pageId: "page-1", baseRevisionId: "rev-1", data: { root: {} }, editorOrigin: "https://editor.example.com" };
const revision = (id: string, extra: Partial<WebsiteRevision> = {}): WebsiteRevision => ({
  id,
  revisionNumber: 2,
  changeSummary: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-23T09:00:00.000Z",
  ...extra,
});

describe("saveThroughGsam", () => {
  it("sends the base revision, the content and the session's editor origin, and answers saved", async () => {
    const save = vi.fn(async () => ({ state: "saved" as const, revisionId: "rev-2", revisionNumber: 2 }));
    const answer = await saveThroughGsam(request, { save, latest: vi.fn(), now: () => new Date("2026-10-23T10:00:00Z") });
    expect(save).toHaveBeenCalledWith({ baseRevisionId: "rev-1", content: { root: {} }, editorOrigin: "https://editor.example.com" });
    expect(answer).toEqual({ outcome: "saved", revisionId: "rev-2", savedAt: "2026-10-23T10:00:00.000Z" });
  });

  it("a conflict carries the latest content and revision so Take theirs can apply it", async () => {
    const answer = await saveThroughGsam(request, {
      save: async () => ({ state: "conflict", latestRevisionId: "rev-9", latestRevisionNumber: 9, message: "newer" }),
      latest: async () => ({ content: { theirs: true }, revisions: [revision("rev-9", { createdByAgentId: "agent-1" })] }),
    });
    expect(answer).toEqual({
      outcome: "conflict",
      currentRevisionId: "rev-9",
      currentData: { theirs: true },
      currentMedia: {},
      savedBy: "an agent",
      savedAt: "2026-10-23T09:00:00.000Z",
    });
  });

  it("origin-changed and invalid are never retryable; a plain failure is", async () => {
    const failed = (code?: "origin-changed" | "invalid") =>
      saveThroughGsam(request, { save: async () => ({ state: "failed", message: "no", ...(code ? { code } : {}) }), latest: vi.fn() });
    expect(await failed("origin-changed")).toMatchObject({ outcome: "failed", code: "origin-changed", retryable: false });
    expect(await failed("invalid")).toMatchObject({ retryable: false });
    expect(await failed()).toMatchObject({ code: "error", retryable: true });
  });

  it("a 403 says the person can view but not edit; a network error is left to the session (retryable)", async () => {
    const forbidden = await saveThroughGsam(request, { save: async () => { throw new ApiError("no", 403, null); }, latest: vi.fn() });
    expect(forbidden).toMatchObject({ outcome: "failed", code: "forbidden", retryable: false });
    await expect(saveThroughGsam(request, { save: async () => { throw new TypeError("offline"); }, latest: vi.fn() })).rejects.toThrow("offline");
  });
});

describe("frameDraft", () => {
  const load: WebsitePageEditorLoad = {
    page: {} as WebsitePageEditorLoad["page"],
    revisionId: "rev-3",
    data: { draft: true },
    theme: { brand: "#123" },
    site: { name: "Site", settings: { domain: "example.com" }, navigation: [] },
    editorFrameOrigin: "https://editor.example.com",
    media: [
      { entryId: "e1", entryKey: "hero", assetId: "asset-1", alt: "Team", caption: null, contentType: "image/png", byteSize: 3, width: 10, height: 5, contentPath: "/api/assets/asset-1/content" },
    ],
  };

  it("hands every image to the frame as a Blob keyed by asset id", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const fetchBlob = vi.fn(async () => blob);
    const draft = await frameDraft(load, fetchBlob);
    expect(fetchBlob).toHaveBeenCalledWith("/api/assets/asset-1/content");
    expect(draft).toEqual({
      revisionId: "rev-3",
      data: { draft: true },
      theme: { brand: "#123" },
      media: { "asset-1": { blob, alt: "Team", width: 10, height: 5 } },
      site: load.site,
    });
  });

  it("live preview swaps in the published revision", async () => {
    const draft = await frameDraft(load, async () => new Blob(), { revisionId: "rev-1", data: { live: true } });
    expect(draft).toMatchObject({ revisionId: "rev-1", data: { live: true } });
  });
});

describe("editorOpenProblem (rule C1.1 on open)", () => {
  it("refuses a missing origin, the public site and GSAM's own origin", () => {
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: null }, "https://gsam.test", false)).toBe("missing");
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: "https://example.com" }, "https://gsam.test", false)).toBe("public-origin");
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: "https://gsam.test" }, "https://gsam.test", false)).toBe("gsam-origin");
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: "http://localhost:4100" }, "http://localhost:3100", false)).toBe("invalid");
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: "http://localhost:4100" }, "http://localhost:3100", true)).toBeNull();
    expect(editorOpenProblem({ domain: "example.com", editorFrameOrigin: "https://editor.example.com" }, "https://gsam.test", false)).toBeNull();
  });
});

describe("frameConnectionMessage", () => {
  it("names the editor address when it does not answer, and the protocol on a refusal", () => {
    expect(frameConnectionMessage({ phase: "no-answer" }, "https://editor.example.com")).toContain("https://editor.example.com");
    expect(frameConnectionMessage({ phase: "refused-protocol", supported: [2] }, "x")).toContain("protocol 2");
    expect(frameConnectionMessage({ phase: "refused-site" }, "x")).toBe("This address serves a different site.");
    expect(frameConnectionMessage({ phase: "connecting" }, "x")).toBeNull();
  });
});

describe("insert-media helpers (GRE-2206)", () => {
  const data = {
    root: { props: {} },
    content: [
      { type: "Hero", props: { id: "h1", heading: "Hi", backdrop: "media:asset-1" } },
      { type: "Grid", props: { id: "g1", items: [{ type: "Card", props: { id: "c1", title: "x", photo: "" } }] } },
      { type: "Text", props: { id: "t1", body: "words" } },
      { type: "BeforeAfter", props: { id: "b1", caption: "Kitchen.jpg looks great", beforeImage: "/images/before.jpg", afterClip: "https://cdn.example.com/after.mp4?v=2" } },
      { type: "Mixed", props: { id: "m1", poster: "/images/old.png", image: "media:asset-2" } },
    ],
  };

  it("picks the field that already holds a media reference, then a usual media name, then the kind's default", () => {
    expect(insertMediaField(data, "h1", "image")).toBe("backdrop");
    expect(insertMediaField(data, "c1", "image")).toBe("photo");
    expect(insertMediaField(data, "t1", "image")).toBe("image");
    expect(insertMediaField(data, "t1", "animation")).toBe("video");
    expect(insertMediaField(null, "missing", "image")).toBe("image");
  });

  it("picks a field that holds a site path or URL of the kind's file type, after a media reference (GRE-2295)", () => {
    expect(insertMediaField(data, "b1", "image")).toBe("beforeImage");
    expect(insertMediaField(data, "b1", "animation")).toBe("afterClip");
    expect(insertMediaField(data, "m1", "image")).toBe("image");
  });

  it("sends an absolute https asset URL, or the path when GSAM is not on https", () => {
    expect(insertMediaAssetUrl("/api/assets/a/content", "https://gsam.example.com")).toBe("https://gsam.example.com/api/assets/a/content");
    expect(insertMediaAssetUrl("/api/assets/a/content", "http://localhost:3100")).toBe("/api/assets/a/content");
  });

  it("names the block, says why in plain words, and that the entry is kept", () => {
    expect(insertMediaMessage({ requestId: "r", ok: true }, "Hero", "image")).toBe(
      "Put in Hero. Save the page to keep it.",
    );
    for (const code of ["block_not_found", "field_not_found", "field_not_media", "invalid_payload", "error"] as const) {
      const text = insertMediaMessage({ requestId: "r", ok: false, code }, "Hero", "image");
      expect(text).toContain("The image is saved in Website media.");
      expect(text).not.toContain(code);
    }
    expect(insertMediaMessage({ requestId: "r", ok: false, code: "field_not_media" }, "Hero", "image")).toBe(
      "Hero has no image or video field, so nothing changed. The image is saved in Website media. Pick it from an image field in the editor.",
    );
    expect(insertMediaMessage({ requestId: "r", ok: false, code: "block_not_found" }, "Hero", "animation")).toBe(
      "Hero is no longer on this page, so nothing changed. The animation is saved in Website media.",
    );
  });

  it("keeps the site's own message out of the panel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(insertMediaMessage({ requestId: "r", ok: false, code: "error", message: "Draft locked" }, "Hero", "image")).not.toContain("Draft locked");
    expect(warn).toHaveBeenCalledWith("insert-media refused:", "Draft locked");
    warn.mockRestore();
  });
});
