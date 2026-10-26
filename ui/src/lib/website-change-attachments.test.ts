import { describe, expect, it } from "vitest";
import { createWebsiteChangeRequestSchema } from "@greatstone/shared";
import { imageFileProblem, normaliseLink, pastedImageFiles, requestAttachments, uniqueImageFile, type DraftAttachment } from "./website-change-attachments";

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

describe("Ask an agent attachments (GRE-2527)", () => {
  it("takes PNG, JPEG, WebP and GIF up to 8 MB; refuses SVG, other files, empty and big ones", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(imageFileProblem(file("a", type))).toBeNull();
    expect(imageFileProblem(file("logo.svg", "image/svg+xml"))).toBe("logo.svg is not a PNG, JPEG, WebP or GIF image.");
    expect(imageFileProblem(file("brief.pdf", "application/pdf"))).toMatch(/not a PNG/);
    expect(imageFileProblem(file("e.png", "image/png", 0))).toBe("e.png is empty.");
    expect(imageFileProblem(file("big.png", "image/png", 8 * 1024 * 1024 + 1))).toBe("big.png is larger than 8 MB.");
  });

  it("gives each upload its own name; a pasted image is pasted-1, pasted-2", () => {
    expect(uniqueImageFile(file("mood.png", "image/png"), []).name).toBe("mood.png");
    expect(uniqueImageFile(file("mood.png", "image/png"), ["mood.png"]).name).toBe("mood-2.png");
    expect(uniqueImageFile(file("Photo (1).JPG", "image/jpeg"), []).name).toBe("Photo -1.jpg");
    expect(uniqueImageFile(file("image.png", "image/png"), [], true).name).toBe("pasted-1.png");
    expect(uniqueImageFile(file("image.png", "image/png"), ["pasted-1.png"], true).name).toBe("pasted-2.png");
  });

  it("reads a typed address as http(s) only", () => {
    expect(normaliseLink("example.com/page")).toBe("https://example.com/page");
    expect(normaliseLink(" http://example.com ")).toBe("http://example.com/");
    expect(normaliseLink("javascript:alert(1)")).toBeNull();
    expect(normaliseLink("ftp://example.com")).toBeNull();
    expect(normaliseLink("not a link")).toBeNull();
    expect(normaliseLink("word")).toBeNull();
  });

  it("lists the drafts in order with one-line notes, and the request passes the shared check", () => {
    const drafts: DraftAttachment[] = [
      { key: "1", kind: "upload", file: file("mood.png", "image/png"), previewUrl: "", note: " This colour\nplease " },
      { key: "2", kind: "media", source: "studio", assetId: "6f1c1b8e-1a7b-4c1e-9b1a-2d3e4f5a6b7c", label: "Sunset", contentPath: "/x", note: "" },
      { key: "3", kind: "link", url: "https://example.com/", note: "Spacing" },
      { key: "4", kind: "effect", effectId: "aurora", label: "Aurora", note: "x".repeat(200) },
    ];
    const attachments = requestAttachments(drafts);
    expect(attachments).toEqual([
      { kind: "upload", name: "mood.png", note: "This colour please" },
      { kind: "media", source: "studio", assetId: "6f1c1b8e-1a7b-4c1e-9b1a-2d3e4f5a6b7c", label: "Sunset" },
      { kind: "link", url: "https://example.com/", note: "Spacing" },
      { kind: "effect", effectId: "aurora", label: "Aurora", note: "x".repeat(140) },
    ]);
    const parsed = createWebsiteChangeRequestSchema.safeParse({
      requestId: "0b8c3c2e-5f4a-4d1e-8b9a-1c2d3e4f5a6b",
      pageRevisionId: "1b8c3c2e-5f4a-4d1e-8b9a-1c2d3e4f5a6b",
      request: "",
      attachments,
    });
    expect(parsed.success).toBe(true);
  });

  it("takes image files from a paste and ignores text", () => {
    const image = file("image.png", "image/png");
    expect(pastedImageFiles({ files: [image], items: [] } as unknown as DataTransfer)).toEqual([image]);
    const fromItems = pastedImageFiles({
      files: [],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => image },
      ],
    } as unknown as DataTransfer);
    expect(fromItems).toEqual([image]);
    expect(pastedImageFiles(null)).toEqual([]);
  });
});
