import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  endLiveDesign,
  liveDesignPreviewOps,
  pollLiveDesign,
  redoLiveDesignEdit,
  resetLiveDesignSessions,
  restoreLiveDesign,
  saveLiveDesignEditsDirect,
  setLiveDesignStoreFile,
  startLiveDesign,
  undoLiveDesignEdit,
  viewLiveDesign,
} from "../services/live-design.js";
import { handleImpeccableRequest } from "../services/impeccable-helper.js";

const PAGE = `<main id="gs-page"><section class="hero"><h1 class="title">Digital that lasts</h1><a class="btn" href="/contact">Book a call</a></section></main>`;
const own = (rest: string) => `body>main#gs-page:nth-of-type(1)>${rest}`;
const heading = (to: string, from = "Digital that lasts") => {
  const ref = own("section.hero:nth-of-type(1)>h1.title:nth-of-type(1)");
  return { ref, tag: "h1", originalText: from, newText: to, leaf: { tagName: "h1", originalText: from, newText: to } };
};
const source = (save: (html: string) => Promise<string> = async () => "r7") =>
  ({ kind: "website-page" as const, label: "About (/about)", frameSrc: () => "", read: async () => PAGE, save, version: async () => 7 });
const open = (userId: string, attachmentId = "r6") =>
  startLiveDesign({ companyId: "c1", issueId: "website-page:p1", attachmentId, agentId: "agent1", source: source(), userId }).session;
const stash = (s: ReturnType<typeof open>, op: Record<string, unknown>, userId: string) =>
  handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-stash", body: JSON.stringify({ ops: [op] }), userId });
/** A GSAM restart or crash: everything in memory goes; only the store file is left. */
const restart = () => resetLiveDesignSessions();

describe("edits not saved yet survive a restart (autosave option 3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-autosave-"));
    setLiveDesignStoreFile(path.join(dir, "live-design-chats.json"));
  });
  afterEach(() => {
    setLiveDesignStoreFile(null);
    resetLiveDesignSessions();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts the person's edits and their Redo line back after a restart, with a note, and makes no version", () => {
    const s = open("john");
    stash(s, heading("One"), "john");
    stash(s, heading("Two", "One"), "john");
    undoLiveDesignEdit(s);
    // Written at once, not on a timer: a crash a moment later keeps them.
    expect(fs.existsSync(path.join(dir, "live-design-chats.json"))).toBe(true);

    restart();
    const back = open("john");
    expect(viewLiveDesign(back)).toMatchObject({ stagedCount: 1, redoCount: 1, restoredCount: 1 });
    expect(back.messages.at(-1)?.text).toBe("Restored 1 unsaved edit from last time. Save to draft keeps it; Discard all drops it.");
    // The page frame draws them, and Undo and Redo carry on where they were.
    expect(liveDesignPreviewOps(back.id, "r6")).toHaveLength(1);
    redoLiveDesignEdit(back);
    expect(back.staged.flatMap((e) => e.ops).map((op) => op.newText)).toEqual(["One", "Two"]);
    expect(viewLiveDesign(back).restoredCount).toBe(0);
    // Still the same version: nothing was saved on the way.
    expect(back.attachmentId).toBe("r6");
  });

  it("keeps edits per person: someone else opening the page does not get them", () => {
    const s = open("john");
    stash(s, heading("One"), "john");
    endLiveDesign(s);
    restart();
    expect(viewLiveDesign(open("ben"))).toMatchObject({ stagedCount: 0 });
    restart();
    expect(viewLiveDesign(open("john"))).toMatchObject({ stagedCount: 1 });
  });

  it("clears them on Save to draft, Discard all and Restore", async () => {
    let s = open("john");
    await pollLiveDesign(s, 1000);
    stash(s, heading("One"), "john");
    expect(await saveLiveDesignEditsDirect(s, "john")).toMatchObject({ saved: true });
    restart();
    expect(viewLiveDesign(open("john", "r7"))).toMatchObject({ stagedCount: 0 });

    restart();
    s = open("john");
    stash(s, heading("One"), "john");
    handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-discard", body: null });
    restart();
    expect(viewLiveDesign(open("john"))).toMatchObject({ stagedCount: 0, redoCount: 0 });

    restart();
    s = open("john");
    stash(s, heading("One"), "john");
    undoLiveDesignEdit(s);
    restoreLiveDesign(s, "r5", 5);
    restart();
    expect(viewLiveDesign(open("john", "r5"))).toMatchObject({ stagedCount: 0, redoCount: 0 });
  });

  it("does not put edits onto a newer version of the page, and says what they were", () => {
    const s = open("john");
    stash(s, heading("One"), "john");
    restart();
    const back = open("john", "r9");
    expect(viewLiveDesign(back)).toMatchObject({ stagedCount: 0 });
    expect(back.messages.at(-1)?.text).toContain("made on an earlier version of this page");
    expect(back.messages.at(-1)?.text).toContain("“One”");
    // And it is not offered again.
    restart();
    expect(viewLiveDesign(open("john"))).toMatchObject({ stagedCount: 0 });
  });
});
