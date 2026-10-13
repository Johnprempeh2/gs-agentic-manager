import { describe, expect, it } from "vitest";
import { createDeliverableSchema, deliverablesQuerySchema, updateDeliverableSchema } from "./deliverable.js";

// Link deliverables: a deliverable is either a stored file or a live https site.

const attachmentId = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

describe("createDeliverableSchema", () => {
  it("takes a file or a link", () => {
    expect(createDeliverableSchema.safeParse({ attachmentId, title: "Q3 pack" }).success).toBe(true);
    const link = createDeliverableSchema.parse({
      url: "https://greatstone-moengt-deck.netlify.app",
      title: "MoEnGT deck",
      kind: "deck",
      summary: "Ministry of Energy deck",
      confidentiality: "client",
      status: "final",
    });
    expect(link).toMatchObject({ url: "https://greatstone-moengt-deck.netlify.app", confidentiality: "client" });
  });

  it("needs exactly one of attachmentId or url", () => {
    expect(createDeliverableSchema.safeParse({ title: "Nothing" }).success).toBe(false);
    expect(createDeliverableSchema.safeParse({ attachmentId, url: "https://example.com", title: "Both" }).success).toBe(false);
  });

  it("only takes https links", () => {
    for (const url of ["http://example.com", "ftp://example.com", "javascript:alert(1)", "not a url"]) {
      expect(createDeliverableSchema.safeParse({ url, title: "Bad" }).success).toBe(false);
    }
  });

  it("only takes known confidentiality labels", () => {
    expect(createDeliverableSchema.safeParse({ attachmentId, title: "x", confidentiality: "secret" }).success).toBe(false);
  });
});

describe("updateDeliverableSchema", () => {
  it("needs something to change", () => {
    expect(updateDeliverableSchema.safeParse({}).success).toBe(false);
    expect(updateDeliverableSchema.safeParse({ confidentiality: "public" }).success).toBe(true);
    expect(updateDeliverableSchema.safeParse({ restricted: true }).success).toBe(true);
  });
});

describe("deliverablesQuerySchema", () => {
  it("filters by confidentiality and broken links", () => {
    expect(deliverablesQuerySchema.parse({ confidentiality: "client", linkHealth: "broken" }))
      .toMatchObject({ confidentiality: "client", linkHealth: "broken" });
    expect(deliverablesQuerySchema.safeParse({ linkHealth: "ok" }).success).toBe(false);
  });
});
