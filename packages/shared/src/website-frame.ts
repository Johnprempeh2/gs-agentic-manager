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

export type WebsiteFrameHostMessageType = "load-draft" | "save-result" | "highlight" | "teardown" | "insert-media" | "set-motion";
export type WebsiteFrameFrameMessageType =
  | "dirty"
  | "save"
  | "block-picked"
  | "error"
  | "insert-media-result"
  | "set-motion-result";

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
const MAX_ASSET_URL_LENGTH = 2048;
const protocolNumber = z.number().int().positive();

// ---------------------------------------------------------------- motion (GRE-2232)

/** Release intensities a block's motion takes (GRE-2215). `none` is always `off`. */
export const WEBSITE_MOTION_INTENSITIES = ["off", "subtle", "full"] as const;
export type WebsiteMotionIntensity = (typeof WEBSITE_MOTION_INTENSITIES)[number];

/** An engine effect id, for example `bg.ascent`, or `none`. The engine owns the list. */
const motionEffectIdSchema = z.string().regex(/^(none|[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47})$/);

const motionChoiceSchema = z.object({ effect: motionEffectIdSchema, intensity: z.enum(WEBSITE_MOTION_INTENSITIES) });
export type WebsiteMotionChoice = z.infer<typeof motionChoiceSchema>;

/** `hello-ack.blocks[].motion`: the effects one block type takes, and what a new block starts with. */
const blockMotionSchema = z.object({
  effects: z.array(motionEffectIdSchema).min(1).max(50),
  default: motionChoiceSchema,
});

/**
 * `hello-ack.motionEffects`: one effect the engine can draw. `still` is a path on
 * the editor origin. `study` is the Animation Lab study number it comes from, for
 * a `bg.*` effect made from a text-safe study (015 to 020 today).
 */
export const websiteMotionEffectSchema = z.object({
  id: motionEffectIdSchema,
  label: z.string().min(1).max(100),
  still: z.string().max(MAX_ASSET_URL_LENGTH).refine((value) => value.startsWith("/") && isWebsiteFrameAssetUrl(value)),
  study: z.string().regex(/^\d{3}$/).optional(),
});
export type WebsiteMotionEffect = z.infer<typeof websiteMotionEffectSchema>;

export const websiteFrameHelloAckSchema = z.object({
  protocol: protocolNumber,
  nonce: z.string(),
  siteId: idString,
  engine: z.object({ version: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  supportedReleaseSchemas: z.array(protocolNumber).min(1),
  blocks: z
    .array(z.object({ type: blockTypeSchema, label: z.string().max(200), motion: blockMotionSchema.optional().catch(undefined) }))
    .max(500),
  /** Added in protocol 1 (GRE-2232). An older engine leaves it out: no motion choices. */
  // A malformed motion list is dropped, never the handshake: the editor still opens.
  motionEffects: z.array(websiteMotionEffectSchema).max(100).optional().catch(undefined),
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

// ---------------------------------------------------------------- insert-media

/**
 * How long the host waits for `insert-media-result`. A site on an older engine
 * ignores `insert-media` without an answer (unknown host types are dropped,
 * protocol 1 is kept), so no reply in time means "not supported here".
 */
export const WEBSITE_FRAME_INSERT_MEDIA_TIMEOUT_MS = 5_000;

/**
 * An `assetUrl` the frame may put in a block: an absolute `https://` URL with
 * no credentials, or a root-relative path on the site's own (media) origin,
 * such as `/media/hero.webp`. Protocol-relative (`//host`), backslashes and
 * every other scheme (`http:`, `javascript:`, `data:`, `blob:`) are refused.
 */
export function isWebsiteFrameAssetUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ASSET_URL_LENGTH) return false;
  if (/[\s\\]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.hostname.length > 0;
}

/** A top-level Puck prop name on the block, for example `image`. */
const blockFieldSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

const dimensionSchema = z.number().int().nonnegative().nullable();

/**
 * One media entry as the frame gets it, the same shape as a `load-draft.media`
 * entry: the image itself as a `Blob`, so the frame never calls GSAM.
 */
export const websiteFrameMediaEntrySchema = z
  .object({
    blob: z.custom<Blob>((value) => typeof Blob !== "undefined" && value instanceof Blob),
    alt: z.string().max(500),
    width: dimensionSchema,
    height: dimensionSchema,
  })
  .strict();
export type WebsiteFrameMediaEntry = z.infer<typeof websiteFrameMediaEntrySchema>;

/**
 * `insert-media` payload, host to frame: put this media entry in this field of this block.
 * - `mediaEntryId` carries the GSAM asset id (the key of `load-draft.media`), not a
 *   Website media entry id. The frame stores it in the block as `media:<assetId>`.
 *   The name stays as it is: sites already on protocol 1 read it.
 * - `media` is optional (added in protocol 1, GRE-2226): the image as a `Blob`, so
 *   the frame can show it before the page is saved and loaded again. The host leaves
 *   it out when it cannot fetch the image; the frame then falls back to `assetUrl`.
 */
export const websiteFrameInsertMediaSchema = z
  .object({
    blockId: blockIdSchema,
    field: blockFieldSchema,
    mediaEntryId: idString,
    assetUrl: z.string().max(MAX_ASSET_URL_LENGTH).refine(isWebsiteFrameAssetUrl),
    alt: z.string().max(500),
    media: websiteFrameMediaEntrySchema.optional(),
  })
  .strict();
export type WebsiteFrameInsertMedia = z.infer<typeof websiteFrameInsertMediaSchema>;

/**
 * Why the frame did not insert the media:
 * - `block_not_found`: no block with `blockId` on the open page.
 * - `field_not_found`: the block type has no field named `field`.
 * - `field_not_media`: the field exists but does not take media.
 * - `invalid_payload`: the frame's own checks refused the payload.
 * - `error`: anything else; `message` says what.
 */
export const WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES = [
  "block_not_found",
  "field_not_found",
  "field_not_media",
  "invalid_payload",
  "error",
] as const;
export type WebsiteFrameInsertMediaErrorCode = (typeof WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES)[number];

/**
 * `insert-media-result` payload, frame to host. `requestId` is the `id` of the
 * `insert-media` message it answers. A refusal always carries a `code`.
 */
export const websiteFrameInsertMediaResultSchema = z.discriminatedUnion("ok", [
  z.object({ requestId: idString, ok: z.literal(true), message: z.string().max(2000).optional() }),
  z.object({
    requestId: idString,
    ok: z.literal(false),
    code: z.enum(WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES),
    message: z.string().max(2000).optional(),
  }),
]);
export type WebsiteFrameInsertMediaResult = z.infer<typeof websiteFrameInsertMediaResultSchema>;

// ---------------------------------------------------------------- set-motion (GRE-2232)

/** How long the host waits for `set-motion-result`. An older engine drops `set-motion` without a reply. */
export const WEBSITE_FRAME_SET_MOTION_TIMEOUT_MS = 5_000;

/**
 * `set-motion` payload, host to frame: put this motion choice in this block of
 * the open draft. The frame checks the effect against the block's own list and
 * marks the draft unsaved; nothing is saved until the person saves.
 */
export const websiteFrameSetMotionSchema = z.object({ blockId: blockIdSchema, motion: motionChoiceSchema }).strict();
export type WebsiteFrameSetMotion = z.infer<typeof websiteFrameSetMotionSchema>;

/**
 * Why the frame did not set the motion:
 * - `block_not_found`: no block with `blockId` on the open page.
 * - `block_has_no_motion`: the block type takes no motion.
 * - `effect_not_allowed`: the block takes motion, but not this effect.
 * - `invalid_payload`: the frame's own checks refused the payload.
 * - `error`: anything else; `message` says what.
 */
export const WEBSITE_FRAME_SET_MOTION_ERROR_CODES = [
  "block_not_found",
  "block_has_no_motion",
  "effect_not_allowed",
  "invalid_payload",
  "error",
] as const;
export type WebsiteFrameSetMotionErrorCode = (typeof WEBSITE_FRAME_SET_MOTION_ERROR_CODES)[number];

/** `set-motion-result` payload, frame to host. `requestId` is the `id` of the `set-motion` it answers. */
export const websiteFrameSetMotionResultSchema = z.discriminatedUnion("ok", [
  z.object({ requestId: idString, ok: z.literal(true), message: z.string().max(2000).optional() }),
  z.object({
    requestId: idString,
    ok: z.literal(false),
    code: z.enum(WEBSITE_FRAME_SET_MOTION_ERROR_CODES),
    message: z.string().max(2000).optional(),
  }),
]);
export type WebsiteFrameSetMotionResult = z.infer<typeof websiteFrameSetMotionResultSchema>;

const framePayloadSchemas = {
  dirty: websiteFrameDirtySchema,
  save: websiteFrameSaveSchema,
  "block-picked": websiteFrameBlockPickedSchema,
  error: websiteFrameErrorSchema,
  "insert-media-result": websiteFrameInsertMediaResultSchema,
  "set-motion-result": websiteFrameSetMotionResultSchema,
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
  | { type: "error"; id: string; payload: z.infer<typeof websiteFrameErrorSchema> }
  | { type: "insert-media-result"; id: string; payload: WebsiteFrameInsertMediaResult }
  | { type: "set-motion-result"; id: string; payload: WebsiteFrameSetMotionResult };

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

/**
 * The two addresses the Preview tab and the Home hero frame (24 Oct 2026).
 * Live: the frameable mirror when set (an exact copy of the live deploy),
 * else the live domain. In development: its own address when set, else the
 * editor address, else none.
 */
export function websitePreviewAddresses(
  site: { domain: string; livePreviewUrl: string | null; devPreviewUrl: string | null; editorFrameOrigin: string | null },
): { live: string; liveIsMirror: boolean; dev: string | null } {
  return {
    live: site.livePreviewUrl ?? `https://${site.domain}/`,
    liveIsMirror: !!site.livePreviewUrl,
    dev: site.devPreviewUrl ?? (site.editorFrameOrigin ? `${site.editorFrameOrigin}/` : null),
  };
}
