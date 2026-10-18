import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHARED_TITLE_MAX, sharedTaskDefaults } from "./share-target";

describe("sharedTaskDefaults", () => {
  it("gives nothing for the plain new task shortcut", () => {
    expect(sharedTaskDefaults("")).toEqual({});
    expect(sharedTaskDefaults("?title=%20&text=")).toEqual({});
  });

  it("uses a shared page's title and keeps its link", () => {
    expect(sharedTaskDefaults("?title=Acme%20pricing&url=https%3A%2F%2Facme.test%2Fpricing")).toEqual({
      title: "Acme pricing",
      description: "https://acme.test/pricing",
    });
  });

  it("does not repeat a link the phone already put in the text", () => {
    const search = new URLSearchParams({ title: "Read this", text: "Worth a look https://a.test/x", url: "https://a.test/x" });
    expect(sharedTaskDefaults(`?${search}`)).toEqual({ title: "Read this", description: "Worth a look https://a.test/x" });
  });

  it("takes the first line of shared text as the title when there is no title", () => {
    const search = new URLSearchParams({ text: "\nCall Ben about the renewal\nHe asked for Friday" });
    expect(sharedTaskDefaults(`?${search}`)).toEqual({
      title: "Call Ben about the renewal",
      description: "Call Ben about the renewal\nHe asked for Friday",
    });
  });

  it("uses a bare link as the title", () => {
    expect(sharedTaskDefaults("?url=https%3A%2F%2Fa.test")).toEqual({ title: "https://a.test" });
  });

  it("shortens a long title and keeps it whole in the description", () => {
    const long = "word ".repeat(60).trim();
    const result = sharedTaskDefaults(`?text=${encodeURIComponent(long)}`);
    expect(result.title!.length).toBeLessThanOrEqual(SHARED_TITLE_MAX);
    expect(result.title!.endsWith("...")).toBe(true);
    expect(result.description).toBe(long);
  });
});

describe("share target", () => {
  it("lets Android share pages and text to GSAM as a new task", () => {
    const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const manifest = JSON.parse(readFileSync(resolve(uiRoot, "public/site.webmanifest"), "utf8")) as {
      share_target?: { action: string; method: string; params: Record<string, string> };
    };
    expect(manifest.share_target).toEqual({
      action: "/issues/new",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    });
  });
});
