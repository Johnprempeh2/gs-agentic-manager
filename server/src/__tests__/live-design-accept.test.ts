import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_DESIGN_VARIANT_COUNT, LIVE_DESIGN_VIEW_FRAME } from "@greatstone/shared";
import {
  acceptLiveDesignDirect,
  pollLiveDesign,
  replyLiveDesign,
  resetLiveDesignSessions,
  startLiveDesign,
  viewLiveDesign,
  type LivePageSource,
} from "../services/live-design.js";
import { applyVariantToPage } from "../services/live-design-direct.js";
import { acceptOf, handleImpeccableRequest, impeccableLiveScript, oneVersionByDefault } from "../services/impeccable-helper.js";

// GRE-5369: Accept saves the kept version itself, as one new version, and one version is the default.

const PAGE = `<!doctype html><html><head><title>Review</title></head><body>
  <header><h1 class="title">Overnight review</h1></header>
  <section class="summary"><p>Three findings.</p></section>
</body></html>`;
const PICKED = `<h1 class="title">Overnight review</h1>`;
const KEPT = { name: "Calm", html: `<h1 class="lv-calm">Overnight quality review</h1>`, css: ".lv-calm{font-weight:500}" };

describe("applyVariantToPage", () => {
  const target = { selector: "header:nth-of-type(1) > h1:nth-of-type(1)", html: PICKED };

  it("puts the kept version in place of the picked element, CSS just before it, and leaves every other byte alone", () => {
    const result = applyVariantToPage(PAGE, target, KEPT);
    if ("failed" in result) throw new Error(result.failed);
    expect(result.html).toBe(PAGE.replace(PICKED, `<style data-gs-live="Calm">${KEPT.css}</style>${KEPT.html}`));
  });

  it("finds the element although the frame marked it up and a page script changed its classes", () => {
    const marked = `<h1 class="title is-visible impeccable-picked" data-impeccable-outline="1">Overnight review</h1>`;
    const result = applyVariantToPage(PAGE, { ...target, html: marked }, KEPT);
    expect("failed" in result ? result.failed : result.html).toContain(KEPT.html);
  });

  it("adds after the element for Insert, and the element stays", () => {
    const result = applyVariantToPage(PAGE, { ...target, insert: { position: "after" } }, { html: "<p>New line</p>" });
    if ("failed" in result) throw new Error(result.failed);
    expect(result.html).toContain(`${PICKED}<p>New line</p>`);
  });

  it("fails, for the agent to do instead, when the element is not in the saved page", () => {
    const result = applyVariantToPage(PAGE, { selector: "main > h2", html: "<h2>Gone</h2>" }, KEPT);
    expect(result).toEqual({ failed: "the element was not found in the saved page" });
  });

  it("does not guess between twins with the same words and no path", () => {
    const twins = PAGE.replace("</body>", "<p>Three findings.</p></body>");
    expect(applyVariantToPage(twins, { selector: "nope", html: "<p>Three findings.</p>" }, KEPT)).toHaveProperty("failed");
  });
});

describe("Accept saves without the agent", () => {
  afterEach(() => resetLiveDesignSessions());

  function openWithVersions(save: LivePageSource["save"]) {
    let page = PAGE;
    const saves: string[] = [];
    const source: LivePageSource = {
      kind: "attachment",
      label: "review.html",
      frameSrc: (id) => `/f/${id}`,
      read: async () => page,
      save: async (html, agentId, userId) => {
        const id = await save(html, agentId, userId);
        saves.push(html);
        page = html;
        return id;
      },
      version: async () => 4,
    };
    const { session } = startLiveDesign({ companyId: "c1", issueId: "i1", attachmentId: "a3", agentId: "agent1", source });
    handleImpeccableRequest(session, {
      method: "POST",
      path: "/events",
      body: JSON.stringify({ type: "generate", id: "req1", element: { tagName: "h1", outerHTML: PICKED, textContent: "Overnight review" }, freeformPrompt: "Calmer" }),
      extra: { selector: "header:nth-of-type(1) > h1:nth-of-type(1)" },
    });
    expect(replyLiveDesign(session, { requestId: "req1", variants: [KEPT] } as never)).toEqual({ ok: true });
    return { session, saves };
  }

  it("asks the agent for one version by default", async () => {
    expect(LIVE_DESIGN_VARIANT_COUNT).toBe(1);
    const { session } = startLiveDesign({ companyId: "c1", issueId: "i2", attachmentId: "a1", agentId: "agent1" });
    handleImpeccableRequest(session, {
      method: "POST",
      path: "/events",
      body: JSON.stringify({ type: "generate", id: "r1", element: { tagName: "h1", outerHTML: PICKED }, freeformPrompt: "Calmer" }),
    });
    const event = (await pollLiveDesign(session, 1000)) as { count: number; _instructions: string };
    expect(event.count).toBe(1);
    expect(event._instructions).toContain("Make ONE version of that element");
  });

  it("saves exactly one new version at once, frees the page, and tells the agent the page moved on", async () => {
    const { session, saves } = openWithVersions(async () => "a4");
    const result = await acceptLiveDesignDirect(session, "req1", 0, null, "john");
    expect(result).toMatchObject({ saved: true, attachmentId: "a4", version: 4 });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain(KEPT.html);
    expect(viewLiveDesign(session)).toMatchObject({ attachmentId: "a4", appliedAttachmentId: "a4", variants: [], request: null });
    expect(["idle", "waiting_agent"]).toContain(viewLiveDesign(session).status);
    expect(session.messages.at(-1)?.text).toBe("Kept version 1 (Calm). Saved as version 4.");
    expect(session.frames.some((f) => f.data.type === "agent_done" && f.data.id === "req1")).toBe(true);
    // The chat asks the editor to read the session again, instead of waiting for its next poll.
    expect(session.frames.at(-2)?.data.type).toBe(LIVE_DESIGN_VIEW_FRAME);
    // No agent was polling: the request it never took is dropped, and it hears only that the page moved on.
    expect(await pollLiveDesign(session, 1000)).toMatchObject({ type: "restored", attachmentId: "a4" });
  });

  it("keeps the versions open and says why when the save fails: never a silent ready", async () => {
    const { session, saves } = openWithVersions(async () => {
      throw new Error("disk full");
    });
    const result = await acceptLiveDesignDirect(session, "req1", 0, null, "john");
    expect(result).toMatchObject({ saved: false, reason: "the page could not be saved" });
    expect(saves).toHaveLength(0);
    expect(viewLiveDesign(session)).toMatchObject({ status: "ready", attachmentId: "a3" });
    expect(session.messages.at(-1)?.text).toContain("Not saved: the page could not be saved.");
  });

  it("leaves a version with tune knobs to the agent, which bakes them in", async () => {
    const { session } = openWithVersions(async () => "a4");
    session.variants = [{ ...KEPT, params: [{ id: "weight", kind: "range" }] }];
    expect(await acceptLiveDesignDirect(session, "req1", 0, null, "john")).toBeNull();
    expect(viewLiveDesign(session).status).toBe("ready");
  });

  it("refuses an accept for versions that are no longer open", async () => {
    const { session } = openWithVersions(async () => "a4");
    await expect(acceptLiveDesignDirect(session, "other", 0, null, "john")).rejects.toThrow("no longer open");
  });
});

describe("Impeccable's page script", () => {
  it("starts at one version; the count control still offers more", () => {
    expect(impeccableLiveScript()).toContain("let selectedCount = 1;");
    expect(impeccableLiveScript()).not.toContain("let selectedCount = 3;");
    expect(() => oneVersionByDefault("let selectedCount = 2;")).toThrow("default version count moved");
  });

  it("reads Accept from the page's event body", () => {
    expect(acceptOf(JSON.stringify({ type: "accept", id: "req1", variantId: "2" }))).toEqual({ id: "req1", variant: 1, paramValues: null });
    expect(acceptOf(JSON.stringify({ type: "generate", id: "req1" }))).toBeNull();
    expect(acceptOf("not json")).toBeNull();
  });
});

vi.setConfig({ testTimeout: 20_000 });
