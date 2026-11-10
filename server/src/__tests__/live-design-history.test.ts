import { afterEach, describe, expect, it } from "vitest";
import { applyEditsToPage, previewEdits } from "../services/live-design-direct.js";
import { previewPart } from "../services/website/live-page.js";
import {
  liveDesignPreviewOps,
  pollLiveDesign,
  redoLiveDesignEdit,
  resetLiveDesignSessions,
  restoreLiveDesign,
  saveLiveDesignEditsDirect,
  startLiveDesign,
  undoLiveDesignEdit,
  viewLiveDesign,
} from "../services/live-design.js";
import { handleImpeccableRequest } from "../services/impeccable-helper.js";

const PAGE = [
  `<main id="gs-page">`,
  `  <section class="hero">`,
  `    <h1 class="title">Digital that lasts</h1>`,
  `    <a class="btn" href="/contact">Book a call</a>`,
  `  </section>`,
  `  <section class="cards">`,
  `    <div class="card"><h3>Plan</h3><p>Same words</p></div>`,
  `    <div class="card"><h3>Build</h3><p>Same words</p></div>`,
  `  </section>`,
  `</main>`,
].join("\n");

const own = (rest: string) => `body>main#gs-page:nth-of-type(1)>${rest}`;
const text = (ref: string, tagName: string, originalText: string, newText: string) =>
  ({ ref, tag: tagName, originalText, newText, leaf: { tagName, originalText, newText } });
const removal = (ref: string, tag: string, originalText: string, textContent: string) =>
  ({ ref, tag, elementId: "", originalText, deleted: true, removeElement: true, leaf: { textContent } });
const heading = (to: string, from = "Digital that lasts") => text(own("section.hero:nth-of-type(1)>h1.title:nth-of-type(1)"), "h1", from, to);
const firstCard = removal(own("section.cards:nth-of-type(2)>div.card:nth-of-type(1)"), "div", "Plan", "PlanSame words");

const pageSource = (save: (html: string) => Promise<string> = async () => "r7") =>
  ({ kind: "website-page" as const, label: "About (/about)", frameSrc: () => "", read: async () => PAGE, save, version: async () => 7 });
const stash = (s: Parameters<typeof handleImpeccableRequest>[0], op: Record<string, unknown>) =>
  handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-stash", body: JSON.stringify({ ops: [op] }) });

describe("Undo and Redo of edits not saved yet", () => {
  afterEach(() => resetLiveDesignSessions());

  it("steps back and forward one edit at a time, and a new edit ends the redo line", () => {
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1", source: pageSource() });
    stash(s, heading("One"));
    stash(s, heading("Two", "One"));
    undoLiveDesignEdit(s);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 1, redoCount: 1 });
    expect(s.messages.at(-1)?.text).toBe("Undone: changing “One” to “Two”.");
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "manual_edit_discarded", pendingCount: 1 });
    undoLiveDesignEdit(s);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 0, redoCount: 2 });
    // Nothing left to undo: no change, no error.
    undoLiveDesignEdit(s);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 0, redoCount: 2 });
    redoLiveDesignEdit(s);
    expect(s.staged.flatMap((e) => e.ops).map((op) => op.newText)).toEqual(["One"]);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 1, redoCount: 1 });
    stash(s, firstCard);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 2, redoCount: 0 });
  });

  it("clears the redo line on a save, a discard and a restore", async () => {
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1", source: pageSource() });
    await pollLiveDesign(s, 1000);
    stash(s, heading("One"));
    stash(s, heading("Two", "One"));
    undoLiveDesignEdit(s);
    expect(await saveLiveDesignEditsDirect(s, "user-1")).toMatchObject({ saved: true });
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 0, redoCount: 0 });

    stash(s, heading("Three"));
    undoLiveDesignEdit(s);
    handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-discard", body: null });
    expect(viewLiveDesign(s)).toMatchObject({ redoCount: 0 });

    stash(s, heading("Four"));
    undoLiveDesignEdit(s);
    restoreLiveDesign(s, "r5", 5);
    expect(viewLiveDesign(s)).toMatchObject({ stagedCount: 0, redoCount: 0, attachmentId: "r5" });
  });

  it("refuses while a save is under way", () => {
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1", source: pageSource() });
    stash(s, heading("One"));
    s.editsRequestId = "direct-1";
    expect(() => undoLiveDesignEdit(s)).toThrow(/being saved/);
    expect(() => redoLiveDesignEdit(s)).toThrow(/being saved/);
  });
});

describe("the frame shows the edits not saved yet after it reloads", () => {
  afterEach(() => resetLiveDesignSessions());

  it("changes the words and hides a removed element in place, so later paths still match the saved page", () => {
    const shown = previewEdits(PAGE, [heading("Lasting digital"), firstCard]);
    expect(shown).toContain(`<h1 class="title">Lasting digital</h1>`);
    expect(shown).toContain(`<div class="card" hidden data-gs-staged-removed><h3>Plan</h3>`);
    // The second card is still the second div, so an edit made on the reloaded frame saves onto the right twin.
    const later = text(own("section.cards:nth-of-type(2)>div.card:nth-of-type(2)>p:nth-of-type(1)"), "p", "Same words", "Other words");
    const saved = applyEditsToPage(PAGE, [heading("Lasting digital"), firstCard, later]);
    expect("html" in saved && saved.html).toContain(`<div class="card"><h3>Build</h3><p>Other words</p></div>`);
    expect("html" in saved && saved.html).not.toContain("Plan");
  });

  it("shows the page as saved when an edit cannot be placed, and for any version but the session's", () => {
    expect(previewEdits(PAGE, [text("body>header:nth-of-type(1)>a:nth-of-type(1)", "a", "Talk", "Call")])).toBe(PAGE);
    const { session: s } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "r6", agentId: "agent1", source: pageSource() });
    stash(s, heading("One"));
    expect(liveDesignPreviewOps(s.id, "r6", "c1")).toHaveLength(1);
    expect(liveDesignPreviewOps(s.id, "r5", "c1")).toEqual([]);
    expect(liveDesignPreviewOps(s.id, "r6", "other-company")).toEqual([]);
    expect(liveDesignPreviewOps("not-a-session", "r6", "c1")).toEqual([]);
  });

  it("hands the site's engine the page part with the edits and the hiding rule", () => {
    const part = { html: PAGE.replace(/^<main id="gs-page">|<\/main>$/g, ""), css: ".card{display:flex}" };
    const shown = previewPart(part, [firstCard]);
    expect(shown.html).toContain(`<div class="card" hidden data-gs-staged-removed>`);
    expect(shown.css).toBe(".card{display:flex}\n[data-gs-staged-removed]{display:none!important}");
    expect(previewPart(part, [])).toBe(part);
  });
});

