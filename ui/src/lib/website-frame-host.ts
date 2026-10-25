import {
  WEBSITE_FRAME_CAPTURE_TIMEOUT_MS,
  WEBSITE_FRAME_HELLO_INTERVAL_MS,
  WEBSITE_FRAME_HELLO_TIMEOUT_MS,
  WEBSITE_FRAME_INSERT_MEDIA_TIMEOUT_MS,
  WEBSITE_FRAME_PROTOCOLS,
  WEBSITE_FRAME_SET_MOTION_TIMEOUT_MS,
  inspectWebsitePuckData,
  isWebsiteEditorContractCurrent,
  receiveWebsiteFrameMessage,
  sanitizeWebsiteFrameSourceHint,
  isWebsiteEditorCommand,
  websiteEditorContractOf,
  websiteEditorHasCopyMode,
  websiteFrameCommentPinsSchema,
  websiteFrameHelloMessage,
  websiteFrameInsertMediaSchema,
  websiteFrameMessage,
  websiteFrameSetMotionSchema,
  type WebsiteEditMode,
  type WebsiteEditorCommand,
  type WebsiteFrameAskAgent,
  type WebsiteFrameBlockPicked,
  type WebsiteFrameCaptureResult,
  type WebsiteFrameCommentMessage,
  type WebsiteFrameCommentPins,
  type WebsiteFrameEditorState,
  type WebsiteFrameHelloAck,
  type WebsiteFrameHostMessageType,
  type WebsiteFrameInsertMedia,
  type WebsiteFrameInsertMediaResult,
  type WebsiteFrameMediaRequested,
  type WebsiteFrameMode,
  type WebsiteFramePinClicked,
  type WebsiteFrameSave,
  type WebsiteFrameSaveResult,
  type WebsiteFrameSetMotion,
  type WebsiteFrameSetMotionResult,
  type WebsiteMotionChoice,
  type WebsiteMotionEffect,
  type WebsiteBackgroundSurface,
  type WebsitePuckBlockInfo,
} from "@greatstone/shared";

// Host side of the website editor frame contract (GRE-1916, protocol 1).
// One session is one iframe load: it owns the nonce, sends `hello` until the
// frame answers, sends the draft only after a valid `hello-ack`, and turns the
// frame's `save` messages into saves through GSAM's API. It holds no React
// state so the contract tests can drive it directly.

export type WebsiteFrameConnection =
  | { phase: "connecting" }
  | { phase: "ready"; protocol: number; engine: WebsiteFrameHelloAck["engine"] }
  | { phase: "no-answer" }
  /**
   * Editor only (GRE-2357): the editor host is older than `WEBSITE_EDITOR_CONTRACT`
   * or did not answer. `contract` is what it said, null when it said nothing.
   * No draft is sent; the host shows "Editor host is out of date", not the frame.
   */
  | { phase: "out-of-date"; contract: number | null }
  | { phase: "refused-protocol"; supported: number[] }
  | { phase: "refused-site" }
  | { phase: "closed" };

/** What the user sees about saving, mirrored from the frame's own banner. */
export type WebsiteFrameSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; revisionId: string; savedAt: string }
  | { status: "conflict"; currentRevisionId: string; savedBy: string; savedAt: string }
  | { status: "failed"; message: string; retryable: boolean };

export interface WebsiteFrameDraft {
  revisionId: string;
  data: unknown;
  theme: unknown;
  media: Record<string, { blob: Blob; alt: string; width: number | null; height: number | null }>;
  site: { name: string; settings: unknown; navigation: unknown };
}

/** The save the host makes through GSAM's API. The server checks permission again. */
export interface WebsiteFrameSaveRequest {
  pageId: string;
  baseRevisionId: string;
  data: unknown;
  /** The editor origin this session was opened with (rule C2.4). */
  editorOrigin: string;
}

export type WebsiteFrameSaveAnswer =
  | { outcome: "saved"; revisionId: string; savedAt: string }
  | {
      outcome: "conflict";
      currentRevisionId: string;
      currentData: unknown;
      currentMedia: Record<string, unknown>;
      savedBy: string;
      savedAt: string;
    }
  | { outcome: "failed"; code: string; message: string; retryable: boolean };

export interface WebsiteFrameBlockPick {
  ref: WebsiteFrameBlockPicked["ref"] & { source: { file: string; line: number } | null };
  label: string;
  rect: WebsiteFrameBlockPicked["rect"];
}

export interface WebsiteFrameHostOptions<Source> {
  siteId: string;
  pageId: string;
  mode: WebsiteFrameMode;
  /**
   * Editor only (GRE-2394): open in Edit copy or Layout. An engine without Edit
   * copy opens in Layout whatever this says. Default `copy`.
   */
  editMode?: WebsiteEditMode;
  editorOrigin: string;
  nonce: string;
  /** The iframe's `contentWindow`. Messages from any other window are dropped. */
  source: Source;
  post: (message: unknown, targetOrigin: string) => void;
  loadDraft: () => Promise<WebsiteFrameDraft>;
  saveDraft: (request: WebsiteFrameSaveRequest) => Promise<WebsiteFrameSaveAnswer>;
  onConnection?: (connection: WebsiteFrameConnection) => void;
  onSaveState?: (state: WebsiteFrameSaveState) => void;
  onDirty?: (dirty: boolean) => void;
  onBlockPicked?: (pick: WebsiteFrameBlockPick) => void;
  /** The frame has the draft (after `load-draft`), so `highlight` can reach a block. */
  onDraftLoaded?: () => void;
  onFrameError?: (error: { code: string; message: string }) => void;
  /** Editor (GRE-2296): the selected block, the editor's undo and redo, and the outline. */
  onEditorState?: (state: WebsiteFrameEditorState) => void;
  /** Editor: Esc in the frame with nothing selected. */
  onEditorKey?: (key: "escape") => void;
  /** Editor: the person clicked an image in the page to replace it. */
  onMediaRequested?: (request: WebsiteFrameMediaRequested) => void;
  /** Editor (GRE-2361): the person clicked a comment pin GSAM sent. */
  onPinClicked?: (pin: WebsiteFramePinClicked) => void;
  /** Editor (GRE-2361): Ask an agent from the frame's block toolbar, about a block of the open draft. */
  onAskAgent?: (ask: WebsiteFrameAskAgent) => void;
  /** Drop reasons, for the console. Never shown as HTML. */
  onDrop?: (reason: string) => void;
  createId?: () => string;
}

/** What the engine said about motion in its `hello-ack` (GRE-2232). Empty for an older engine. */
export interface WebsiteFrameMotionCapabilities {
  /** Block type to the effects it takes and what a new block starts with. */
  blocks: Map<string, { effects: string[]; default: WebsiteMotionChoice }>;
  effects: WebsiteMotionEffect[];
  /** GRE-2522: the plain site surfaces a block's Background takes. Empty for an older engine. */
  surfaces?: WebsiteBackgroundSurface[];
}

type ReplyType = "insert-media-result" | "set-motion-result" | "capture-result";
type RequestType = "insert-media" | "set-motion" | "capture";

/** Commands Edit copy never sends: they add blocks or open the block outline. */
const COPY_MODE_REFUSED = new Set<WebsiteEditorCommand>(["add-block", "outline"]);

/** The same block ids, in the same order, with the same types. */
function sameBlocks(before: Map<string, WebsitePuckBlockInfo>, after: Map<string, WebsitePuckBlockInfo>) {
  if (before.size !== after.size) return false;
  const a = [...before.values()];
  const b = [...after.values()];
  return a.every((block, index) => block.id === b[index]!.id && block.type === b[index]!.type);
}

/** Brand text colour and highlight classes, e.g. `gs-rt-c-accent` or `gs-rt-bg-teal`. */
const TEXT_COLOUR_CLASS = /\bgs-rt-(?:c|bg)-[a-z0-9-]+/g;

function textColourCounts(data: unknown) {
  const counts = new Map<string, number>();
  for (const name of JSON.stringify(data ?? null).match(TEXT_COLOUR_CLASS) ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/** True when `after` colours more words than `before`. Deleting a coloured word is a wording change. */
export function addsTextColour(before: unknown, after: unknown) {
  const was = textColourCounts(before);
  return [...textColourCounts(after)].some(([name, count]) => count > (was.get(name) ?? 0));
}

let fallbackId = 0;
function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${++fallbackId}`;
}

export class WebsiteFrameHostSession<Source> {
  private readonly options: WebsiteFrameHostOptions<Source>;
  private readonly createId: () => string;
  private protocol: number | null = null;
  private connection: WebsiteFrameConnection = { phase: "connecting" };
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private helloDeadline: ReturnType<typeof setTimeout> | null = null;
  private engineTypes: Set<string> | null = null;
  private shownBlocks = new Map<string, WebsitePuckBlockInfo>();
  private shownRevisionId: string | null = null;
  private shownData: unknown = null;
  private motion: WebsiteFrameMotionCapabilities = { blocks: new Map(), effects: [], surfaces: [] };
  private commands = new Set<WebsiteEditorCommand>();
  private copySupported = false;
  private editMode: WebsiteEditMode;
  private live: { blocks: number } | null = null;
  /** The comment messages the engine listed in `hello-ack` (GRE-2361). */
  private commentMessages = new Set<WebsiteFrameCommentMessage>();
  /** The open comments' pins GSAM wants shown, and the ones last sent (as JSON), so a repeat sends nothing. */
  private pins: WebsiteFrameCommentPins["pins"] | null = null;
  private sentPins: { key: string; pins: WebsiteFrameCommentPins["pins"] } | null = null;
  /** `import-live` was sent to an empty draft: its save may add blocks in Edit copy. */
  private importing = false;
  /** `insert-media` and `set-motion` requests waiting for their result, by message id. */
  private replies = new Map<string, { type: ReplyType; resolve: (result: never) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Saves by `pageId:requestId`. Scoped to this session (one nonce). */
  private saves = new Map<string, Promise<WebsiteFrameSaveResult>>();
  private inFlight: string | null = null;
  /** The last save that failed with a retryable answer, for the host's own Retry button. */
  private retryable: WebsiteFrameSave | null = null;

  constructor(options: WebsiteFrameHostOptions<Source>) {
    this.options = options;
    this.createId = options.createId ?? defaultCreateId;
    this.editMode = options.editMode ?? "copy";
  }

  get state(): WebsiteFrameConnection {
    return this.connection;
  }

  /** Call on the iframe `load` event. Sends `hello` every 250 ms for up to 10 s. */
  start() {
    if (this.connection.phase !== "connecting" || this.helloTimer) return;
    const hello = websiteFrameHelloMessage({
      id: this.createId(),
      siteId: this.options.siteId,
      nonce: this.options.nonce,
      mode: this.options.mode,
      pageId: this.options.pageId,
      ...(this.options.mode === "editor" ? { editMode: this.editMode } : {}),
    });
    const send = () => this.options.post(hello, this.options.editorOrigin);
    send();
    this.helloTimer = setInterval(send, WEBSITE_FRAME_HELLO_INTERVAL_MS);
    this.helloDeadline = setTimeout(() => {
      this.stopHello();
      if (this.connection.phase !== "connecting") return;
      // A silent editor host is treated as one too old for the full-screen editor.
      this.setConnection(this.options.mode === "editor" ? { phase: "out-of-date", contract: null } : { phase: "no-answer" });
    }, WEBSITE_FRAME_HELLO_TIMEOUT_MS);
  }

  /** Pass every `message` event from `window`. */
  handleMessage(event: { origin: string; source: Source | null; data: unknown }) {
    if (this.connection.phase === "closed") return;
    const received = receiveWebsiteFrameMessage(event, {
      origin: this.options.editorOrigin,
      source: this.options.source,
      nonce: this.options.nonce,
      protocol: this.protocol,
    });
    if (!received.ok) {
      this.drop(received.reason);
      return;
    }
    const message = received.message;
    switch (message.type) {
      case "hello-ack":
        void this.acceptHello(message.payload);
        return;
      case "hello-refused":
        if (this.connection.phase !== "connecting") return this.drop("refusal when not connecting");
        this.stopHello();
        this.setConnection(
          message.payload.reason === "protocol"
            ? { phase: "refused-protocol", supported: message.payload.supported }
            : { phase: "refused-site" },
        );
        return;
      case "dirty":
        this.options.onDirty?.(message.payload.dirty);
        return;
      case "save":
        void this.save(message.payload);
        return;
      case "block-picked":
        this.blockPicked(message.payload);
        return;
      case "error":
        this.options.onFrameError?.(message.payload);
        return;
      case "insert-media-result":
      case "set-motion-result":
        this.reply(message.type, message.payload);
        return;
      case "editor-state":
        if (this.options.mode !== "editor") return this.drop("editor-state outside the editor");
        this.options.onEditorState?.(message.payload);
        return;
      case "editor-key":
        if (this.options.mode !== "editor") return this.drop("editor-key outside the editor");
        this.options.onEditorKey?.(message.payload.key);
        return;
      case "media-requested":
        if (this.options.mode !== "editor") return this.drop("media-requested outside the editor");
        if (this.copyMode) return this.drop("media-requested in Edit copy");
        this.options.onMediaRequested?.(message.payload);
        return;
      case "pin-clicked":
        this.pinClicked(message.payload);
        return;
      case "ask-agent":
        this.askAgent(message.payload);
        return;
      case "capture-result":
        if (!this.commentMessages.has("capture")) return this.drop("capture-result from an engine that did not list capture");
        this.reply(message.type, message.payload);
        return;
    }
  }

  /** True when the last save failed and may be tried again. */
  get canRetry(): boolean {
    return this.retryable !== null && this.inFlight === null && this.connection.phase === "ready";
  }

  /**
   * The host banner's Retry: the failed save again, with the same requestId,
   * so it makes at most one revision. The frame gets the `save-result`.
   */
  retry(): Promise<WebsiteFrameSaveResult> | null {
    if (!this.canRetry || !this.retryable) return null;
    return this.save(this.retryable);
  }

  /** Preview: highlight the block the user picked, or clear it. */
  highlight(blockId: string | null) {
    this.send("highlight", { blockId });
  }

  /** The page data the frame was last given or last saved, for the host's own lookups. */
  get shownPageData(): unknown {
    return this.shownData;
  }

  /**
   * Put a media entry in a block of the open draft. Resolves with the frame's
   * `insert-media-result`, or null when the frame cannot be asked (not the
   * editor, not ready, invalid payload) or does not answer in time: a site on
   * an older engine drops `insert-media` without a reply.
   */
  insertMedia(payload: WebsiteFrameInsertMedia): Promise<WebsiteFrameInsertMediaResult | null> {
    const parsed = websiteFrameInsertMediaSchema.safeParse(payload);
    if (!parsed.success) return this.invalid("insert-media");
    if (this.copyMode) return Promise.resolve(null);
    return this.request("insert-media", parsed.data, "insert-media-result", WEBSITE_FRAME_INSERT_MEDIA_TIMEOUT_MS);
  }

  /** The motion choices the engine offered in its `hello-ack`. */
  get motionCapabilities(): WebsiteFrameMotionCapabilities {
    return this.motion;
  }

  /**
   * Put a motion choice in a block of the open draft (GRE-2232). Resolves with
   * the frame's `set-motion-result`, or null when the frame cannot be asked or
   * does not answer in time (an older engine drops `set-motion`).
   */
  setMotion(payload: WebsiteFrameSetMotion): Promise<WebsiteFrameSetMotionResult | null> {
    const parsed = websiteFrameSetMotionSchema.safeParse(payload);
    if (!parsed.success) return this.invalid("set-motion");
    if (this.copyMode) return Promise.resolve(null);
    return this.request("set-motion", parsed.data, "set-motion-result", WEBSITE_FRAME_SET_MOTION_TIMEOUT_MS);
  }

  /** The `editor-command`s the engine said it takes in its `hello-ack` (GRE-2296). Empty for an older engine. */
  get editorCommands(): ReadonlySet<WebsiteEditorCommand> {
    return this.commands;
  }

  /**
   * Run one of the editor's own commands (GRE-2296): undo, redo, save, add
   * block, deselect, outline. Returns false when the frame cannot be asked (not
   * the editor, not ready, or the engine did not offer that command).
   */
  command(command: WebsiteEditorCommand, on?: boolean): boolean {
    // Edit mode and import have their own calls; Edit copy adds and moves nothing.
    if (command === "layout" || command === "import-live") return false;
    if (this.copyMode && COPY_MODE_REFUSED.has(command)) return false;
    return this.sendCommand(command, on);
  }

  /** The comment messages the engine listed in its `hello-ack` (GRE-2361). Empty for an older engine. */
  get commentFeatures(): ReadonlySet<WebsiteFrameCommentMessage> {
    return this.commentMessages;
  }

  /**
   * The open comments' pins (GRE-2361), sent as `comment-pins` once the draft
   * is loaded and again each time they change. A pin for a block that is not
   * on the shown draft is left out. Editor only, and only to an engine that
   * lists `comment-pins`.
   */
  setCommentPins(pins: WebsiteFrameCommentPins["pins"]) {
    this.pins = pins;
    this.sendPins();
  }

  /**
   * A PNG of a block, or of the page when `blockId` is null (GRE-2361).
   * Resolves with the frame's `capture-result`, or null when the engine does
   * not list `capture`, the draft is not loaded, or no answer comes in 5 s.
   */
  capture(blockId: string | null): Promise<WebsiteFrameCaptureResult | null> {
    if (!this.commentMessages.has("capture")) return Promise.resolve(null);
    if (blockId !== null && !this.shownBlocks.has(blockId)) return Promise.resolve(null);
    return this.request("capture", { blockId }, "capture-result", WEBSITE_FRAME_CAPTURE_TIMEOUT_MS, { anyMode: true });
  }

  /** True when the engine has Edit copy (contract 2 with the `layout` command). */
  get hasCopyMode(): boolean {
    return this.copySupported;
  }

  /** True while the editor is in Edit copy: no add, move, delete, duplicate, block settings, media or motion. */
  get copyMode(): boolean {
    return this.options.mode === "editor" && this.copySupported && this.editMode === "copy";
  }

  /** The edit mode the person sees: always Layout on an engine without Edit copy. */
  get currentEditMode(): WebsiteEditMode {
    return this.copySupported ? this.editMode : "layout";
  }

  /**
   * Switch between Edit copy and Layout once the draft is loaded. Returns false
   * when the frame cannot be asked or the engine has no Edit copy.
   */
  setEditMode(mode: WebsiteEditMode): boolean {
    if (!this.copySupported || !this.sendCommand("layout", mode === "layout")) return false;
    this.editMode = mode;
    return true;
  }

  /** What the engine said the live site has for this page, or null. */
  get liveContent(): { blocks: number } | null {
    return this.live;
  }

  /** The draft shown in the frame has no blocks. */
  get draftEmpty(): boolean {
    return this.shownRevisionId !== null && this.shownBlocks.size === 0;
  }

  /**
   * Put the live page into the empty draft (GRE-2394). The frame saves it with
   * a normal `save`, block ids kept. False when there is nothing to import.
   */
  importLive(): boolean {
    if (!this.live || !this.draftEmpty) return false;
    if (!this.sendCommand("import-live")) return false;
    this.importing = true;
    return true;
  }

  private sendCommand(command: WebsiteEditorCommand, on?: boolean): boolean {
    if (this.options.mode !== "editor" || this.connection.phase !== "ready" || this.shownRevisionId === null) return false;
    if (!this.commands.has(command)) return false;
    return this.send("editor-command", on === undefined ? { command } : { command, on }) !== null;
  }

  /** The user leaves the editor. The frame drops the draft; this session stops listening. */
  teardown() {
    if (this.connection.phase === "closed") return;
    this.stopHello();
    for (const pending of this.replies.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null as never);
    }
    this.replies.clear();
    this.send("teardown", {});
    this.setConnection({ phase: "closed" });
  }

  private async acceptHello(ack: WebsiteFrameHelloAck) {
    if (this.connection.phase !== "connecting") return;
    if (ack.siteId !== this.options.siteId) {
      this.stopHello();
      this.setConnection({ phase: "refused-site" });
      return;
    }
    if (!(WEBSITE_FRAME_PROTOCOLS as readonly number[]).includes(ack.protocol)) {
      this.drop(`hello-ack with protocol ${ack.protocol} that was not offered`);
      return;
    }
    this.stopHello();
    if (this.options.mode === "editor" && !isWebsiteEditorContractCurrent(ack)) {
      this.setConnection({ phase: "out-of-date", contract: websiteEditorContractOf(ack) });
      return;
    }
    this.protocol = ack.protocol;
    this.engineTypes = new Set(ack.blocks.map((block) => block.type));
    this.motion = {
      blocks: new Map(ack.blocks.flatMap((block) => (block.motion ? [[block.type, block.motion] as const] : []))),
      effects: ack.motionEffects ?? [],
      surfaces: ack.backgroundSurfaces ?? [],
    };
    this.commands = new Set((ack.editorCommands ?? []).filter(isWebsiteEditorCommand));
    this.copySupported = this.options.mode === "editor" && websiteEditorHasCopyMode(ack);
    this.live = this.options.mode === "editor" && this.copySupported ? (ack.liveContent ?? null) : null;
    this.commentMessages = new Set(ack.editorMessages ?? []);
    this.setConnection({ phase: "ready", protocol: ack.protocol, engine: ack.engine });

    let draft: WebsiteFrameDraft;
    try {
      draft = await this.options.loadDraft();
    } catch (error) {
      this.options.onFrameError?.({
        code: "load-failed",
        message: error instanceof Error ? error.message : "The page could not be loaded.",
      });
      return;
    }
    // The session may have been torn down while the draft loaded.
    if (this.state.phase !== "ready") return;
    this.rememberShown(draft.revisionId, draft.data);
    this.send("load-draft", {
      pageId: this.options.pageId,
      revisionId: draft.revisionId,
      data: draft.data,
      theme: draft.theme,
      media: draft.media,
      site: draft.site,
    });
    this.sentPins = null;
    this.sendPins();
    this.options.onDraftLoaded?.();
  }

  private save(save: WebsiteFrameSave): Promise<WebsiteFrameSaveResult> {
    const key = `${save.pageId}:${save.requestId}`;
    const existing = this.saves.get(key);
    if (existing) {
      return existing.then((result) => {
        this.send("save-result", result);
        return result;
      });
    }

    const answer = (result: WebsiteFrameSaveResult) => {
      this.send("save-result", result);
      return result;
    };
    const fail = (code: string, message: string, retryable: boolean): WebsiteFrameSaveResult => ({
      requestId: save.requestId,
      outcome: "failed",
      code,
      message,
      retryable,
    });

    // A refused save is shown on the host too, never only inside the frame.
    const refuse = (message: string) => {
      this.options.onSaveState?.({ status: "failed", message: `The editor sent a save GSAM cannot accept: ${message}`, retryable: false });
      return Promise.resolve(answer(fail("invalid", message, false)));
    };
    if (this.options.mode !== "editor") return refuse("Preview cannot save.");
    if (save.pageId !== this.options.pageId) return refuse("The save is for another page.");
    const inspected = inspectWebsitePuckData(save.data, this.engineTypes ?? undefined);
    if (!inspected.ok) return refuse(inspected.reason);
    // Edit copy changes words only: the blocks, their order and their types stay.
    // The one exception is the import of live content into an empty draft.
    const importSave = this.importing && this.shownBlocks.size === 0;
    if (this.copyMode && !importSave && !sameBlocks(this.shownBlocks, inspected.blocks)) {
      return refuse("Edit copy changes words only. Switch to Layout to add, move or remove blocks.");
    }
    if (this.copyMode && !importSave && addsTextColour(this.shownData, save.data)) {
      return refuse("Edit copy changes words only. Switch to Layout to change text colour.");
    }
    if (this.inFlight) {
      return Promise.resolve(answer(fail("busy", "Another save is still running.", true)));
    }

    this.inFlight = key;
    this.options.onSaveState?.({ status: "saving" });
    const pending = this.options
      .saveDraft({
        pageId: save.pageId,
        baseRevisionId: save.baseRevisionId,
        data: save.data,
        editorOrigin: this.options.editorOrigin,
      })
      .catch(
        (): WebsiteFrameSaveAnswer => ({
          outcome: "failed",
          code: "network",
          message: "GSAM could not save the page. Check your connection and retry.",
          retryable: true,
        }),
      )
      .then((result): WebsiteFrameSaveResult => {
        this.inFlight = null;
        // A retryable failure is not remembered, so Retry with the same
        // requestId saves again. Saved and conflict answers are replayed.
        if (result.outcome === "failed" && result.retryable) this.saves.delete(key);
        this.retryable = result.outcome === "failed" && result.retryable ? save : null;
        if (result.outcome === "saved") {
          this.importing = false;
          this.rememberShown(result.revisionId, save.data);
          // A saved draft may have new or fewer blocks: their pins follow.
          this.sendPins();
        }
        this.options.onSaveState?.(
          result.outcome === "saved"
            ? { status: "saved", revisionId: result.revisionId, savedAt: result.savedAt }
            : result.outcome === "conflict"
              ? {
                  status: "conflict",
                  currentRevisionId: result.currentRevisionId,
                  savedBy: result.savedBy,
                  savedAt: result.savedAt,
                }
              : { status: "failed", message: result.message, retryable: result.retryable },
        );
        return { requestId: save.requestId, ...result } as WebsiteFrameSaveResult;
      });
    this.saves.set(key, pending);
    return pending.then(answer);
  }

  private blockPicked(picked: WebsiteFrameBlockPicked) {
    if (this.options.mode !== "preview") return this.drop("block-picked outside preview");
    const { ref } = picked;
    if (ref.siteId !== this.options.siteId || ref.pageId !== this.options.pageId) {
      return this.drop("block-picked for another site or page");
    }
    if (ref.pageRevisionId !== this.shownRevisionId) return this.drop("block-picked for another revision");
    const block = this.shownBlocks.get(ref.blockId);
    if (!block || block.type !== ref.blockType) return this.drop("block-picked with an unknown block");
    this.options.onBlockPicked?.({
      ref: { ...ref, source: sanitizeWebsiteFrameSourceHint(ref.source) },
      label: picked.label,
      rect: picked.rect,
    });
  }

  private sendPins() {
    if (this.options.mode !== "editor" || !this.commentMessages.has("comment-pins") || this.pins === null) return;
    if (this.connection.phase !== "ready" || this.shownRevisionId === null) return;
    const pins = this.pins.filter((pin) => this.shownBlocks.has(pin.blockId));
    const parsed = websiteFrameCommentPinsSchema.safeParse({ pins });
    if (!parsed.success) return this.drop("comment-pins payload GSAM made is invalid");
    const key = JSON.stringify(parsed.data.pins);
    if (key === this.sentPins?.key) return;
    if (this.send("comment-pins", parsed.data) !== null) this.sentPins = { key, pins: parsed.data.pins };
  }

  private pinClicked(pin: WebsiteFramePinClicked) {
    if (this.options.mode !== "editor") return this.drop("pin-clicked outside the editor");
    if (!this.commentMessages.has("pin-clicked")) return this.drop("pin-clicked from an engine that did not list it");
    if (!this.sentPins?.pins.some((entry) => entry.blockId === pin.blockId && entry.number === pin.number)) {
      return this.drop("pin-clicked for a pin GSAM did not send");
    }
    this.options.onPinClicked?.(pin);
  }

  private askAgent(ask: WebsiteFrameAskAgent) {
    if (this.options.mode !== "editor") return this.drop("ask-agent outside the editor");
    if (!this.commentMessages.has("ask-agent")) return this.drop("ask-agent from an engine that did not list it");
    const block = this.shownBlocks.get(ask.blockId);
    if (!block || block.type !== ask.blockType) return this.drop("ask-agent with an unknown block");
    this.options.onAskAgent?.(ask);
  }

  private invalid(type: "insert-media" | "set-motion") {
    this.drop(`${type} payload GSAM made is invalid`);
    return Promise.resolve(null);
  }

  /** After the draft is loaded (editor only unless `anyMode`): send, then wait for the matching result or the timeout. */
  private request<R>(
    type: RequestType,
    payload: Record<string, unknown>,
    replyType: ReplyType,
    timeoutMs: number,
    { anyMode = false }: { anyMode?: boolean } = {},
  ): Promise<R | null> {
    if ((!anyMode && this.options.mode !== "editor") || this.connection.phase !== "ready" || this.shownRevisionId === null) {
      return Promise.resolve(null);
    }
    return new Promise<R | null>((resolve) => {
      const id = this.send(type, payload);
      if (!id) return resolve(null);
      const timer = setTimeout(() => {
        this.replies.delete(id);
        resolve(null);
      }, timeoutMs);
      this.replies.set(id, { type: replyType, resolve: resolve as (result: never) => void, timer });
    });
  }

  private reply(type: ReplyType, result: { requestId: string }) {
    const pending = this.replies.get(result.requestId);
    if (!pending || pending.type !== type) return this.drop(`${type} for no open request`);
    clearTimeout(pending.timer);
    this.replies.delete(result.requestId);
    pending.resolve(result as never);
  }

  private rememberShown(revisionId: string, data: unknown) {
    const inspected = inspectWebsitePuckData(data);
    this.shownRevisionId = revisionId;
    this.shownData = data;
    this.shownBlocks = inspected.ok ? inspected.blocks : new Map();
  }

  /** Returns the message id, or null before the handshake. */
  private send(type: WebsiteFrameHostMessageType, payload: Record<string, unknown>): string | null {
    if (this.protocol === null) return null;
    const id = this.createId();
    this.options.post(
      websiteFrameMessage({ id, protocol: this.protocol, session: this.options.nonce, type, payload }),
      this.options.editorOrigin,
    );
    return id;
  }

  private stopHello() {
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.helloDeadline) clearTimeout(this.helloDeadline);
    this.helloTimer = null;
    this.helloDeadline = null;
  }

  private setConnection(connection: WebsiteFrameConnection) {
    this.connection = connection;
    this.options.onConnection?.(connection);
  }

  private drop(reason: string) {
    this.options.onDrop?.(reason);
  }
}
