import { describe, expect, it } from "vitest";
import { pageDocument, pagePart, siteAssetOrigin, splitPageDocument } from "../services/website/live-page.js";
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
});
