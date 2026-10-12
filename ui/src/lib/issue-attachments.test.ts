import { describe, expect, it } from "vitest";
import { attachmentThumbnailSrc } from "./issue-attachments";

describe("attachmentThumbnailSrc", () => {
  it("asks for a small copy of an attachment and leaves other URLs alone", () => {
    expect(attachmentThumbnailSrc("/api/attachments/abc-123/content", 320)).toBe("/api/attachments/abc-123/content?w=320");
    expect(attachmentThumbnailSrc("/api/attachments/abc-123/content?download=1", 320)).toBe("/api/attachments/abc-123/content?download=1");
    expect(attachmentThumbnailSrc("https://example.com/shot.png", 640)).toBe("https://example.com/shot.png");
    expect(attachmentThumbnailSrc("blob:http://localhost/1", 640)).toBe("blob:http://localhost/1");
  });
});
