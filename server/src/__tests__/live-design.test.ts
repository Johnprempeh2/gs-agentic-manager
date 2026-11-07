import { afterEach, describe, expect, it } from "vitest";
import {
  acceptLiveDesign,
  discardLiveDesign,
  steerLiveDesign,
  endLiveDesign,
  getLiveDesign,
  liveDesignAcceptsPage,
  recordLiveDesignMarkup,
  restoreLiveDesign,
  setLiveDesignDeliverable,
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

  it("keeps the page's chat when the editor is closed and opened again", () => {
    const { session: first } = startLiveDesign(ids);
    steerLiveDesign(first, "make the logos a carousel");
    endLiveDesign(first);
    const { session: again } = startLiveDesign(ids);
    expect(again.id).not.toBe(first.id);
    expect(viewLiveDesign(again).messages.map((m) => m.text)).toContain("make the logos a carousel");
  });

  it("keeps a note John sent about versions he then discards: it reaches the agent as a page request", async () => {
    const { session: s } = startLiveDesign(ids);
    handleImpeccableRequest(s, post({ type: "generate", id: "imp22222", action: "impeccable", freeformPrompt: "Fix the logos", count: 3,
      element: { tagName: "ul", textContent: "", outerHTML: "<ul></ul>", anchor: "ul" } }, "ul"));
    expect(await pollLiveDesign(s, 0)).toMatchObject({ type: "generate", requestId: "imp22222" });
    replyLiveDesign(s, { requestId: "imp22222", variants: [{ html: "<ul></ul>", css: "", name: "A", params: [] }] });

    steerLiveDesign(s, "we need to see the colour of the logos");
    discardLiveDesign(s);
    const events = [await pollLiveDesign(s, 0), await pollLiveDesign(s, 0), await pollLiveDesign(s, 0)];
    expect(events.map((e) => e?.type)).toEqual(["steer", "discard", "steer"]);
    expect(events[2]).toMatchObject({ requestId: null, message: "we need to see the colour of the logos" });
  });

  it("does not resend a note the agent already answered with versions", async () => {
    const { session: s } = startLiveDesign(ids);
    handleImpeccableRequest(s, post({ type: "generate", id: "imp33333", action: "impeccable", freeformPrompt: "Calmer", count: 2,
      element: { tagName: "a", textContent: "", outerHTML: "<a></a>", anchor: "a" } }, "a"));
    await pollLiveDesign(s, 0);
    replyLiveDesign(s, { requestId: "imp33333", variants: [{ html: "<a></a>", css: "", name: "A", params: [] }] });
    steerLiveDesign(s, "calmer still");
    await pollLiveDesign(s, 0);
    replyLiveDesign(s, { requestId: "imp33333", variants: [{ html: "<a></a>", css: "", name: "B", params: [] }] });
    discardLiveDesign(s);
    expect(await pollLiveDesign(s, 0)).toMatchObject({ type: "discard" });
    expect(await pollLiveDesign(s, 0)).toMatchObject({ type: "timeout" });
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
    // Only the screenshot GSAM saved for this Go reaches the agent, not an id the page sends.
    recordLiveDesignMarkup(s, "e1", newAttachment);
    handleImpeccableRequest(s, post({ type: "generate", id: "e1", freeformPrompt: "Fix this", screenshotPath: "6f9619ff-0000-4d01-b42d-00cf4fc964ff", comments: [{ x: 1, y: 2, text: "too loud" }], element: { tagName: "h1" } }));
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

  it("keeps a session open while another editor has it, and ignores replies after it ends", async () => {
    const { session: s } = startLiveDesign(ids);
    startLiveDesign(ids); // the phone joins the laptop's session
    endLiveDesign(s);
    expect(viewLiveDesign(s).status).not.toBe("ended");
    endLiveDesign(s);
    expect(viewLiveDesign(s).status).toBe("ended");
    expect(replyLiveDesign(s, { requestId: "x", error: "late" })).toMatchObject({ ok: false, reason: "ended" });
    expect(viewLiveDesign(s).status).toBe("ended");
  });

  it("refuses to apply edits while versions are open, and keeps an event whose poll went away", async () => {
    const { session: s } = startLiveDesign(ids);
    // The agent's poll has gone (run cancelled) when the Go arrives: the Go waits for its next poll.
    const lost = pollLiveDesign(s, 5000, () => true);
    handleImpeccableRequest(s, post({ type: "generate", id: "g1", freeformPrompt: "Glow", element: { tagName: "a" } }));
    expect(await lost).toMatchObject({ type: "timeout" });
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "generate", requestId: "g1" });

    replyLiveDesign(s, { requestId: "g1", variants: [{ html: "<a>1</a>", css: "", name: "" }] });
    handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-stash", body: JSON.stringify({ ops: [{ ref: "r1", originalText: "a", newText: "b" }] }) });
    expect(handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-commit", body: null }).status).toBe(409);
    expect(() => acceptLiveDesign(s, "g1", 0)).not.toThrow();
  });

  it("gives a Go with no id a usable request id", async () => {
    const { session: s } = startLiveDesign(ids);
    handleImpeccableRequest(s, post({ type: "generate", freeformPrompt: "Glow", element: { tagName: "a" } }));
    const event = (await pollLiveDesign(s, 1000)) as { requestId: string };
    expect(event.requestId.length).toBeGreaterThan(0);
  });

  it("restores an earlier version as the page and tells the agent, but not mid-request", async () => {
    const { session: s } = startLiveDesign(ids);
    setLiveDesignDeliverable(s, "d-v3");
    expect(viewLiveDesign(s).deliverableId).toBe("d-v3");
    restoreLiveDesign(s, newAttachment, 1);
    expect(viewLiveDesign(s)).toMatchObject({ attachmentId: newAttachment, appliedAttachmentId: newAttachment });
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "restored", attachmentId: newAttachment, version: 1 });

    handleImpeccableRequest(s, post({ type: "generate", id: "g2", freeformPrompt: "Glow", element: { tagName: "a" } }));
    expect(() => restoreLiveDesign(s, newAttachment, 1)).toThrow(/Keep or discard/);
  });

  it("frees a request when the agent goes quiet, and tells John to press Go again", async () => {
    const { session: s } = startLiveDesign(ids);
    await pollLiveDesign(s, 1000); // the agent joins
    handleImpeccableRequest(s, post({ type: "generate", id: "q1", freeformPrompt: "Glow", element: { tagName: "a" } }));
    s.agentSeenAt = Date.now() - 9 * 60_000; // then stops polling
    getLiveDesign(s.id);
    expect(viewLiveDesign(s)).toMatchObject({ status: "waiting_agent", request: null });
    expect(viewLiveDesign(s).messages.at(-1)?.text).toMatch(/stopped responding/);
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "error", id: "q1" });
  });

  it("frees the page when the agent says it will not make versions for a pick", async () => {
    const { session: s } = startLiveDesign(ids);
    await pollLiveDesign(s, 1000);
    handleImpeccableRequest(s, post({ type: "generate", id: "m1", freeformPrompt: "Make it a carousel", element: { tagName: "section" } }));
    expect(replyLiveDesign(s, { requestId: "m1", error: "That grid is site code; I'm doing it as a code change." })).toEqual({ ok: true });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle" });
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "error", id: "m1" });
    // John can pick the next thing straight away.
    handleImpeccableRequest(s, post({ type: "generate", id: "m2", freeformPrompt: "Bigger heading", element: { tagName: "h2" } }));
    expect(viewLiveDesign(s)).toMatchObject({ status: "generating" });
  });

  it("takes a pick as a code change: frees the page, lists the task, queues the next request", async () => {
    const { session: s } = startLiveDesign(ids);
    await pollLiveDesign(s, 1000);
    handleImpeccableRequest(s, post({ type: "generate", id: "c1", freeformPrompt: "Make it a carousel", element: { tagName: "ul" } }));
    await pollLiveDesign(s, 1000); // the agent takes the pick
    const task = { identifier: "GRE-1", title: "Logo carousel", status: "working" as const };
    expect(replyLiveDesign(s, { requestId: "c1", message: "Building it in the site code.", codeTask: task })).toEqual({ ok: true });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", request: null, codeTasks: [task] });
    expect(s.frames.at(-1)?.data).toMatchObject({ type: "error", id: "c1" });
    // While the agent builds, John asks for more; it waits in order.
    handleImpeccableRequest(s, post({ type: "generate", id: "c2", freeformPrompt: "Bigger heading", element: { tagName: "h2" } }));
    expect(viewLiveDesign(s).queued).toEqual(["h2: Bigger heading"]);
    // Progress updates replace the task, and survive the editor being opened again.
    replyLiveDesign(s, { requestId: "page", codeTask: { ...task, status: "preview", previewUrl: "https://deploy-preview-9--greatstone-home.netlify.app" } });
    expect(viewLiveDesign(s).codeTasks).toEqual([expect.objectContaining({ identifier: "GRE-1", status: "preview" })]);
    endLiveDesign(s);
    expect(viewLiveDesign(startLiveDesign(ids).session).codeTasks).toHaveLength(1);
  });

  it("handles Impeccable's Insert: a new element next to an anchor, nothing replaced", async () => {
    const { session: s } = startLiveDesign(ids);
    handleImpeccableRequest(s, {
      ...post({ type: "generate", id: "i1", mode: "insert", freeformPrompt: "Add a testimonial", count: 2, insert: { position: "after", anchor: { tagName: "section", textContent: "Pricing", outerHTML: "<section>Pricing</section>" } } }, "main > section:nth-of-type(2)"),
      extra: { selector: "main > section:nth-of-type(2)", position: "after" },
    });
    const event = await pollLiveDesign(s, 1000);
    expect(event).toMatchObject({ type: "generate", request: { insert: { position: "after" }, selector: "main > section:nth-of-type(2)" } });
    expect(String((event as { _instructions: string })._instructions)).toMatch(/NEW element to place after/);
    replyLiveDesign(s, { requestId: "i1", variants: [{ html: "<section>Quote</section>", css: "", name: "" }] });
    const html = String(s.frames.at(-1)?.data.gsVariantsHtml);
    expect(html).toContain('data-impeccable-mode="insert"');
    expect(html).not.toContain('data-impeccable-variant="original"');
  });

  it("only takes a page that is still wanted, and no whole-page change under open versions", async () => {
    const { session: s } = startLiveDesign(ids);
    expect(liveDesignAcceptsPage(s, "page")).toBe(true);
    handleImpeccableRequest(s, post({ type: "generate", id: "w1", freeformPrompt: "Glow", element: { tagName: "a" } }));
    replyLiveDesign(s, { requestId: "w1", variants: [{ html: "<a>1</a>", css: "", name: "" }] });
    expect(liveDesignAcceptsPage(s, "page")).toBe(false);
    expect(liveDesignAcceptsPage(s, "w1")).toBe(false); // versions open, nothing accepted yet
    expect(replyLiveDesign(s, { requestId: "page", appliedAttachmentId: newAttachment })).toMatchObject({ ok: false, reason: "busy" });
    acceptLiveDesign(s, "w1", 0);
    expect(liveDesignAcceptsPage(s, "w1")).toBe(true);
    expect(liveDesignAcceptsPage(s, "old")).toBe(false);
  });

  it("a comment on one version brings back a revised set the page swaps in", async () => {
    const { session: s } = startLiveDesign(ids);
    void pollLiveDesign(s, 10);
    handleImpeccableRequest(s, post({ type: "generate", id: "imp77", action: "impeccable", freeformPrompt: "Logo carousel", count: 2,
      element: { tagName: "section", textContent: "", outerHTML: "<section></section>", anchor: "section" } }, "section"));
    replyLiveDesign(s, { requestId: "imp77", variants: [{ html: "<div>a</div>", css: "", name: "Paged" }, { html: "<div>b</div>", css: "", name: "Ticker" }] });
    steerLiveDesign(s, 'About version 2 ("Ticker"): slower');
    const cursor = s.frames.length;
    expect(replyLiveDesign(s, { requestId: "imp77", variants: [{ html: "<div>a</div>", css: "", name: "Paged" }, { html: "<div>slow</div>", css: "", name: "Ticker" }] })).toEqual({ ok: true });
    expect(s.status).toBe("ready");
    expect(s.variants[1].html).toBe("<div>slow</div>");
    expect(s.frames.slice(cursor).some((f) => f.data.type === "done" && String(f.data.gsVariantsHtml).includes("slow"))).toBe(true);
  });
});
