import { afterEach, describe, expect, it } from "vitest";
import {
  acceptLiveDesign,
  endLiveDesign,
  pollLiveDesign,
  replyLiveDesign,
  requestLiveDesign,
  resetLiveDesignSessions,
  startLiveDesign,
  viewLiveDesign,
} from "../services/live-design.js";

const ids = { companyId: "c1", issueId: "i1", attachmentId: "a1", agentId: "agent1" };
const request = { selector: "a.btn", tag: "a", label: "Button: “Book”", text: "Book", html: "<a class=\"btn\">Book</a>", prompt: "Make it glow" };
const newAttachment = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

describe("live design sessions", () => {
  afterEach(() => resetLiveDesignSessions());

  it("relays a request, the versions, the keep and the save, then ends", async () => {
    const { session: s, needsWake } = startLiveDesign(ids);
    expect(needsWake).toBe(true);

    // The agent is already waiting when John asks.
    const waiting = pollLiveDesign(s, 5000);
    expect(startLiveDesign(ids)).toMatchObject({ session: { id: s.id }, needsWake: false });
    requestLiveDesign(s, request);
    const generate = await waiting;
    expect(generate).toMatchObject({ type: "generate", count: 3, request: { prompt: "Make it glow" } });
    const requestId = (generate as { requestId: string }).requestId;

    expect(replyLiveDesign(s, { requestId: "stale", variants: [{ html: "<a/>", css: "", name: "" }] })).toMatchObject({ ok: false });
    replyLiveDesign(s, { requestId, variants: [{ html: "<a class=\"btn lv-1\">Book</a>", css: ".lv-1{}", name: "Halo" }] });
    expect(viewLiveDesign(s)).toMatchObject({ status: "ready", agentConnected: true });

    acceptLiveDesign(s, requestId, 0);
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "accept", variant: 0, chosen: { name: "Halo" } });
    replyLiveDesign(s, { requestId, appliedAttachmentId: newAttachment });
    expect(viewLiveDesign(s)).toMatchObject({ status: "idle", attachmentId: newAttachment, appliedAttachmentId: newAttachment, variants: [] });

    expect(viewLiveDesign(s).messages.map((m) => m.from)).toEqual(["gsam", "john", "gsam", "gsam", "gsam"]);
    expect(viewLiveDesign(s).messages[1]).toMatchObject({ from: "john", text: "Make it glow" });

    endLiveDesign(s);
    expect(await pollLiveDesign(s, 1000)).toMatchObject({ type: "end" });
    expect(() => requestLiveDesign(s, request)).toThrow(/ended/);
    expect(startLiveDesign(ids).session.id).not.toBe(s.id);
  });
});
