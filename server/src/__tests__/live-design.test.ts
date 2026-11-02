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

  it("answers the helper calls the page makes and refuses edits GSAM does not support", () => {
    const { session: s } = startLiveDesign(ids);
    expect(JSON.parse(handleImpeccableRequest(s, { method: "GET", path: "/status?token=gsam", body: null }).body)).toMatchObject({ agentPolling: false });
    expect(handleImpeccableRequest(s, { method: "POST", path: "/manual-edit-commit", body: "{}" }).status).toBe(501);
    expect(handleImpeccableRequest(s, { method: "GET", path: "/nope", body: null }).status).toBe(404);
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
