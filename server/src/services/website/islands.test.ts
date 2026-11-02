import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_ISLANDS,
  islandPlaceholderStyle,
  islandsForAgents,
  loadIslandManifest,
  resetIslandCache,
  withIslandPlaceholders,
} from "./islands.js";
import { pollLiveDesign, resetLiveDesignSessions, startLiveDesign } from "../live-design.js";
import { handleImpeccableRequest } from "../impeccable-helper.js";

const SITE_CSS = '<link rel="stylesheet" href="/site.css"><style>:root{--gs-bg:#0b0b0c}</style>';
const PAGE = `<!doctype html><html><head><title>Page</title>${SITE_CSS}</head><body><gs-island name="quote" data-service="audit"></gs-island></body></html>`;
const SITE_ANSWER = {
  islandContract: 1,
  islands: [{ name: "quote", label: "Quote", placeholder: "Adds a service.", height: 96, inline: false, attributes: { "data-service": { pattern: "^[a-z]+$" } } }],
  placeholderCss: 'gs-island[name="quote"]{min-height:96px}',
};
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("website islands in live design", () => {
  afterEach(() => {
    resetIslandCache();
    resetLiveDesignSessions();
  });

  it("adds the placeholder CSS after the site stylesheet", () => {
    const out = withIslandPlaceholders(PAGE, "gs-island{display:flex}");
    const style = out.indexOf("<style data-gs-islands>");
    expect(style).toBeGreaterThan(out.indexOf(":root{--gs-bg:#0b0b0c}</style>"));
    expect(style).toBeGreaterThan(out.indexOf('href="/site.css"'));
    expect(style).toBeLessThan(out.indexOf("</head>"));
  });

  it("goes at the end of head when the page has no stylesheet, and leaves pages without islands alone", () => {
    const bare = "<html><head><title>x</title></head><body><gs-island name=\"quote\"></gs-island></body></html>";
    expect(withIslandPlaceholders(bare, "a{}")).toContain("<style data-gs-islands>a{}</style></head>");
    const plain = "<html><head></head><body><p>No islands</p></body></html>";
    expect(withIslandPlaceholders(plain, "a{}")).toBe(plain);
  });

  it("keeps the CSS inside its style element, whatever the payload holds", () => {
    const hostile = 'gs-island{}</style><script>alert(1)</script><style>a{content:"</StYlE >"}<!--';
    const out = islandPlaceholderStyle(hostile);
    expect(out.startsWith("<style data-gs-islands>")).toBe(true);
    expect(out.endsWith("</style>")).toBe(true);
    // The only "<" left is the element's own tags.
    expect(out.slice("<style data-gs-islands>".length, -"</style>".length)).not.toContain("<");
    expect(out).not.toMatch(/<script/i);
  });

  it("uses the site's /_islands answer when it is contract 1, and caches it", async () => {
    const fetchImpl = answer(SITE_ANSWER);
    const first = await loadIslandManifest("https://example.com/", fetchImpl);
    expect(first).toMatchObject({ source: "site", placeholderCss: SITE_ANSWER.placeholderCss });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/_islands", expect.anything());
    await loadIslandManifest("https://example.com/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the vendored copy when the site cannot be reached", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await loadIslandManifest("https://example.com/", down)).toBe(FALLBACK_ISLANDS);
    expect(await loadIslandManifest("https://other.example/", answer({ error: "nope" }, 404))).toBe(FALLBACK_ISLANDS);
    expect(await loadIslandManifest(null)).toBe(FALLBACK_ISLANDS);
  });

  it("uses the vendored copy when the contract number is not 1", async () => {
    expect(await loadIslandManifest("https://example.com/", answer({ ...SITE_ANSWER, islandContract: 2 }))).toBe(FALLBACK_ISLANDS);
  });

  it("vendors the site's own placeholders for every island", () => {
    expect(FALLBACK_ISLANDS.islandContract).toBe(1);
    const names = FALLBACK_ISLANDS.islands.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["enquiry-form", "quote", "account-entry", "product-list", "stone-3d", "animation"]));
    for (const name of names) expect(FALLBACK_ISLANDS.placeholderCss).toContain(`gs-island[name="${name}"]::before`);
  });

  it("gives the agent the island names and allowed attributes on a website page", async () => {
    const note = islandsForAgents(FALLBACK_ISLANDS);
    expect(note).toContain("- quote: Quote. Attributes: data-service (matching /");
    expect(note).toContain("data-sort (one of: featured, az, price, price-desc)");
    expect(note).toContain("- cookie-settings: Cookie settings. No attributes.");

    const { session } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "a1", agentId: "agent1", islands: note });
    const waiting = pollLiveDesign(session, 5000);
    handleImpeccableRequest(session, {
      method: "POST",
      path: "/events?token=gsam",
      body: JSON.stringify({
        type: "generate",
        id: "imp00001",
        action: "impeccable",
        freeformPrompt: "Tighten it",
        count: 2,
        element: { tagName: "section", textContent: "", outerHTML: "<section></section>", anchor: "section" },
      }),
      extra: { selector: "section" },
    });
    const event = (await waiting) as { _instructions: string };
    expect(event._instructions).toContain(note);
  });
});
