import { describe, expect, it } from "vitest";
import { checkHomeFrozen, HOME_LANDING_ISLAND, landingCopyOf, landingTag, websitePageSource, withLandingCopy, pageDocument, pagePart, siteAssetOrigin, splitPageDocument, websitePageFrame } from "../services/website/live-page.js";
import { parseWebsiteMediaFileName, signWebsiteMediaLink, verifyWebsiteMediaLink } from "../services/website/media-file.js";
import { LiveDesignConflict } from "../services/live-design.js";

const page = { title: "Home", slug: "/", companyId: "c1", siteId: "s1" };
const chrome = {
  chrome: { header: { html: "<header>Top</header>", css: ".h{}" }, nav: { html: "", css: "" }, footer: { html: "<footer>Bottom</footer>", css: "" } },
  stylesheet: ".gs-hero{color:lime}",
};

describe("website page documents (release schema 2)", () => {
  it("round-trips the page part through the agent's document and keeps the shared parts out", () => {
    const part = { html: '<section class="gs-hero"><h1>Hi</h1><main-ish>x</main-ish></section>', css: ".p{margin:0}" };
    const doc = pageDocument(page, part, chrome, null);
    expect(doc).toContain('data-gs-shared="header"');
    expect(doc).toContain("/api/companies/c1/website/sites/s1/stylesheet");
    expect(doc).not.toContain(".gs-hero{color:lime}");
    const edited = doc.replace("<h1>Hi</h1>", "<h1>Hello</h1>").replace(".p{margin:0}", ".p{margin:1px}");
    expect(splitPageDocument(edited)).toEqual({ html: part.html.replace("Hi", "Hello"), css: ".p{margin:1px}" });
  });

  it("inlines the real stylesheet only in the frame copy", () => {
    expect(pageDocument(page, { html: "<p>x</p>", css: "" }, chrome, chrome.stylesheet)).toContain(".gs-hero{color:lime}");
  });

  it("refuses a document without the page marker instead of saving the wrong part", () => {
    expect(() => splitPageDocument("<html><body><p>no main</p></body></html>")).toThrow(LiveDesignConflict);
    expect(() => splitPageDocument('<main id="gs-page">  </main>')).toThrow(LiveDesignConflict);
  });

  it("keeps a closing style tag in CSS from ending the element", () => {
    expect(pageDocument(page, { html: "<p>x</p>", css: "a{}</style><script>1</script>" }, null, null)).not.toContain("</style><script>");
  });

  it("treats block pages as a starter carrying their blocks", () => {
    const part = pagePart(page, { root: {}, content: [{ type: "Hero", props: {} }] });
    expect(part.html).toContain("gs-page-blocks");
    expect(pagePart(page, { format: "gs-html", html: "<p>x</p>" })).toEqual({ html: "<p>x</p>", css: "" });
  });

  it("serves site assets only from an https preview origin", () => {
    expect(siteAssetOrigin("https://gsam-editor--greatstone-home.netlify.app/")).toBe("https://gsam-editor--greatstone-home.netlify.app");
    expect(siteAssetOrigin("http://example.com")).toBeNull();
    expect(siteAssetOrigin(null)).toBeNull();
  });

  it("frames /media/ from GSAM's site media route and other assets from the preview origin (GRE-4265)", async () => {
    const html = '<img src="/media/abc.png" srcset="/media/a.png 1x, /media/b.png 2x"><img src="/assets/logo.svg"><div style="x"></div>';
    const store = {
      readRevision: async () => ({ revisionNumber: 1, content: { format: "gs-html", html, css: ".h{background:url(/media/bg.jpg)}" } }),
      readDocument: async () => null,
      saveRevision: async () => ({ state: "failed" as const, message: "" }),
    };
    const framePage = { ...page, id: "p1", documentId: "d1" };
    const media = "/api/companies/c1/website/sites/s1/media/";
    const withOrigin = await websitePageFrame(store, framePage, async () => null, "r1", "https://preview.example");
    expect(withOrigin).toContain(`src="${media}abc.png"`);
    expect(withOrigin).toContain(`srcset="${media}a.png 1x, ${media}b.png 2x"`);
    expect(withOrigin).toContain(`url(${media}bg.jpg)`);
    expect(withOrigin).toContain('src="https://preview.example/assets/logo.svg"');
    expect(withOrigin).not.toContain("https://preview.example/media/");
    const noOrigin = await websitePageFrame(store, framePage, async () => null, "r1", null);
    expect(noOrigin).toContain(`src="${media}abc.png"`);
    expect(noOrigin).toContain('src="/assets/logo.svg"');
    const signed = await websitePageFrame(store, framePage, async () => null, "r1", null, (file) => `sig-for-${file}`);
    const hashed = "c".repeat(64);
    expect(signed).toContain(`src="${media}abc.png"`); // not a <sha256> name: no signature, the route answers 404
    const hashedStore = { ...store, readRevision: async () => ({ revisionNumber: 1, content: { format: "gs-html", html: `<img src="/media/${hashed}.png">`, css: "" } }) };
    expect(await websitePageFrame(hashedStore, framePage, async () => null, "r1", null, (file) => `sig-for-${file}`)).toContain(`src="${media}${hashed}.png?sig=sig-for-${hashed}.png"`);
  });

  it("a media link signature holds only for its own company, site and file, until it expires", () => {
    const input = { companyId: "c1", siteId: "s1", file: `${"a".repeat(64)}.png` };
    const now = Date.UTC(2026, 10, 6);
    const sig = signWebsiteMediaLink("k", input, now);
    expect(verifyWebsiteMediaLink("k", input, sig, now)).toBe(true);
    expect(verifyWebsiteMediaLink("k", input, sig, now + 59 * 60 * 1000)).toBe(true);
    expect(verifyWebsiteMediaLink("k", input, sig, now + 60 * 60 * 1000)).toBe(false);
    expect(verifyWebsiteMediaLink("other", input, sig, now)).toBe(false);
    for (const changed of [{ companyId: "c2" }, { siteId: "s2" }, { file: `${"b".repeat(64)}.png` }]) {
      expect(verifyWebsiteMediaLink("k", { ...input, ...changed }, sig, now)).toBe(false);
    }
    expect(verifyWebsiteMediaLink("k", input, "", now)).toBe(false);
    expect(verifyWebsiteMediaLink("k", input, `${sig}x`, now)).toBe(false);
  });

  it("reads only <sha256>.<ext> as a media file name", () => {
    const hash = "a".repeat(64);
    expect(parseWebsiteMediaFileName(`${hash}.png`)).toEqual({ sha256: hash, ext: "png" });
    for (const bad of [`${hash}`, `${hash}.PNG`, `${"a".repeat(63)}.png`, `../${hash}.png`, `${hash}.png/..`, `${hash}..png`, `${hash}.png%00`, "x.png"]) {
      expect(parseWebsiteMediaFileName(bad), bad).toBeNull();
    }
  });
});

describe("the frozen home page", () => {
  it("allows sections added after the Two Doors landing", () => {
    expect(() => checkHomeFrozen({ html: `${HOME_LANDING_ISLAND}<section class="gs-new"><h2>New</h2></section>`, css: ".gs-new{padding:0}" })).not.toThrow();
  });

  it("refuses a save that moves, drops or restyles the landing", () => {
    for (const part of [
      { html: '<section>New</section>', css: "" },
      { html: `<section>Above</section>${HOME_LANDING_ISLAND}`, css: "" },
      { html: `${HOME_LANDING_ISLAND}${HOME_LANDING_ISLAND}`, css: "" },
      { html: HOME_LANDING_ISLAND, css: "#gs-page .td-public-clients-grid{gap:0}" },
    ]) expect(() => checkHomeFrozen(part)).toThrow(LiveDesignConflict);
  });

  describe("the landing's words from the Website module", () => {
    it("lets the island carry data-copy (text and toggles) but nothing structural", () => {
      const tag = landingTag({ showCue: false, cueText: 'Pick "one" <b>' });
      expect(landingCopyOf(tag)).toEqual({ showCue: false, cueText: 'Pick "one" <b>' });
      expect(() => checkHomeFrozen({ html: `${tag}<section>Below</section>`, css: "" })).not.toThrow();
      expect(landingTag({})).toBe(HOME_LANDING_ISLAND);
      for (const bad of [
        '<gs-island name="two-doors-landing" data-copy="{&quot;chooseHref&quot;:&quot;/x&quot;}"></gs-island>',
        '<gs-island name="two-doors-landing" data-copy="[1]"></gs-island>',
        '<gs-island name="two-doors-landing" data-style="big"></gs-island>',
      ]) expect(() => checkHomeFrozen({ html: bad, css: "" })).toThrow(LiveDesignConflict);
      expect(() => checkHomeFrozen({ html: tag, css: ".td-cue{display:none}" })).toThrow(LiveDesignConflict);
    });

    it("merges new words into the page's landing and saves the next version", async () => {
      const saved: unknown[] = [];
      const store = {
        readRevision: async () => ({ revisionNumber: 20, content: { format: "gs-html", html: `${landingTag({ cueText: "Old" })}<section>Below</section>`, css: "" } }),
        readDocument: async () => ({ latestRevisionId: "r20" }),
        saveRevision: async (input: { content: unknown }) => { saved.push(input.content); return { state: "saved" as const, revisionId: "r21" }; },
      };
      const page = { id: "p", companyId: "c", siteId: "s", documentId: "d", title: "Home", slug: "/" };
      const source = websitePageSource(store, page, async () => null);
      expect(await source.setIslandCopy!("r20", { showCue: false }, "agent1")).toBe("r21");
      expect(saved[0]).toMatchObject({ html: `${landingTag({ cueText: "Old", showCue: false })}<section>Below</section>` });
      expect(withLandingCopy("<main id=\"gs-page\"><section>No landing</section></main>", { showCue: false })).toBeNull();
    });
  });
});
