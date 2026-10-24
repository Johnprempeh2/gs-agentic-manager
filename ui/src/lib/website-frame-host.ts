import {
  WEBSITE_FRAME_HELLO_INTERVAL_MS,
  WEBSITE_FRAME_HELLO_TIMEOUT_MS,
  WEBSITE_FRAME_INSERT_MEDIA_TIMEOUT_MS,
  WEBSITE_FRAME_PROTOCOLS,
  inspectWebsitePuckData,
  receiveWebsiteFrameMessage,
  sanitizeWebsiteFrameSourceHint,
  websiteFrameHelloMessage,
  websiteFrameInsertMediaSchema,
  websiteFrameMessage,
  type WebsiteFrameBlockPicked,
  type WebsiteFrameHelloAck,
  type WebsiteFrameHostMessageType,
  type WebsiteFrameInsertMedia,
  type WebsiteFrameInsertMediaResult,
  type WebsiteFrameMode,
  type WebsiteFrameSave,
  type WebsiteFrameSaveResult,
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
  /** Drop reasons, for the console. Never shown as HTML. */
  onDrop?: (reason: string) => void;
  createId?: () => string;
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
  /** `insert-media` requests waiting for their `insert-media-result`, by message id. */
  private inserts = new Map<string, { resolve: (result: WebsiteFrameInsertMediaResult | null) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Saves by `pageId:requestId`. Scoped to this session (one nonce). */
  private saves = new Map<string, Promise<WebsiteFrameSaveResult>>();
  private inFlight: string | null = null;
  /** The last save that failed with a retryable answer, for the host's own Retry button. */
  private retryable: WebsiteFrameSave | null = null;

  constructor(options: WebsiteFrameHostOptions<Source>) {
    this.options = options;
    this.createId = options.createId ?? defaultCreateId;
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
    });
    const send = () => this.options.post(hello, this.options.editorOrigin);
    send();
    this.helloTimer = setInterval(send, WEBSITE_FRAME_HELLO_INTERVAL_MS);
    this.helloDeadline = setTimeout(() => {
      this.stopHello();
      if (this.connection.phase === "connecting") this.setConnection({ phase: "no-answer" });
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
        this.insertMediaResult(message.payload);
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
    if (this.options.mode !== "editor" || this.connection.phase !== "ready" || this.shownRevisionId === null) {
      return Promise.resolve(null);
    }
    const parsed = websiteFrameInsertMediaSchema.safeParse(payload);
    if (!parsed.success) {
      this.drop("insert-media payload GSAM made is invalid");
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const id = this.send("insert-media", parsed.data);
      if (!id) return resolve(null);
      const timer = setTimeout(() => {
        this.inserts.delete(id);
        resolve(null);
      }, WEBSITE_FRAME_INSERT_MEDIA_TIMEOUT_MS);
      this.inserts.set(id, { resolve, timer });
    });
  }

  /** The user leaves the editor. The frame drops the draft; this session stops listening. */
  teardown() {
    if (this.connection.phase === "closed") return;
    this.stopHello();
    for (const pending of this.inserts.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.inserts.clear();
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
    this.protocol = ack.protocol;
    this.engineTypes = new Set(ack.blocks.map((block) => block.type));
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
        if (result.outcome === "saved") this.rememberShown(result.revisionId, save.data);
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

  private insertMediaResult(result: WebsiteFrameInsertMediaResult) {
    const pending = this.inserts.get(result.requestId);
    if (!pending) return this.drop("insert-media-result for no open request");
    clearTimeout(pending.timer);
    this.inserts.delete(result.requestId);
    pending.resolve(result);
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
