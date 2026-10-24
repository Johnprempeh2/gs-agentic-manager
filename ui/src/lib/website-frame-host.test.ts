import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebsiteFrameNonce } from "@greatstone/shared";
import {
  WebsiteFrameHostSession,
  type WebsiteFrameConnection,
  type WebsiteFrameHostOptions,
  type WebsiteFrameSaveAnswer,
} from "./website-frame-host";

const ORIGIN = "https://editor.example.com";
const frameWindow = { name: "frame" };
const page = { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1" } }] };

type Sent = { message: { type: string; payload: Record<string, unknown> }; target: string };

function setup(overrides: Partial<WebsiteFrameHostOptions<typeof frameWindow>> = {}) {
  const nonce = createWebsiteFrameNonce();
  const sent: Sent[] = [];
  const connections: WebsiteFrameConnection[] = [];
  const saveDraft = vi.fn(
    async (): Promise<WebsiteFrameSaveAnswer> => ({ outcome: "saved", revisionId: "rev-2", savedAt: "2026-10-23T10:00:00Z" }),
  );
  const loadDraft = vi.fn(async () => ({
    revisionId: "rev-1",
    data: page,
    theme: {},
    media: {},
    site: { name: "Site", settings: {}, navigation: [] },
  }));
  const session = new WebsiteFrameHostSession({
    siteId: "site-1",
    pageId: "page-1",
    mode: "editor",
    editorOrigin: ORIGIN,
    nonce,
    source: frameWindow,
    post: (message, target) => sent.push({ message: message as Sent["message"], target }),
    loadDraft,
    saveDraft,
    onConnection: (connection) => connections.push(connection),
    ...overrides,
  });
  const fromFrame = (data: unknown, extra: { origin?: string; source?: object } = {}) =>
    session.handleMessage({ origin: extra.origin ?? ORIGIN, source: (extra.source ?? frameWindow) as typeof frameWindow, data });
  const ack = (payload: Record<string, unknown> = {}) =>
    fromFrame({
      gs: "website-frame",
      id: "a1",
      type: "hello-ack",
      payload: {
        protocol: 1,
        nonce,
        siteId: "site-1",
        engine: { version: "1.0.0", commit: "b".repeat(40) },
        supportedReleaseSchemas: [1],
        blocks: [{ type: "Hero", label: "Hero" }],
        ...payload,
      },
    });
  const msg = (type: string, payload: unknown) =>
    fromFrame({ gs: "website-frame", protocol: 1, session: nonce, id: `m-${Math.random()}`, type, payload });
  const sentOf = (type: string) => sent.filter((entry) => entry.message.type === type);
  return { session, nonce, sent, sentOf, connections, saveDraft, loadDraft, fromFrame, ack, msg };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("handshake", () => {
  it("sends hello to the exact origin every 250 ms with this load's nonce", () => {
    const t = setup();
    t.session.start();
    vi.advanceTimersByTime(500);
    const hellos = t.sentOf("hello");
    expect(hellos).toHaveLength(3);
    expect(hellos.every((entry) => entry.target === ORIGIN)).toBe(true);
    expect(hellos[0]!.message.payload).toMatchObject({ protocols: [1], siteId: "site-1", nonce: t.nonce, mode: "editor", pageId: "page-1" });
  });

  it("sends no draft before a valid hello-ack, then sends it once (test 2)", async () => {
    const t = setup();
    t.session.start();
    t.ack({ nonce: createWebsiteFrameNonce() });
    t.ack();
    await flush();
    expect(t.loadDraft).toHaveBeenCalledTimes(1);
    const loads = t.sentOf("load-draft");
    expect(loads).toHaveLength(1);
    expect(loads[0]!.target).toBe(ORIGIN);
    expect(loads[0]!.message).toMatchObject({ protocol: 1, session: t.nonce, payload: { revisionId: "rev-1", data: page } });
    vi.advanceTimersByTime(1000);
    expect(t.sentOf("hello")).toHaveLength(1);
  });

  it("drops an ack from a wrong origin or window (test 1)", async () => {
    const t = setup();
    t.session.start();
    t.fromFrame({ gs: "website-frame", id: "x", type: "hello-ack", payload: {} }, { origin: "https://evil.example" });
    t.fromFrame({ gs: "website-frame", id: "x", type: "hello-ack", payload: {} }, { source: {} });
    await flush();
    expect(t.session.state.phase).toBe("connecting");
    expect(t.sentOf("load-draft")).toHaveLength(0);
  });

  it("shows no-answer after 10 s (test 3)", () => {
    const t = setup();
    t.session.start();
    vi.advanceTimersByTime(10_000);
    expect(t.session.state).toEqual({ phase: "no-answer" });
    const count = t.sentOf("hello").length;
    vi.advanceTimersByTime(1000);
    expect(t.sentOf("hello")).toHaveLength(count);
  });

  it("shows a protocol refusal and a site mismatch (test 3, 11)", async () => {
    const refused = setup();
    refused.session.start();
    refused.fromFrame({ gs: "website-frame", id: "r", type: "hello-refused", payload: { nonce: refused.nonce, reason: "protocol", supported: [2] } });
    expect(refused.session.state).toEqual({ phase: "refused-protocol", supported: [2] });

    const otherSite = setup();
    otherSite.session.start();
    otherSite.ack({ siteId: "site-2" });
    await flush();
    expect(otherSite.session.state).toEqual({ phase: "refused-site" });
    expect(otherSite.sentOf("load-draft")).toHaveLength(0);
  });

  it("ignores an ack for a protocol it did not offer", async () => {
    const t = setup();
    t.session.start();
    t.ack({ protocol: 9 });
    await flush();
    expect(t.session.state.phase).toBe("connecting");
    expect(t.loadDraft).not.toHaveBeenCalled();
  });
});

describe("saving (test 7, 12)", () => {
  async function ready(overrides: Partial<WebsiteFrameHostOptions<typeof frameWindow>> = {}) {
    const t = setup(overrides);
    t.session.start();
    t.ack();
    await flush();
    return t;
  }
  const save = (requestId = "req-1", extra: Record<string, unknown> = {}) => ({
    requestId,
    pageId: "page-1",
    baseRevisionId: "rev-1",
    data: page,
    ...extra,
  });

  it("saves through GSAM with the base revision and the session's origin, and answers saved", async () => {
    const t = await ready();
    t.msg("save", save());
    await flush();
    expect(t.saveDraft).toHaveBeenCalledWith({ pageId: "page-1", baseRevisionId: "rev-1", data: page, editorOrigin: ORIGIN });
    expect(t.sentOf("save-result").map((entry) => entry.message.payload)).toEqual([
      { requestId: "req-1", outcome: "saved", revisionId: "rev-2", savedAt: "2026-10-23T10:00:00Z" },
    ]);
  });

  it("a repeated requestId makes one revision and replays the first answer", async () => {
    const t = await ready();
    t.msg("save", save());
    t.msg("save", save());
    await flush();
    t.msg("save", save());
    await flush();
    expect(t.saveDraft).toHaveBeenCalledTimes(1);
    expect(t.sentOf("save-result")).toHaveLength(3);
  });

  it("passes a conflict through with the current data so Take theirs can apply it", async () => {
    const t = await ready({
      saveDraft: vi.fn(async () => ({
        outcome: "conflict" as const,
        currentRevisionId: "rev-9",
        currentData: page,
        currentMedia: {},
        savedBy: "Ada",
        savedAt: "2026-10-23T09:00:00Z",
      })),
    });
    t.msg("save", save());
    await flush();
    expect(t.sentOf("save-result")[0]!.message.payload).toMatchObject({ outcome: "conflict", currentRevisionId: "rev-9", currentData: page });
  });

  it("a network failure is retryable and Retry with the same requestId saves again", async () => {
    const saveDraft = vi
      .fn<() => Promise<WebsiteFrameSaveAnswer>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ outcome: "saved", revisionId: "rev-2", savedAt: "now" });
    const t = await ready({ saveDraft });
    t.msg("save", save());
    await flush();
    expect(t.sentOf("save-result")[0]!.message.payload).toMatchObject({ outcome: "failed", code: "network", retryable: true });
    t.msg("save", save());
    await flush();
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(t.sentOf("save-result")[1]!.message.payload).toMatchObject({ outcome: "saved" });
  });

  it("the host's Retry saves the failed save again with the same requestId, once", async () => {
    const saveDraft = vi
      .fn<() => Promise<WebsiteFrameSaveAnswer>>()
      .mockResolvedValueOnce({ outcome: "failed", code: "network", message: "offline", retryable: true })
      .mockResolvedValueOnce({ outcome: "saved", revisionId: "rev-2", savedAt: "now" });
    const t = await ready({ saveDraft });
    expect(t.session.canRetry).toBe(false);
    t.msg("save", save("req-7"));
    await flush();
    expect(t.session.canRetry).toBe(true);
    await t.session.retry();
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(t.sentOf("save-result").map((entry) => entry.message.payload)).toEqual([
      expect.objectContaining({ requestId: "req-7", outcome: "failed" }),
      expect.objectContaining({ requestId: "req-7", outcome: "saved", revisionId: "rev-2" }),
    ]);
    expect(t.session.canRetry).toBe(false);
    expect(t.session.retry()).toBeNull();
  });

  it("refuses invalid data, another page and a second save in flight", async () => {
    let release: (answer: WebsiteFrameSaveAnswer) => void = () => {};
    const states: unknown[] = [];
    const t = await ready({
      saveDraft: vi.fn(() => new Promise<WebsiteFrameSaveAnswer>((resolve) => (release = resolve))),
      onSaveState: (state) => states.push(state),
    });
    t.msg("save", save("bad", { data: { root: { props: {} }, content: [{ type: "Hero", props: {} }] } }));
    // The host banner says so too, not only the frame.
    expect(states[0]).toMatchObject({ status: "failed", retryable: false, message: expect.stringContaining("no valid id") });
    t.msg("save", save("other", { pageId: "page-2" }));
    t.msg("save", save("unknown-type", { data: { root: { props: {} }, content: [{ type: "Script", props: { id: "x" } }] } }));
    t.msg("save", save("first"));
    t.msg("save", save("second"));
    await flush();
    const results = t.sentOf("save-result").map((entry) => entry.message.payload);
    expect(results).toEqual([
      expect.objectContaining({ requestId: "bad", outcome: "failed", code: "invalid", retryable: false }),
      expect.objectContaining({ requestId: "other", outcome: "failed", code: "invalid", retryable: false }),
      expect.objectContaining({ requestId: "unknown-type", outcome: "failed", code: "invalid", retryable: false }),
      expect.objectContaining({ requestId: "second", outcome: "failed", code: "busy", retryable: true }),
    ]);
    release({ outcome: "saved", revisionId: "rev-2", savedAt: "now" });
    await flush();
    expect(t.sentOf("save-result").at(-1)!.message.payload).toMatchObject({ requestId: "first", outcome: "saved" });
  });
});

describe("block-picked in preview (test 8)", () => {
  async function preview() {
    const picks: unknown[] = [];
    const t = setup({ mode: "preview", onBlockPicked: (pick) => picks.push(pick) });
    t.session.start();
    t.ack();
    await flush();
    return { ...t, picks };
  }
  const ref = (extra: Record<string, unknown> = {}) => ({
    siteId: "site-1",
    pageId: "page-1",
    pageRevisionId: "rev-1",
    blockId: "h1",
    blockType: "Hero",
    engine: { version: "1.0.0", commit: "b".repeat(40) },
    source: { file: "src/blocks/Hero.tsx", line: 4 },
    ...extra,
  });
  const rect = { x: 0, y: 0, width: 10, height: 10 };

  it("passes a known block with its label as data and a clean source hint", async () => {
    const t = await preview();
    t.msg("block-picked", { ref: ref({ source: { file: "/etc/passwd", line: 1 } }), label: "<img onerror=x>", rect });
    expect(t.picks).toEqual([expect.objectContaining({ label: "<img onerror=x>", ref: expect.objectContaining({ blockId: "h1", source: null }) })]);
  });

  it("drops a block-picked from a wrong origin or window, and one before the handshake (GRE-2121)", async () => {
    const early: unknown[] = [];
    const before = setup({ mode: "preview", onBlockPicked: (pick) => early.push(pick) });
    before.session.start();
    before.msg("block-picked", { ref: ref(), label: "x", rect });
    expect(early).toHaveLength(0);

    const t = await preview();
    const message = { gs: "website-frame", protocol: 1, session: t.nonce, id: "p1", type: "block-picked", payload: { ref: ref(), label: "x", rect } };
    t.fromFrame(message, { origin: "https://evil.example.com" });
    t.fromFrame(message, { origin: "https://editor.example.com.evil.test" });
    t.fromFrame(message, { source: { name: "other" } });
    expect(t.picks).toHaveLength(0);
    t.fromFrame(message);
    expect(t.picks).toHaveLength(1);
  });

  it("tells the host when the frame has the draft, so a block can be highlighted", async () => {
    const onDraftLoaded = vi.fn();
    const t = setup({ onDraftLoaded });
    t.session.start();
    t.ack();
    await flush();
    expect(onDraftLoaded).toHaveBeenCalledTimes(1);
    t.session.highlight("h1");
    expect(t.sentOf("highlight").at(-1)!.message.payload).toEqual({ blockId: "h1" });
  });

  it("drops an unknown block, a type mismatch and another revision", async () => {
    const t = await preview();
    t.msg("block-picked", { ref: ref({ blockId: "nope" }), label: "x", rect });
    t.msg("block-picked", { ref: ref({ blockType: "Text" }), label: "x", rect });
    t.msg("block-picked", { ref: ref({ pageRevisionId: "rev-0" }), label: "x", rect });
    expect(t.picks).toHaveLength(0);
  });
});

describe("teardown", () => {
  it("tells the frame to drop the draft and stops listening", async () => {
    const onDirty = vi.fn();
    const t = setup({ onDirty });
    t.session.start();
    t.ack();
    await flush();
    t.session.teardown();
    expect(t.sentOf("teardown")).toHaveLength(1);
    t.msg("dirty", { dirty: true });
    expect(onDirty).not.toHaveBeenCalled();
    expect(t.session.state).toEqual({ phase: "closed" });
  });
});

describe("insert-media (GRE-2206)", () => {
  const payload = { blockId: "h1", field: "image", mediaEntryId: "asset-7", assetUrl: "/api/assets/asset-7/content", alt: "Boats" };
  const ready = async () => {
    const t = setup();
    t.session.start();
    t.ack();
    await flush();
    return t;
  };
  const insertId = (t: ReturnType<typeof setup>) => (t.sentOf("insert-media")[0]!.message as unknown as { id: string }).id;

  it("resolves with the reply whose requestId is the insert-media message id; other replies are dropped", async () => {
    const t = await ready();
    const pending = t.session.insertMedia(payload);
    expect(t.sentOf("insert-media")[0]!.message.payload).toEqual(payload);
    t.msg("insert-media-result", { requestId: "someone-else", ok: true });
    t.msg("insert-media-result", { requestId: insertId(t), ok: false, code: "block_not_found" });
    await expect(pending).resolves.toEqual({ requestId: insertId(t), ok: false, code: "block_not_found" });
  });

  it("resolves null when the frame does not answer in time", async () => {
    const t = await ready();
    const pending = t.session.insertMedia(payload);
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it("sends nothing and resolves null before the handshake, in preview, or for an invalid payload", async () => {
    const before = setup();
    await expect(before.session.insertMedia(payload)).resolves.toBeNull();
    const preview = setup({ mode: "preview" });
    preview.session.start();
    preview.ack();
    await flush();
    await expect(preview.session.insertMedia(payload)).resolves.toBeNull();
    const t = await ready();
    await expect(t.session.insertMedia({ ...payload, assetUrl: "javascript:alert(1)" })).resolves.toBeNull();
    expect([...before.sentOf("insert-media"), ...preview.sentOf("insert-media"), ...t.sentOf("insert-media")]).toHaveLength(0);
  });

  it("teardown resolves an open request with null", async () => {
    const t = await ready();
    const pending = t.session.insertMedia(payload);
    t.session.teardown();
    await expect(pending).resolves.toBeNull();
  });
});
