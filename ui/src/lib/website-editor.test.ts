import { describe, expect, it, vi } from "vitest";
import type { WebsitePageEditorLoad, WebsiteRevision } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { editorOpenProblem, frameConnectionMessage, frameDraft, saveThroughGsam } from "./website-editor";

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
