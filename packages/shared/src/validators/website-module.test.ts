import { describe, expect, it } from "vitest";
import { createWebsiteSiteSchema, updateWebsitePageSchema } from "./website-module.js";

const base = { name: "Site", domain: "www.example.com", netlifySiteId: "n-1" };

describe("website site repository field", () => {
  it("accepts owner/site-name as the copy says", () => {
    expect(createWebsiteSiteSchema.parse({ ...base, repoUrl: "acme/site-name" }).repoUrl).toBe("acme/site-name");
  });

  it("stores a GitHub address as owner/site-name", () => {
    for (const url of ["https://github.com/acme/site-name", "https://github.com/acme/site-name.git", "http://www.github.com/acme/site-name/"]) {
      expect(createWebsiteSiteSchema.parse({ ...base, repoUrl: url }).repoUrl, url).toBe("acme/site-name");
    }
  });

  it("keeps another http(s) address as it is", () => {
    expect(createWebsiteSiteSchema.parse({ ...base, repoUrl: "https://gitlab.com/acme/site" }).repoUrl).toBe("https://gitlab.com/acme/site");
  });

  it("refuses anything else", () => {
    for (const value of ["site-name", "acme/site/extra", "ftp://example.com/x", "acme site/x"]) {
      expect(createWebsiteSiteSchema.safeParse({ ...base, repoUrl: value }).success, value).toBe(false);
    }
  });
});

describe("website page update", () => {
  it("restores with archived false and never archives through PATCH", () => {
    expect(updateWebsitePageSchema.safeParse({ archived: false }).success).toBe(true);
    expect(updateWebsitePageSchema.safeParse({ archived: true }).success).toBe(false);
  });
});
