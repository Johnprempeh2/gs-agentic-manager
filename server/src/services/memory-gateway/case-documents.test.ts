import { describe, expect, it } from "vitest";
import type { MemoryScope } from "@greatstone/shared";
import { caseDocumentEntry, isReadableText, pickCaseDocumentScope } from "./case-documents.js";

const scope = (id: string, kind: string, name: string) => ({ id, kind, name }) as MemoryScope;

describe("client documents in memory", () => {
  it("keeps text only from readable files", () => {
    expect(isReadableText("text/plain; charset=utf-8")).toBe(true);
    expect(isReadableText("text/markdown")).toBe(true);
    expect(isReadableText("application/pdf")).toBe(false);
    expect(isReadableText(null)).toBe(false);
  });

  it("prefers the client's own memory, then organisation memory", () => {
    const scopes = [scope("org", "organization", "Greatstone"), scope("acme", "client", "Acme  Ltd")];
    expect(pickCaseDocumentScope(scopes, "acme ltd")?.id).toBe("acme");
    expect(pickCaseDocumentScope(scopes, "Heron")?.id).toBe("org");
    expect(pickCaseDocumentScope([], "Heron")).toBeNull();
  });

  it("names the client, the file and the day, and trims long text", () => {
    const entry = caseDocumentEntry({
      clientName: "Acme",
      title: "Signed NDA (nda.pdf)",
      originalFilename: "nda.pdf",
      note: null,
      receivedAt: new Date("2026-10-16T05:00:00Z"),
      text: "x".repeat(5_000),
    });
    expect(entry.title).toBe("Acme: Signed NDA (nda.pdf)");
    expect(entry.content.startsWith("Acme: Signed NDA (nda.pdf) (nda.pdf) was added to the client on 2026-10-16.")).toBe(true);
    expect(entry.content.endsWith("x...")).toBe(true);
  });
});
