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
        // A current editor host (GRE-2357); tests of an older one leave it out.
        editorContract: 1,
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
    const t = setup({ mode: "preview" });
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

  it("sends the media blob when the payload has it, and the same Blob object reaches the frame (GRE-2226)", async () => {
    const t = await ready();
    const blob = new Blob(["png"], { type: "image/png" });
    void t.session.insertMedia({ ...payload, media: { blob, alt: "Boats", width: 1600, height: 900 } });
    const sent = t.sentOf("insert-media")[0]!.message.payload as { media: { blob: Blob } };
    expect(sent).toEqual({ ...payload, media: { blob, alt: "Boats", width: 1600, height: 900 } });
    expect(sent.media.blob).toBe(blob);
  });

  it("refuses a media entry that is not a Blob", async () => {
    const t = await ready();
    const bad = { ...payload, media: { blob: "https://evil.example/a.png", alt: "", width: null, height: null } };
    await expect(t.session.insertMedia(bad as unknown as typeof payload)).resolves.toBeNull();
    expect(t.sentOf("insert-media")).toHaveLength(0);
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

describe("set-motion (GRE-2219)", () => {
  const motionAck = {
    blocks: [
      { type: "Hero", label: "Hero", motion: { effects: ["none", "bg.ascent"], default: { effect: "none", intensity: "off" } } },
      { type: "Prose", label: "Prose" },
    ],
    motionEffects: [{ id: "bg.ascent", label: "Ascent", still: "/motion/ascent-dark.webp", study: "016" }],
  };
  const ready = async (ack: Record<string, unknown> = motionAck) => {
    const t = setup();
    t.session.start();
    t.ack(ack);
    await flush();
    return t;
  };
  const motionId = (t: ReturnType<typeof setup>) => (t.sentOf("set-motion")[0]!.message as unknown as { id: string }).id;
  const payload = { blockId: "h1", motion: { effect: "bg.ascent", intensity: "subtle" as const } };

  it("keeps the engine's motion choices from hello-ack", async () => {
    const t = await ready();
    expect(t.session.motionCapabilities.blocks.get("Hero")).toEqual(motionAck.blocks[0]!.motion);
    expect(t.session.motionCapabilities.blocks.has("Prose")).toBe(false);
    expect(t.session.motionCapabilities.effects).toEqual(motionAck.motionEffects);
  });

  it("an older engine, or a malformed motion list, still connects with no motion choices", async () => {
    const old = await ready({});
    expect(old.session.state.phase).toBe("ready");
    expect(old.session.motionCapabilities.effects).toEqual([]);
    const bad = await ready({ ...motionAck, motionEffects: [{ id: "bg.ascent", label: "Ascent", still: "javascript:alert(1)" }] });
    expect(bad.session.state.phase).toBe("ready");
    expect(bad.session.motionCapabilities.effects).toEqual([]);
    expect(bad.session.motionCapabilities.blocks.has("Hero")).toBe(true);
  });

  it("resolves with the set-motion-result for its own request; an insert-media-result with that id is dropped", async () => {
    const t = await ready();
    const pending = t.session.setMotion(payload);
    expect(t.sentOf("set-motion")[0]!.message.payload).toEqual(payload);
    t.msg("insert-media-result", { requestId: motionId(t), ok: true });
    t.msg("set-motion-result", { requestId: motionId(t), ok: false, code: "effect_not_allowed" });
    await expect(pending).resolves.toEqual({ requestId: motionId(t), ok: false, code: "effect_not_allowed" });
  });

  it("resolves null when the frame does not answer in time, or for an invalid choice", async () => {
    const t = await ready();
    const pending = t.session.setMotion(payload);
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
    await expect(t.session.setMotion({ blockId: "h1", motion: { effect: "bg.ascent", intensity: "extreme" as never } })).resolves.toBeNull();
    expect(t.sentOf("set-motion")).toHaveLength(1);
  });
});

describe("full-screen editor (GRE-2296)", () => {
  const ready = async (overrides: Partial<WebsiteFrameHostOptions<typeof frameWindow>> = {}, ack: Record<string, unknown> = {}) => {
    const t = setup(overrides);
    t.session.start();
    t.ack(ack);
    await flush();
    return t;
  };

  it("sends only the editor commands the engine offered, after the draft is loaded", async () => {
    const t = await ready({}, { editorCommands: ["undo", "redo", "save"] });
    expect([...t.session.editorCommands]).toEqual(["undo", "redo", "save"]);
    expect(t.session.command("undo")).toBe(true);
    expect(t.session.command("add-block")).toBe(false);
    expect(t.sentOf("editor-command").map((entry) => entry.message.payload)).toEqual([{ command: "undo" }]);
  });

  it("an engine that lists no editor commands gets none", async () => {
    const t = await ready();
    expect(t.session.editorCommands.size).toBe(0);
    expect(t.session.command("save")).toBe(false);
    expect(t.sentOf("editor-command")).toHaveLength(0);
  });

  it("refuses an editor host below the editor contract and sends no draft (GRE-2357)", async () => {
    const old = await ready({}, { editorContract: undefined });
    expect(old.session.state).toEqual({ phase: "out-of-date", contract: null });
    expect(old.loadDraft).not.toHaveBeenCalled();
    expect(old.sentOf("load-draft")).toHaveLength(0);
    // Its later messages are dropped: no protocol was agreed.
    const onEditorState = vi.fn();
    const below = await ready({ onEditorState }, { editorContract: 0 });
    // Not a valid contract number, so it counts as none.
    expect(below.session.state).toEqual({ phase: "out-of-date", contract: null });
    below.msg("editor-state", { selection: null, canUndo: true, canRedo: false });
    expect(onEditorState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(below.sentOf("hello")).toHaveLength(1);
  });

  it("a silent editor host is out of date after 10 s; preview keeps no-answer (GRE-2357)", () => {
    const t = setup();
    t.session.start();
    vi.advanceTimersByTime(10_000);
    expect(t.session.state).toEqual({ phase: "out-of-date", contract: null });
  });

  it("opens for website PR #98's engine, which lists editor commands but no contract (GRE-2357)", async () => {
    const t = await ready({}, { editorContract: undefined, editorCommands: ["undo"] });
    expect(t.session.state.phase).toBe("ready");
    expect(t.sentOf("load-draft")).toHaveLength(1);
  });

  it("preview opens an engine with no editor contract", async () => {
    const t = await ready({ mode: "preview" }, { editorContract: undefined });
    expect(t.session.state.phase).toBe("ready");
  });

  it("preview never sends editor commands or takes editor messages", async () => {
    const onEditorState = vi.fn();
    const onEditorKey = vi.fn();
    const t = await ready({ mode: "preview", onEditorState, onEditorKey }, { editorCommands: ["undo"] });
    expect(t.session.command("undo")).toBe(false);
    t.msg("editor-state", { selection: null, canUndo: true, canRedo: false });
    t.msg("editor-key", { key: "escape" });
    expect(onEditorState).not.toHaveBeenCalled();
    expect(onEditorKey).not.toHaveBeenCalled();
  });

  it("passes editor-state, editor-key and media-requested to the host", async () => {
    const onEditorState = vi.fn();
    const onEditorKey = vi.fn();
    const onMediaRequested = vi.fn();
    const t = await ready({ onEditorState, onEditorKey, onMediaRequested });
    const state = { selection: { blockId: "h1", blockType: "Hero", label: "Hero banner" }, canUndo: true, canRedo: false };
    t.msg("editor-state", state);
    t.msg("editor-key", { key: "escape" });
    t.msg("media-requested", { blockId: "h1", field: "image", kind: "image" });
    expect(onEditorState).toHaveBeenCalledWith(state);
    expect(onEditorKey).toHaveBeenCalledWith("escape");
    expect(onMediaRequested).toHaveBeenCalledWith({ blockId: "h1", field: "image", kind: "image" });
  });
});

describe("Edit copy (GRE-2394)", () => {
  const COPY_ACK = { editorContract: 2, editorCommands: ["undo", "redo", "save", "add-block", "outline", "layout", "import-live"] };
  const ready = async (
    overrides: Partial<WebsiteFrameHostOptions<typeof frameWindow>> = {},
    ack: Record<string, unknown> = COPY_ACK,
  ) => {
    const t = setup(overrides);
    t.session.start();
    t.ack(ack);
    await flush();
    return t;
  };
  const save = (t: Awaited<ReturnType<typeof ready>>, data: unknown, requestId = "11111111-1111-4111-8111-111111111111") =>
    t.msg("save", { requestId, pageId: "page-1", baseRevisionId: "rev-1", data });
  const resultOf = (t: Awaited<ReturnType<typeof ready>>) => t.sentOf("save-result").at(-1)?.message.payload;

  it("hello asks for Edit copy by default; preview's hello has no edit mode", () => {
    const editor = setup();
    editor.session.start();
    expect(editor.sentOf("hello")[0]!.message.payload.editMode).toBe("copy");
    const layout = setup({ editMode: "layout" });
    layout.session.start();
    expect(layout.sentOf("hello")[0]!.message.payload.editMode).toBe("layout");
    const preview = setup({ mode: "preview" });
    preview.session.start();
    expect("editMode" in preview.sentOf("hello")[0]!.message.payload).toBe(false);
  });

  it("opens in Edit copy on a contract 2 engine", async () => {
    const t = await ready();
    expect(t.session.hasCopyMode).toBe(true);
    expect(t.session.copyMode).toBe(true);
    expect(t.session.currentEditMode).toBe("copy");
  });

  it("Edit copy refuses add block, outline, media and motion; undo and save still go", async () => {
    const onMediaRequested = vi.fn();
    const t = await ready({ onMediaRequested });
    expect(t.session.command("add-block")).toBe(false);
    expect(t.session.command("outline", true)).toBe(false);
    expect(t.session.command("undo")).toBe(true);
    expect(t.session.command("save")).toBe(true);
    expect(await t.session.insertMedia({ blockId: "h1", field: "image", mediaEntryId: "m1", assetUrl: "/api/assets/a/content", alt: "" })).toBeNull();
    expect(await t.session.setMotion({ blockId: "h1", motion: { effect: "none", intensity: "off" } })).toBeNull();
    t.msg("media-requested", { blockId: "h1", field: "image", kind: "image" });
    expect(onMediaRequested).not.toHaveBeenCalled();
    expect(t.sentOf("editor-command").map((entry) => entry.message.payload.command)).toEqual(["undo", "save"]);
    expect(t.sentOf("insert-media")).toHaveLength(0);
  });

  it("Edit copy saves changed words, and refuses a save that adds, removes or moves blocks", async () => {
    const t = await ready();
    save(t, { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1", title: "New words" } }] });
    await flush();
    expect(resultOf(t)).toMatchObject({ outcome: "saved" });
    expect(t.saveDraft).toHaveBeenCalledTimes(1);

    save(
      t,
      { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1" } }, { type: "Hero", props: { id: "h2" } }] },
      "22222222-2222-4222-8222-222222222222",
    );
    await flush();
    expect(resultOf(t)).toMatchObject({ outcome: "failed", code: "invalid", retryable: false });
    expect(t.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("Layout sends the layout command and lets add block, outline and new blocks through", async () => {
    const t = await ready();
    expect(t.session.setEditMode("layout")).toBe(true);
    expect(t.sentOf("editor-command").at(-1)!.message.payload).toEqual({ command: "layout", on: true });
    expect(t.session.copyMode).toBe(false);
    expect(t.session.command("add-block")).toBe(true);
    expect(t.session.command("outline", true)).toBe(true);
    save(t, { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1" } }, { type: "Hero", props: { id: "h2" } }] });
    await flush();
    expect(resultOf(t)).toMatchObject({ outcome: "saved" });
    // Back to Edit copy.
    expect(t.session.setEditMode("copy")).toBe(true);
    expect(t.sentOf("editor-command").at(-1)!.message.payload).toEqual({ command: "layout", on: false });
    expect(t.session.command("add-block")).toBe(false);
  });

  it("the edit mode commands only go through their own calls", async () => {
    const t = await ready();
    expect(t.session.command("layout", true)).toBe(false);
    expect(t.session.command("import-live")).toBe(false);
  });

  it("an older engine (contract 1) opens as today, in Layout, with no crash", async () => {
    const t = await ready({}, { editorContract: 1, editorCommands: ["undo", "add-block", "outline"], liveContent: { blocks: 3 } });
    expect(t.session.state.phase).toBe("ready");
    expect(t.session.hasCopyMode).toBe(false);
    expect(t.session.copyMode).toBe(false);
    expect(t.session.currentEditMode).toBe("layout");
    expect(t.session.setEditMode("copy")).toBe(false);
    expect(t.session.command("add-block")).toBe(true);
    // Contract 1 cannot import: its live content is not trusted.
    expect(t.session.liveContent).toBeNull();
  });

  it("an empty draft with live content imports it once, and that save may add blocks", async () => {
    const empty = { root: { props: {} }, content: [] };
    const t = await ready(
      {
        loadDraft: vi.fn(async () => ({ revisionId: "rev-1", data: empty, theme: {}, media: {}, site: { name: "Site", settings: {}, navigation: [] } })),
      },
      { ...COPY_ACK, liveContent: { blocks: 1 } },
    );
    expect(t.session.draftEmpty).toBe(true);
    expect(t.session.liveContent).toEqual({ blocks: 1 });
    // Before the import a save that adds blocks is refused in Edit copy.
    save(t, page);
    await flush();
    expect(resultOf(t)).toMatchObject({ outcome: "failed", code: "invalid" });

    expect(t.session.importLive()).toBe(true);
    expect(t.sentOf("editor-command").at(-1)!.message.payload).toEqual({ command: "import-live" });
    save(t, page, "33333333-3333-4333-8333-333333333333");
    await flush();
    expect(resultOf(t)).toMatchObject({ outcome: "saved" });
    expect(t.session.draftEmpty).toBe(false);
    // The draft has content now: no second import.
    expect(t.session.importLive()).toBe(false);
  });

  it("does not import when the live site has nothing or the draft has content", async () => {
    const none = await ready({}, { ...COPY_ACK, liveContent: null });
    expect(none.session.importLive()).toBe(false);
    const built = await ready({}, { ...COPY_ACK, liveContent: { blocks: 2 } });
    expect(built.session.draftEmpty).toBe(false);
    expect(built.session.importLive()).toBe(false);
    expect(built.sentOf("editor-command")).toHaveLength(0);
  });
});
