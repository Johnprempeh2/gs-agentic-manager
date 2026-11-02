import { afterEach, describe, expect, it } from "vitest";
import {
  endLiveDesign,
  impeccableVariantsHtml,
  pollLiveDesign,
  pollLiveDesignFrames,
  replyLiveDesign,
  resetLiveDesignSessions,
  startLiveDesign,
  viewLiveDesign,
} from "../services/live-design.js";
import { handleImpeccableRequest, injectImpeccableLive } from "../services/impeccable-helper.js";

const ids = { companyId: "c1", issueId: "i1", attachmentId: "a1", agentId: "agent1" };
const newAttachment = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const post = (body: Record<string, unknown>, selector?: string) => ({
  method: "POST",
  path: "/events?token=gsam",
  body: JSON.stringify(body),
  extra: selector ? { selector } : {},
});

describe("live design through Impeccable's page tools", () => {
  afterEach(() => resetLiveDesignSessions());

  it("relays a Go, the versions, the accept and the save, then ends", async () => {
    const { session: s, needsWake } = startLiveDesign(ids);
    expect(needsWake).toBe(true);

    // The agent is already waiting when John presses Go in Impeccable's bar.
    const waiting = pollLiveDesign(s, 5000);
    const go = handleImpeccableRequest(s, post({
      type: "generate",
      id: "imp12345",
      action: "impeccable",
      freeformPrompt: "Make it glow",
      count: 3,
      element: { tagName: "a", textContent: "Book", outerHTML: "<a class=\"btn\">Book</a>", anchor: "a.btn" },
    }, "section > a:nth-of-type(1)"));
    expect(go.status).toBe(200);
    expect(await waiting).toMatchObject({
      type: "generate",
      requestId: "imp12345",
      count: 3,
      request: { prompt: "Make it glow", selector: "section > a:nth-of-type(1)", action: "impeccable" },
    });

    const cursor = s.frames.length;
    replyLiveDesign(s, { requestId: "imp12345", message: "Trying three glows." });
    replyLiveDesign(s, {
      requestId: "imp12345",
      variants: [{ html: "<a class=\"btn lv-1\">Book</a>", css: ".lv-1{}", name: "Halo", params: [{ id: "spread", kind: "range" }] }],
    });
    const frames = await pollLiveDesignFrames(s, cursor, 0);
    expect(frames.at(-1)?.data).toMatchObject({ type: "done", id: "imp12345" });
    expect(String(frames.at(-1)?.data.gsVariantsHtml)).toContain('data-impeccable-variants="imp12345"');

    // Impeccable sends variantId 1-based, with any tune values.
    expect(handleImpeccableRequest(s, post({ type: "accept", id: "imp12345", variantId: "1", paramValues: { spread: 40 } })).status).toBe(200);
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "accept", variant: 0, chosen: { name: "Halo" }, paramValues: { spread: 40 } });
    replyLiveDesign(s, { requestId: "imp12345", appliedAttachmentId: newAttachment });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", attachmentId: newAttachment, appliedAttachmentId: newAttachment });
    expect(viewLiveDesign(s).messages.map((m) => m.from)).toEqual(["gsam", "john", "agent", "gsam", "gsam", "gsam"]);

    endLiveDesign(s);
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "end" });
    expect(handleImpeccableRequest(s, post({ type: "generate", id: "x", freeformPrompt: "again", element: {} })).status).toBe(409);
  });

  it("stages pencil edits, undoes one by ref, and has the agent apply the rest", async () => {
    const { session: s } = startLiveDesign(ids);
    const stash = (ref: string, from: string, to: string) =>
      handleImpeccableRequest(s, {
        method: "POST",
        path: "/manual-edit-stash?token=gsam",
        body: JSON.stringify({ id: ref, element: { tagName: "h1" }, ops: [{ ref, tag: "h1", originalText: from, newText: to }] }),
      });
    expect(JSON.parse(stash("r1", "Digital", "Lasting").body)).toMatchObject({ pendingCount: 1 });
    expect(JSON.parse(stash("r2", "Book a call", "Talk to us").body)).toMatchObject({ pendingCount: 2 });
    const undo = handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-discard?token=gsam&ref=r2", body: null });
    expect(JSON.parse(undo.body)).toMatchObject({ remainingCount: 1, entries: [{ ops: [{ ref: "r2" }] }] });
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/manual-edit-stash?pageUrl=x", body: null }).body)).toMatchObject({ count: 1 });

    const apply = handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-commit?async=1", body: null });
    expect(apply.status).toBe(202);
    const event = (await pollLiveDesign(s, 1000)) as { type: string; requestId: string; edits: Array<{ ops: unknown[] }> };
    expect(event).toMatchObject({ type: "edits", edits: [{ ops: [{ ref: "r1", newText: "Lasting" }] }] });
    expect(handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-stash", body: JSON.stringify({ ops: [{ ref: "r3" }] }) }).status).toBe(409);

    const cursor = s.frames.at(-1)?.seq ?? 0;
    replyLiveDesign(s, { requestId: event.requestId, appliedAttachmentId: newAttachment, message: "Changed the headline." });
    expect((await pollLiveDesignFrames(s, cursor, 0)).at(-1)?.data).toMatchObject({ type: "manual_edit_commit_done", appliedCount: 1 });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", attachmentId: newAttachment });
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/manual-edit-stash", body: null }).body)).toMatchObject({ count: 0 });
  });

  it("answers the helper calls the page makes and passes annotations to the agent", async () => {
    const { session: s } = startLiveDesign(ids);
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/status?token=gsam", body: null }).body)).toMatchObject({ agentPolling: false });
    expect(handleImpeccableRequest(s, { method: "GET", path: "/nope", body: null }).status).toBe(404);
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/design-system.json", body: null }).body)).toEqual({ present: false });
    expect(JSON.parse(handleImpeccableRequest(s, { method: "POST", path: "/annotation?eventId=e1", body: null, screenshotAttachmentId: newAttachment }).body)).toMatchObject({ path: newAttachment });
    handleImpeccableRequest(s, post({ type: "generate", id: "e1", freeformPrompt: "Fix this", screenshotPath: newAttachment, comments: [{ x: 1, y: 2, text: "too loud" }], element: { tagName: "h1" } }));
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "generate", request: { notes: ["too loud"], screenshotAttachmentId: newAttachment } });
    replyLiveDesign(s, { requestId: "e1", message: "On it.", designMd: "---\ncolors:\n  lime: \"#c8ff00\"\n---\n# Design\nLime on void." });
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/design-system.json", body: null }).body)).toMatchObject({
      present: true,
      parsed: { frontmatter: { colors: { lime: "#c8ff00" } } },
    });
    expect(handleImpeccableRequest(s, { method: "GET", path: "/design-system/raw", body: null }).body).toContain("Lime on void");
  });

  it("builds Impeccable's variant markup with tune knobs and safe CSS", () => {
    const html = impeccableVariantsHtml("abc", [
      { html: "<a>1</a>", css: ".x{}</style><script>", name: "", params: [{ id: "p", kind: "toggle" }] },
      { html: "<a>2</a>", css: "", name: "" },
    ]);
    expect(html).toContain('<div data-impeccable-variant="original"></div>');
    expect(html).toContain("data-impeccable-params='[{&quot;id&quot;:&quot;p&quot;,&quot;kind&quot;:&quot;toggle&quot;}]'");
    expect(html).toContain('<div data-impeccable-variant="2" style="display: none">');
    expect(html).not.toContain("</style><script>");
  });

  it("puts Impeccable's page scripts in the page behind GSAM's adapter", () => {
    const page = injectImpeccableLive("<html><body><p>Hi</p></body></html>");
    expect(page).toContain("gs-impeccable");
    expect(page).toContain("__IMPECCABLE_VOCAB__");
    expect(page.indexOf("<script>")).toBeLessThan(page.indexOf("</body>"));
  });
});
