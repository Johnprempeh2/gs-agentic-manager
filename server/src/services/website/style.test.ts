import { describe, expect, it } from "vitest";
import { buildSiteStyle, nameFromVariable, parseColour, parseCss, stylesheetLinks, themeVariables } from "./style.js";

const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Inter");
/* the site's tokens */
:root {
  --gs-bg: #0b0b0c;
  --gs-surface: rgba(255,255,255,.04);
  --gs-text: #f5f5f0;
  --gs-muted: #8a8a85;
  --gs-accent: #c8ff00;
  --gs-line: var(--gs-muted);
  --gs-radius: 14px;
  --gs-space-4: 24px;
  --gs-ease: cubic-bezier(.2,.8,.2,1);
  --gs-font: "Montserrat", system-ui, sans-serif;
}
body { background: var(--gs-bg); color: var(--gs-text); font-family: var(--gs-font); line-height: 1.6; }
h1, .h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); font-weight: 700; line-height: 1.05; letter-spacing: -0.02em; }
h2 { font-size: 2rem; font-weight: 600; }
small { font-size: .8rem; color: var(--gs-muted); }
a { color: var(--gs-accent); text-decoration: underline; }
.btn { padding: 12px 20px; border-radius: 999px; font-weight: 600; }
.btn--primary { background: var(--gs-accent); color: var(--gs-bg); }
.btn--ghost { border: 1px solid var(--gs-line); color: var(--gs-text); }
.card { background: var(--gs-surface); border: 1px solid var(--gs-line); border-radius: var(--gs-radius); }
.pill { border-radius: 999px; font-size: 12px; }
.hero-band { background: linear-gradient(180deg, var(--gs-bg), #000); }
.card .title { color: red; }
@media (max-width: 600px) { :root { --gs-bg: #ffffff; } h1 { font-size: 2rem; } }
@font-face { font-family: "Montserrat"; font-weight: 400 700; src: url(data:font/woff2;base64,AAA;) format("woff2"); }
@keyframes fade-up { from { opacity: 0 } to { opacity: 1 } }
`;

describe("website style read", () => {
  it("parses rules, media, font faces and keyframes", () => {
    const parsed = parseCss(CSS);
    expect(parsed.keyframes).toEqual(["fade-up"]);
    expect(parsed.fontFaces).toEqual([{ family: "Montserrat", weight: "400 700" }]);
    expect(parsed.rules.find((r) => r.media)?.media).toBe("@media (max-width: 600px)");
    expect(parsed.rules.find((r) => r.selector === "body")?.declarations).toContainEqual(["line-height", "1.6"]);
  });

  it("reads colours in the usual forms", () => {
    expect(parseColour("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColour("rgba(255,255,255,.04)")).toEqual({ r: 255, g: 255, b: 255, a: 0.04 });
    expect(parseColour("rgb(0 0 0 / 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColour("hsl(0, 100%, 50%)")).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseColour("linear-gradient(red, blue)")).toBeNull();
  });

  it("maps release theme keys to the site's CSS variables", () => {
    const vars = themeVariables({ gs: { accent: "#ff3366" }, "gs.textMuted": "#999", "--gs-bg": "#111" });
    expect(vars.get("--gs-accent")).toEqual({ token: "gs.accent", value: "#ff3366" });
    expect(vars.get("--gs-text-muted")).toEqual({ token: "gs.textMuted", value: "#999" });
    expect(vars.get("--gs-bg")).toEqual({ token: "--gs-bg", value: "#111" });
    expect(nameFromVariable("--gs-accent-dim")).toBe("Accent dim");
  });

  it("builds colours with roles, release overrides and contrast", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: { gs: { accent: "#ff3366" } }, css: CSS,
      stylesheets: ["https://example.com/site.css"], fontStylesheets: [], problem: null, readAt: new Date("2026-10-25T12:00:00Z"),
    });
    const byVar = Object.fromEntries(style.colours.map((c) => [c.cssVar, c]));
    expect(byVar["--gs-bg"]).toMatchObject({ hex: "#0b0b0c", role: "background", source: "stylesheet" });
    expect(byVar["--gs-bg"].usedFor).toContain("background");
    expect(byVar["--gs-text"]).toMatchObject({ role: "text" });
    expect(byVar["--gs-accent"]).toMatchObject({ hex: "#ff3366", token: "gs.accent", source: "release", role: "accent" });
    // `--gs-line` is `var(--gs-muted)`: one colour, two names.
    const muted = style.colours.find((c) => c.hex === "#8a8a85");
    expect([muted?.cssVar, ...(muted?.aliases ?? [])].sort()).toEqual(["--gs-line", "--gs-muted"]);
    expect(muted?.role).toBe("border");
    expect(byVar["--gs-surface"]).toMatchObject({ alpha: 0.04 });
    expect(style.releaseTokenCount).toBe(1);

    // Body text on the page background leads; the button's text sits on its own fill (the release accent).
    expect(style.contrast[0]).toMatchObject({ text: "#f5f5f0", textName: "Text", background: "#0b0b0c", backgroundName: "Bg", rating: "AAA" });
    expect(style.contrast[0].usedIn[0]).toBe("body");
    expect(style.contrast[0].ratio).toBeGreaterThan(15);
    expect(style.contrast).toContainEqual(expect.objectContaining({ text: "#0b0b0c", background: "#ff3366", usedIn: [".btn--primary"] }));
  });

  it("merges variables with the same value into one colour with aliases", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: {}, stylesheets: [], fontStylesheets: [], problem: null,
      css: ":root { --blue: #007bff; --primary: #007bff; --grey: #848896; --textgrey: #848896; } body { color: #848896; }",
    });
    expect(style.colours).toHaveLength(2);
    expect(style.colours.find((c) => c.hex === "#007bff")).toMatchObject({ cssVar: "--primary", aliases: ["--blue"], role: "accent", unused: true });
    expect(style.colours.find((c) => c.hex === "#848896")).toMatchObject({ cssVar: "--textgrey", aliases: ["--grey"], role: "text", usedIn: ["body"] });
  });

  it("counts only the rules that apply to the page, so a framework's unused parts fold away", () => {
    const html = `<body><h1>Hi</h1><p>Copy</p><a class="btn btn-orange">Go</a><span class="text-white">x</span><div class="fade-in stack"></div></body>`;
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: {}, stylesheets: [], fontStylesheets: [], problem: null, html,
      css: `:root { --orange: #f99e00; --teal: #20c997; --pink: #ff4c81; --breakpoint-md: 768px; --gap: 24px; }
        body { color: #848896; background-color: #fff; font-family: Inter, sans-serif; }
        h1 { color: #313441; }
        code { color: var(--pink); font-family: SFMono-Regular, monospace; }
        .btn { padding: 8px 16px; border-radius: 50px; }
        .btn-orange { color: #fff; background-color: #f99e00; }
        .btn-teal { color: #fff; background-color: var(--teal); }
        .text-white { color: #fff; }
        .stack { gap: var(--gap); }
        .fade-in { animation: fade-up .3s ease; }
        @keyframes fade-up { from { opacity: 0 } to { opacity: 1 } }
        @keyframes spinner-grow { to { transform: scale(1) } }`,
    });
    const byHex = Object.fromEntries(style.colours.map((c) => [c.hex, c]));
    expect(byHex["#f99e00"]).toMatchObject({ role: "accent", unused: false, usedIn: [".btn-orange"] });
    expect(byHex["#20c997"].unused).toBe(true);
    // Pink is only used by `code`, which the page does not have.
    expect(byHex["#ff4c81"].unused).toBe(true);

    expect(style.contrast.map((c) => c.usedIn[0])).toEqual(["body", "h1", ".btn-orange"]);
    expect(style.contrast[0]).toMatchObject({ text: "#848896", background: "#ffffff" });
    // `.text-white` sits on a background the stylesheet does not say: no pair.
    expect(style.contrast.some((c) => c.usedIn.includes(".text-white"))).toBe(false);

    expect(style.components.filter((c) => c.kind === "button").map((c) => [c.selector, c.inPage])).toEqual([
      [".btn", true], [".btn-orange", true], [".btn-teal", false],
    ]);
    const token = (name: string) => style.tokens.find((t) => t.name === name);
    expect(token("--breakpoint-md")?.framework).toBe(true);
    expect(token("--gap")?.framework).toBe(false);
    expect(token("@keyframes fade-up")?.framework).toBe(false);
    expect(token("@keyframes spinner-grow")?.framework).toBe(true);
    expect(style.fonts.map((f) => f.family)).toEqual(["Inter"]);
  });

  it("counts rules that write the colour itself rather than the variable", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: {},
      css: ":root { --pink: #ff4c81; --ink: #111; --blue: #00f; } .btn-blue { background: #0000ff; } .tag { color: #FF4C81; } .hero { background: rgb(255, 76, 129); } .x { color: #ff4c8180; }",
      stylesheets: [], fontStylesheets: [], problem: null,
    });
    const pink = style.colours.find((c) => c.cssVar === "--pink");
    expect(pink?.usedFor).toEqual(expect.arrayContaining(["text", "background"]));
    expect(pink?.usedIn).toEqual([".tag", ".hero"]);
    expect(style.colours.find((c) => c.cssVar === "--ink")?.usedIn).toEqual([]);
    expect(style.colours.find((c) => c.cssVar === "--blue")).toMatchObject({ usedIn: [".btn-blue"] });
  });

  it("reads fonts, the type scale, building blocks, tokens and surfaces", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: {}, css: CSS, stylesheets: [],
      fontStylesheets: ["https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap"], problem: null,
    });
    expect(style.fonts[0]).toMatchObject({ family: "Montserrat", weights: [400, 600, 700], loadedFrom: "google" });
    expect(style.fonts[0].usedIn).toContain("body");

    const h1 = style.textStyles.find((t) => t.selector === "h1");
    expect(h1).toMatchObject({ fontWeight: "700", lineHeight: "1.05", fontSize: "clamp(2.5rem, 6vw, 4.5rem)" });
    expect(h1?.fontFamily).toContain("Montserrat");
    expect(style.textStyles.find((t) => t.selector === "small")?.color).toBe("#8a8a85");

    const primary = style.components.find((c) => c.selector === ".btn--primary");
    expect(primary).toMatchObject({ kind: "button", className: "btn btn--primary" });
    expect(primary?.declarations.background).toBe("#c8ff00");
    // The base class's padding and radius come with the modifier.
    expect(primary?.declarations).toMatchObject({ padding: "12px 20px", "border-radius": "999px" });
    expect(style.components.map((c) => c.kind)).toEqual(expect.arrayContaining(["link", "card", "pill"]));
    expect(style.components.some((c) => c.selector.includes(" "))).toBe(false);

    expect(style.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "--gs-radius", kind: "radius", value: "14px" }),
      expect.objectContaining({ name: "--gs-space-4", kind: "spacing" }),
      expect.objectContaining({ name: "--gs-ease", kind: "motion" }),
      expect.objectContaining({ name: "@keyframes fade-up", kind: "motion" }),
    ]));
    expect(style.surfaces.map((s) => s.selector)).toEqual(["body", ".hero-band"]);
  });

  it("leaves out icon fonts, generic fallbacks and the inside of cards", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: {}, stylesheets: [], fontStylesheets: [], problem: null,
      css: `.fa { font-family: "Font Awesome 5 Pro"; } code { font-family: monospace; } body { font-family: Inter, sans-serif; }
        .card { padding: 1rem; } .card-body { padding: 1rem; } .card-title { font-weight: 600; } .badge-pill { border-radius: 10rem; }`,
    });
    expect(style.fonts.map((f) => f.family)).toEqual(["Inter"]);
    expect(style.components.map((c) => c.selector)).toEqual([".card", ".badge-pill"]);
    expect(style.components[1].className).toBe("badge-pill");
  });

  it("still shows the release tokens when the site has no stylesheet", () => {
    const style = buildSiteStyle({
      siteId: "s1", siteUrl: "https://example.com/", theme: { gs: { accent: "#ff3366" } }, css: "",
      stylesheets: [], fontStylesheets: [], problem: "The site could not be read: timeout",
    });
    expect(style.colours).toHaveLength(1);
    expect(style.problem).toContain("could not be read");
  });

  it("finds the site's own stylesheets and font stylesheets", () => {
    const html = `<head>
      <link rel="stylesheet" href="/assets/site.css">
      <link rel="preconnect" href="https://fonts.gstatic.com">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.other.com/lib.css">
      <style>:root{--x:#fff}</style></head>`;
    const links = stylesheetLinks(html, "https://example.com/");
    expect(links.own).toEqual(["https://example.com/assets/site.css"]);
    expect(links.fonts).toEqual(["https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"]);
    expect(links.inline).toContain("--x");
  });
});
