import { afterEach, describe, expect, it } from "vitest";
import { applyEditsToPage } from "../services/live-design-direct.js";
import {
  LiveDesignConflict,
  pollLiveDesign,
  resetLiveDesignSessions,
  saveLiveDesignEditsDirect,
  startLiveDesign,
  viewLiveDesign,
} from "../services/live-design.js";
import { handleImpeccableRequest } from "../services/impeccable-helper.js";

// A page as it is stored: the landing tag first, then sections with twins, a sentence with a link, an image.
const PAGE = [
  `<main id="gs-page">`,
  `  <gs-island name="two-doors" props='{"a":1}'></gs-island>`,
  `  <section class="hero dark">`,
  `    <h1 class="title">Digital that lasts</h1>`,
  `    <p class="lede">We build   systems &amp; teams. <a href="/contact">Talk to us</a> today.</p>`,
  `    <img class="pic" src="/img/team-photo.jpg?v=2" alt="The team">`,
  `  </section>`,
  `  <section class="cards">`,
  `    <div class="card"><h3>Plan</h3><p>Same words</p></div>`,
  `    <div class="card"><h3>Build</h3><p>Same words</p></div>`,
  `    <div class="card wide"><gs-island name="quote"></gs-island><p>Has a built-in part</p></div>`,
  `  </section>`,
  `</main>`,
].join("\n");

// The public site's frame shows the page as main > div#gs-page with every island inside a div;
// GSAM's own frame shows main#gs-page. Both must land on the same stored element.
const site = (rest: string) => `body>div.shell:nth-of-type(1)>main:nth-of-type(1)>div#gs-page:nth-of-type(1)>${rest}`;
const own = (rest: string) => `body>main#gs-page:nth-of-type(1)>${rest}`;
const text = (ref: string, tagName: string, originalText: string, newText: string, more: Record<string, unknown> = {}) =>
  ({ ref, tag: tagName, originalText, newText, leaf: { tagName, originalText, newText }, ...more });
const removal = (ref: string, tag: string, originalText: string, textContent: string, more: Record<string, unknown> = {}) =>
  ({ ref, tag, elementId: "", originalText, deleted: true, removeElement: true, leaf: { textContent }, ...more });
const html = (result: ReturnType<typeof applyEditsToPage>) => {
  if ("failed" in result) throw new Error(result.failed);
  return result.html;
};

describe("writing the editor's own edits into the page", () => {
  it("changes words found by path, in either frame's shape, and leaves every other byte alone", () => {
    for (const ref of [site("section.hero.dark:nth-of-type(1)>h1.title:nth-of-type(1)"), own("section.hero.dark:nth-of-type(1)>h1.title:nth-of-type(1)")]) {
      expect(html(applyEditsToPage(PAGE, [text(ref, "h1", "Digital that lasts", "Lasting digital")])))
        .toBe(PAGE.replace("Digital that lasts", "Lasting digital"));
    }
  });

  it("counts an island as a div where the site's frame wraps it, so the path still lands", () => {
    // In the site's frame the third card's own island div comes first, so its paragraph is still p:nth-of-type(1),
    // and the landing island makes no difference to the sections. A div path past an island must skip it.
    const twoIslands = PAGE.replace(`<section class="hero dark">`, `<div class="band"><p>One</p></div>\n  <div class="band"><p>One</p></div>\n  <section class="hero dark">`);
    const out = html(applyEditsToPage(twoIslands, [text(site("div.band:nth-of-type(3)>p:nth-of-type(1)"), "p", "One", "Two")]));
    expect(out).toBe(twoIslands.replace(`<div class="band"><p>One</p></div>\n  <section`, `<div class="band"><p>Two</p></div>\n  <section`));
    // GSAM's own frame keeps the raw tag, so the same element is the second div there.
    expect(html(applyEditsToPage(twoIslands, [text(own("div.band:nth-of-type(2)>p:nth-of-type(1)"), "p", "One", "Two")]))).toBe(out);
  });

  it("tells twins apart by path, and gives up when the path cannot", () => {
    const second = site("section.cards:nth-of-type(2)>div.card:nth-of-type(2)>p:nth-of-type(1)");
    expect(html(applyEditsToPage(PAGE, [text(second, "p", "Same words", "New words")])))
      .toBe(PAGE.replace("<h3>Build</h3><p>Same words</p>", "<h3>Build</h3><p>New words</p>"));
    expect(applyEditsToPage(PAGE, [text(own("p:nth-of-type(9)"), "p", "Same words", "New words")])).toHaveProperty("failed");
    // A path that went wrong still finds words that appear once (the frame's own helper spans shift the counts).
    expect(html(applyEditsToPage(PAGE, [text(own("section:nth-of-type(7)>h3:nth-of-type(1)"), "h3", "Build", "Make")]))).toBe(PAGE.replace("Build", "Make"));
  });

  it("changes one run of words in a sentence that also holds a link", () => {
    const parentRef = site("section.hero.dark:nth-of-type(1)>p.lede:nth-of-type(1)");
    const out = html(applyEditsToPage(PAGE, [
      text(`${parentRef}>span:nth-of-type(1)`, "span", "We build systems & teams.", "We build things.", { restore: { kind: "mixedTextNode", parentRef, textIndex: 0 } }),
      text(`${parentRef}>span:nth-of-type(2)`, "span", "today.", "now.", { restore: { kind: "mixedTextNode", parentRef, textIndex: 1 } }),
    ]));
    expect(out).toBe(PAGE.replace("We build   systems &amp; teams. <a", "We build things. <a").replace("</a> today.", "</a> now."));
  });

  it("writes the new words as text, never as markup", () => {
    const out = html(applyEditsToPage(PAGE, [text(own("section.hero.dark:nth-of-type(1)>h1.title:nth-of-type(1)"), "h1", "Digital that lasts", `<img src=x onerror=alert(1)> & "more"`)]));
    expect(out).toContain(`<h1 class="title">&lt;img src=x onerror=alert(1)&gt; &amp; "more"</h1>`);
    expect(out).not.toContain("<img src=x");
  });

  it("removes an element, and a twin only when the path is exact", () => {
    const image = removal(site("section.hero.dark:nth-of-type(1)>img.pic:nth-of-type(1)"), "img", "The team", "");
    expect(html(applyEditsToPage(PAGE, [image]))).toBe(PAGE.replace(`<img class="pic" src="/img/team-photo.jpg?v=2" alt="The team">`, ""));
    const card = (ref: string) => removal(ref, "div", "Same words", "BuildSame words");
    expect(html(applyEditsToPage(PAGE, [card(site("section.cards:nth-of-type(2)>div.card:nth-of-type(2)"))])))
      .toBe(PAGE.replace(`<div class="card"><h3>Build</h3><p>Same words</p></div>`, ""));
    // Two paragraphs say "Same words": a path whose classes do not match the saved page cannot pick one.
    const twin = (ref: string) => removal(ref, "p", "Same words", "Same words");
    expect(applyEditsToPage(PAGE, [twin(site("section.other:nth-of-type(2)>div.card:nth-of-type(2)>p:nth-of-type(1)"))])).toHaveProperty("failed");
    expect(html(applyEditsToPage(PAGE, [twin(site("section.cards:nth-of-type(2)>div.card:nth-of-type(2)>p:nth-of-type(1)"))])))
      .toBe(PAGE.replace("<h3>Build</h3><p>Same words</p>", "<h3>Build</h3>"));
  });

  it("drops an edit of words inside something removed in the same save", () => {
    const out = html(applyEditsToPage(PAGE, [
      text(site("section.cards:nth-of-type(2)>div.card:nth-of-type(1)>h3:nth-of-type(1)"), "h3", "Plan", "Scope"),
      // The frame removed the card after the heading changed, so the words it saw are the new ones.
      removal(site("section.cards:nth-of-type(2)>div.card:nth-of-type(1)"), "div", "Same words", "ScopeSame words"),
    ]));
    expect(out).toBe(PAGE.replace(`<div class="card"><h3>Plan</h3><p>Same words</p></div>`, ""));
  });

  it("refuses built-in parts, the shared header, and anything it cannot find", () => {
    const refuse = (op: Record<string, unknown>) => expect(applyEditsToPage(PAGE, [op])).toHaveProperty("failed");
    // A card that holds a built-in part, the landing itself, and the whole page.
    refuse(removal(site("section.cards:nth-of-type(2)>div.card.wide:nth-of-type(3)"), "div", "Has a built-in part", "Has a built-in part"));
    refuse(removal(site("div:nth-of-type(1)"), "gs-island", "two-doors", ""));
    refuse(removal("body>main#gs-page:nth-of-type(1)", "main", "Digital that lasts", "x"));
    // The shared header is outside the page: its path never reaches #gs-page.
    refuse(text("body>header.site:nth-of-type(1)>a:nth-of-type(1)", "a", "Talk to us", "Call us"));
    refuse(text(own("section:nth-of-type(1)>h1:nth-of-type(1)"), "h1", "Words that are not there", "New"));
    refuse(text(own("section:nth-of-type(1)>h1:nth-of-type(1)"), "h1", "Digital that lasts", "   "));
    refuse({ ref: own("section:nth-of-type(1)"), tag: "section", moveBefore: "x" });
  });

  it("works on a plain file with no page root", () => {
    const file = `<!doctype html><html><head><title>Deck</title></head><body><h1>Old</h1><p>Keep</p></body></html>`;
    expect(html(applyEditsToPage(file, [text("body>h1:nth-of-type(1)", "h1", "Old", "New")]))).toBe(file.replace("Old", "New"));
  });
});

describe("Save to draft without the agent", () => {
  afterEach(() => resetLiveDesignSessions());

  const stash = (s: Parameters<typeof handleImpeccableRequest>[0], op: Record<string, unknown>) =>
    handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-stash", body: JSON.stringify({ ops: [op] }) });
  const heading = text(own("section.hero.dark:nth-of-type(1)>h1.title:nth-of-type(1)"), "h1", "Digital that lasts", "Lasting digital");
  const pageSource = (save: (html: string, agentId: string, userId?: string | null) => Promise<string>) =>
    ({ kind: "website-page" as const, label: "About (/about)", frameSrc: () => "", read: async () => PAGE, save, version: async () => 7 });

  it("saves the staged edits as the person, clears them, and tells the frame and the agent", async () => {
    const saved: unknown[] = [];
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1",
      source: pageSource(async (...args) => { saved.push(args); return "r7"; }) });
    await pollLiveDesign(s, 1000);
    stash(s, heading);
    const result = await saveLiveDesignEditsDirect(s, "user-1");
    expect(result).toMatchObject({ saved: true, attachmentId: "r7", version: 7, applied: 1 });
    expect(saved).toEqual([[PAGE.replace("Digital that lasts", "Lasting digital"), "agent1", "user-1"]]);
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", attachmentId: "r7", stagedCount: 0 });
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "manual_edit_commit_done", appliedCount: 1 });
    expect(s.messages.at(-1)?.text).toContain("version 7");
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "restored", attachmentId: "r7" });
  });

  it("leaves the edits for the agent when one cannot be placed, and saves nothing", async () => {
    let saves = 0;
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1",
      source: pageSource(async () => { saves += 1; return "r7"; }) });
    stash(s, heading);
    stash(s, text("body>header:nth-of-type(1)>a:nth-of-type(1)", "a", "Talk to us", "Call us"));
    expect(await saveLiveDesignEditsDirect(s, "user-1")).toBeNull();
    expect(saves).toBe(0);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 2 });
    // The usual path still takes them.
    expect(handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-commit?async=1", body: null }).status).toBe(202);
  });

  it("keeps the edits and says why when the page refuses the save", async () => {
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1",
      source: pageSource(async () => { throw new LiveDesignConflict("The home page keeps the Two Doors landing first and unchanged."); }) });
    await pollLiveDesign(s, 1000);
    stash(s, heading);
    expect(await saveLiveDesignEditsDirect(s, "user-1")).toMatchObject({ saved: false, reason: expect.stringContaining("Two Doors") });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", stagedCount: 1, attachmentId: "r6" });
    expect(s.messages.some((m) => m.text.startsWith("Not saved: The home page keeps"))).toBe(true);
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "manual_edit_commit_failed" });
  });

  it("does nothing with no page behind the session, nothing staged, or a request open", async () => {
    const { session: plain } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "a1", agentId: "agent1" });
    stash(plain, heading);
    expect(await saveLiveDesignEditsDirect(plain, "user-1")).toBeNull();
    resetLiveDesignSessions();
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1", source: pageSource(async () => "r7") });
    expect(await saveLiveDesignEditsDirect(s, "user-1")).toBeNull();
  });
});
