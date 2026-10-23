import { z } from "zod";

// Website editor frame contract, protocol 1 (GRE-1916 `frame-contract`).
// GSAM's Website page is the host; the site's `/editor` and `/preview`
// routes are the frame. Everything here is pure so the host (GSAM UI) and
// tests share one reading of the contract. Every message from the frame is
// untrusted input: nothing is saved or shown until it passes these checks.

export const WEBSITE_FRAME_TAG = "website-frame" as const;

/** Protocol versions this GSAM speaks, highest last. */
export const WEBSITE_FRAME_PROTOCOLS = [1] as const;

export const WEBSITE_FRAME_HELLO_INTERVAL_MS = 250;
export const WEBSITE_FRAME_HELLO_TIMEOUT_MS = 10_000;
export const WEBSITE_FRAME_SAVE_TIMEOUT_MS = 30_000;
/** Largest frame message the host accepts (contract section 6). */
export const WEBSITE_FRAME_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** The iframe `sandbox` value. Nothing else may be added (contract section 3). */
export const WEBSITE_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

export type WebsiteFrameMode = "editor" | "preview";

export type WebsiteFrameHandshakeType = "hello" | "hello-ack" | "hello-refused";
export const WEBSITE_FRAME_HANDSHAKE_TYPES: readonly WebsiteFrameHandshakeType[] = [
  "hello",
  "hello-ack",
  "hello-refused",
];

export type WebsiteFrameHostMessageType = "load-draft" | "save-result" | "highlight" | "teardown";
export type WebsiteFrameFrameMessageType = "dirty" | "save" | "block-picked" | "error";

// ---------------------------------------------------------------- nonce

const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isWebsiteFrameNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

/** 16 random bytes as unpadded base64url (22 characters). New for every iframe load. */
export function createWebsiteFrameNonce(
  getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    globalThis.crypto.getRandomValues(bytes);
  },
): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------- origins

/**
 * The exact origin (scheme, host, port) of an `https://` URL with no path,
 * query, fragment or credentials, or null. `http://localhost` is allowed
 * only when `allowLocalhost` is set (a development engine).
 */
export function parseWebsiteEditorOrigin(value: string, options: { allowLocalhost?: boolean } = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (value.includes("*")) return null;
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && isLocalhost && options.allowLocalhost) return parsed.origin;
  return null;
}

export type WebsiteEditorOriginProblem = "invalid" | "public-origin" | "gsam-origin";

/**
 * Rule C1.1: the editor origin must be a dedicated host, never the public
 * site's origin and never an origin GSAM is served from. Run on every save of
 * the setting and again before the iframe is loaded.
 */
export function checkWebsiteEditorOrigin(
  editorOrigin: string,
  context: { publicOrigin: string | null; gsamOrigins: readonly string[]; allowLocalhost?: boolean },
): WebsiteEditorOriginProblem | null {
  const origin = parseWebsiteEditorOrigin(editorOrigin, { allowLocalhost: context.allowLocalhost });
  if (!origin) return "invalid";
  const sameAs = (other: string | null) => {
    if (!other) return false;
    try {
      return new URL(other).origin === origin;
    } catch {
      return false;
    }
  };
  if (sameAs(context.publicOrigin)) return "public-origin";
  if (context.gsamOrigins.some(sameAs)) return "gsam-origin";
  return null;
}

/** The iframe `src`: the editor origin plus a fixed path. No draft, nonce or user data. */
export function websiteFrameSrc(editorOrigin: string, mode: WebsiteFrameMode, pageId: string): string {
  return `${editorOrigin}/${mode}/${encodeURIComponent(pageId)}`;
}

// ---------------------------------------------------------------- Puck data

const blockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const blockTypeSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/);

export const websitePuckDataSchema = z
  .object({
    root: z.object({ props: z.record(z.string(), z.unknown()) }).strict(),
    content: z.array(z.unknown()).max(300),
  })
  .strict();

export type WebsitePuckData = z.infer<typeof websitePuckDataSchema>;

export interface WebsitePuckBlockInfo {
  id: string;
  type: string;
}

function looksLikeBlock(value: unknown): value is { type: unknown; props: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    "props" in value &&
    typeof (value as { props: unknown }).props === "object" &&
    (value as { props: unknown }).props !== null
  );
}

/**
 * Release rule R6 on one page's Puck data: valid shape, every block (nested
 * slot blocks too) has a valid `type` and a unique `props.id`, and, when the
 * engine's block list is known, every type is one of them. Returns the blocks
 * by id, or the first problem found.
 */
export function inspectWebsitePuckData(
  data: unknown,
  allowedTypes?: ReadonlySet<string>,
): { ok: true; blocks: Map<string, WebsitePuckBlockInfo> } | { ok: false; reason: string } {
  const parsed = websitePuckDataSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: "Page data is not Puck data (root and content)." };
  const blocks = new Map<string, WebsitePuckBlockInfo>();

  const visit = (items: unknown[], depth: number): string | null => {
    if (depth > 20) return "Blocks are nested too deep.";
    for (const item of items) {
      if (!looksLikeBlock(item)) return "A block has no type or props.";
      const keys = Object.keys(item);
      if (keys.some((key) => key !== "type" && key !== "props")) return "A block has unknown fields.";
      if (!blockTypeSchema.safeParse(item.type).success) return "A block has an invalid type.";
      const type = item.type as string;
      if (allowedTypes && !allowedTypes.has(type)) return `Block type ${type} is not in this site's engine.`;
      const id = item.props.id;
      if (!blockIdSchema.safeParse(id).success) return `A ${type} block has no valid id.`;
      if (blocks.has(id as string)) return `Block id ${id as string} is used twice.`;
      blocks.set(id as string, { id: id as string, type });
      for (const value of Object.values(item.props)) {
        if (Array.isArray(value) && value.length > 0 && value.every(looksLikeBlock)) {
          const problem = visit(value, depth + 1);
          if (problem) return problem;
        }
      }
    }
    return null;
  };

  const problem = visit(parsed.data.content, 0);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, blocks };
}

// ---------------------------------------------------------------- payloads

const idString = z.string().min(1).max(200);
const protocolNumber = z.number().int().positive();

export const websiteFrameHelloAckSchema = z.object({
  protocol: protocolNumber,
  nonce: z.string(),
  siteId: idString,
  engine: z.object({ version: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  supportedReleaseSchemas: z.array(protocolNumber).min(1),
  blocks: z.array(z.object({ type: blockTypeSchema, label: z.string().max(200) })).max(500),
});
export type WebsiteFrameHelloAck = z.infer<typeof websiteFrameHelloAckSchema>;

export const websiteFrameHelloRefusedSchema = z.object({
  nonce: z.string(),
  reason: z.string().max(50),
  supported: z.array(protocolNumber).max(50),
});
export type WebsiteFrameHelloRefused = z.infer<typeof websiteFrameHelloRefusedSchema>;

export const websiteFrameDirtySchema = z.object({ dirty: z.boolean() });

export const websiteFrameSaveSchema = z.object({
  requestId: idString,
  pageId: idString,
  baseRevisionId: idString,
  data: z.unknown(),
});
export type WebsiteFrameSave = z.infer<typeof websiteFrameSaveSchema>;

const sourceHintSchema = z.object({ file: z.string(), line: z.number() }).nullable();

export const websiteFrameBlockPickedSchema = z.object({
  ref: z.object({
    siteId: idString,
    pageId: idString,
    pageRevisionId: idString,
    blockId: blockIdSchema,
    blockType: blockTypeSchema,
    engine: z.object({ version: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
    source: sourceHintSchema.optional(),
  }),
  label: z.string().max(200),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type WebsiteFrameBlockPicked = z.infer<typeof websiteFrameBlockPickedSchema>;

export const websiteFrameErrorSchema = z.object({ code: z.string().max(100), message: z.string().max(2000) });

const framePayloadSchemas = {
  dirty: websiteFrameDirtySchema,
  save: websiteFrameSaveSchema,
  "block-picked": websiteFrameBlockPickedSchema,
  error: websiteFrameErrorSchema,
} as const;

/**
 * Click-to-change source hint (contract section 7): a repo-relative file and
 * a positive line, or null when the frame sent anything else.
 */
export function sanitizeWebsiteFrameSourceHint(source: unknown): { file: string; line: number } | null {
  if (typeof source !== "object" || source === null) return null;
  const { file, line } = source as { file?: unknown; line?: unknown };
  if (typeof file !== "string" || !/^[A-Za-z0-9_./-]+$/.test(file)) return null;
  if (file.startsWith("/") || file.split("/").includes("..")) return null;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  return { file, line };
}

// ---------------------------------------------------------------- receive rules

export type WebsiteFrameIncoming =
  | { type: "hello-ack"; id: string; payload: WebsiteFrameHelloAck }
  | { type: "hello-refused"; id: string; payload: WebsiteFrameHelloRefused }
  | { type: "dirty"; id: string; payload: z.infer<typeof websiteFrameDirtySchema> }
  | { type: "save"; id: string; payload: WebsiteFrameSave }
  | { type: "block-picked"; id: string; payload: WebsiteFrameBlockPicked }
  | { type: "error"; id: string; payload: z.infer<typeof websiteFrameErrorSchema> };

export interface WebsiteFrameReceiveContext<Source> {
  /** The site's `editorOrigin`. */
  origin: string;
  /** The iframe's `contentWindow`. */
  source: Source;
  /** This iframe load's nonce. */
  nonce: string;
  /** The agreed protocol, or null before a valid `hello-ack`. */
  protocol: number | null;
}

export type WebsiteFrameReceiveResult =
  | { ok: true; message: WebsiteFrameIncoming }
  | { ok: false; reason: string };

function approximateSize(data: unknown): number {
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The host's receive rules (contract section 5), in order: exact origin,
 * right window, the `website-frame` tag, nonce or protocol and session, then
 * a known type with a valid payload. A message that fails is dropped without
 * an answer; the reason is for the console only.
 */
export function receiveWebsiteFrameMessage<Source>(
  event: { origin: string; source: Source | null; data: unknown },
  context: WebsiteFrameReceiveContext<Source>,
): WebsiteFrameReceiveResult {
  if (event.origin !== context.origin) return { ok: false, reason: `wrong origin ${event.origin}` };
  if (event.source !== context.source) return { ok: false, reason: "wrong window" };
  const data = event.data;
  if (typeof data !== "object" || data === null || (data as { gs?: unknown }).gs !== WEBSITE_FRAME_TAG) {
    return { ok: false, reason: "not a website-frame message" };
  }
  if (approximateSize(data) > WEBSITE_FRAME_MAX_MESSAGE_BYTES) return { ok: false, reason: "message too large" };
  const { type, id, payload } = data as { type?: unknown; id?: unknown; payload?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return { ok: false, reason: "no message id" };

  if (type === "hello-ack" || type === "hello-refused") {
    if (context.protocol !== null && type === "hello-refused") return { ok: false, reason: "refusal after ack" };
    const schema = type === "hello-ack" ? websiteFrameHelloAckSchema : websiteFrameHelloRefusedSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: `invalid ${type} payload` };
    if (parsed.data.nonce !== context.nonce) return { ok: false, reason: "wrong nonce" };
    return { ok: true, message: { type, id, payload: parsed.data } as WebsiteFrameIncoming };
  }

  if (context.protocol === null) return { ok: false, reason: `${String(type)} before hello-ack` };
  const envelope = data as { protocol?: unknown; session?: unknown };
  if (envelope.protocol !== context.protocol) return { ok: false, reason: "wrong protocol" };
  if (envelope.session !== context.nonce) return { ok: false, reason: "wrong session" };
  if (typeof type !== "string" || !(type in framePayloadSchemas)) return { ok: false, reason: `unknown type ${String(type)}` };
  const schema = framePayloadSchemas[type as keyof typeof framePayloadSchemas];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: `invalid ${type} payload` };
  return { ok: true, message: { type, id, payload: parsed.data } as WebsiteFrameIncoming };
}

// ---------------------------------------------------------------- outgoing

export function websiteFrameHelloMessage(input: {
  id: string;
  siteId: string;
  nonce: string;
  mode: WebsiteFrameMode;
  pageId: string;
}) {
  return {
    gs: WEBSITE_FRAME_TAG,
    id: input.id,
    type: "hello" as const,
    payload: {
      protocols: [...WEBSITE_FRAME_PROTOCOLS],
      siteId: input.siteId,
      nonce: input.nonce,
      mode: input.mode,
      pageId: input.pageId,
    },
  };
}

export function websiteFrameMessage<T extends WebsiteFrameHostMessageType>(input: {
  id: string;
  protocol: number;
  session: string;
  type: T;
  payload: Record<string, unknown>;
}) {
  return {
    gs: WEBSITE_FRAME_TAG,
    protocol: input.protocol,
    session: input.session,
    id: input.id,
    type: input.type,
    payload: input.payload,
  };
}

/** `save-result` payloads (contract section 5.2). */
export type WebsiteFrameSaveResult =
  | { requestId: string; outcome: "saved"; revisionId: string; savedAt: string }
  | {
      requestId: string;
      outcome: "conflict";
      currentRevisionId: string;
      currentData: unknown;
      currentMedia: Record<string, unknown>;
      savedBy: string;
      savedAt: string;
    }
  | { requestId: string; outcome: "failed"; code: string; message: string; retryable: boolean };
