import { describe, expect, it } from "vitest";
import {
  checkWebsiteEditorOrigin,
  createWebsiteFrameNonce,
  inspectWebsitePuckData,
  isWebsiteFrameAssetUrl,
  isWebsiteFrameNonce,
  parseWebsiteEditorOrigin,
  receiveWebsiteFrameMessage,
  sanitizeWebsiteFrameSourceHint,
  WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES,
  WEBSITE_FRAME_SET_MOTION_ERROR_CODES,
  websiteFrameSetMotionSchema,
  websiteFrameInsertMediaSchema,
  websiteFrameSrc,
} from "./website-frame.js";

const ORIGIN = "https://editor.example.com";
const frameWindow = { name: "frame" };
const nonce = createWebsiteFrameNonce();

function ack(overrides: Record<string, unknown> = {}) {
  return {
    gs: "website-frame",
    id: "m1",
    type: "hello-ack",
    payload: {
      protocol: 1,
      nonce,
      siteId: "site-1",
      engine: { version: "1.0.0", commit: "a".repeat(40) },
      supportedReleaseSchemas: [1],
      blocks: [{ type: "Hero", label: "Hero" }],
      ...overrides,
    },
  };
}

const ctx = (protocol: number | null) => ({ origin: ORIGIN, source: frameWindow, nonce, protocol });

describe("nonce", () => {
  it("is 22 base64url characters and new every time", () => {
    const a = createWebsiteFrameNonce();
    expect(isWebsiteFrameNonce(a)).toBe(true);
    expect(a).not.toBe(createWebsiteFrameNonce());
  });
});

describe("editor origin", () => {
  it("accepts an exact https origin only", () => {
    expect(parseWebsiteEditorOrigin("https://editor.example.com")).toBe(ORIGIN);
    expect(parseWebsiteEditorOrigin("https://editor.example.com/")).toBe(ORIGIN);
    expect(parseWebsiteEditorOrigin("https://editor.example.com/editor")).toBeNull();
    expect(parseWebsiteEditorOrigin("https://*.example.com")).toBeNull();
    expect(parseWebsiteEditorOrigin("http://editor.example.com")).toBeNull();
    expect(parseWebsiteEditorOrigin("https://u:p@editor.example.com")).toBeNull();
    expect(parseWebsiteEditorOrigin("http://localhost:3000")).toBeNull();
    expect(parseWebsiteEditorOrigin("http://localhost:3000", { allowLocalhost: true })).toBe("http://localhost:3000");
  });

  it("refuses the public origin and every GSAM origin (C1.1)", () => {
    const context = { publicOrigin: "https://example.com", gsamOrigins: ["https://gsam.tail.ts.net"] };
    expect(checkWebsiteEditorOrigin(ORIGIN, context)).toBeNull();
    expect(checkWebsiteEditorOrigin("https://example.com", context)).toBe("public-origin");
    expect(checkWebsiteEditorOrigin("https://gsam.tail.ts.net", context)).toBe("gsam-origin");
    expect(checkWebsiteEditorOrigin("nope", context)).toBe("invalid");
  });

  it("builds the iframe src from the origin and a fixed path only", () => {
    expect(websiteFrameSrc(ORIGIN, "editor", "page/1")).toBe(`${ORIGIN}/editor/page%2F1`);
  });
});

describe("receive rules (test 1, 11)", () => {
  it("accepts a valid hello-ack", () => {
    const result = receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: ack() }, ctx(null));
    expect(result.ok).toBe(true);
  });

  it("drops a wrong origin, a wrong window and a wrong nonce", () => {
    expect(receiveWebsiteFrameMessage({ origin: "https://evil.example", source: frameWindow, data: ack() }, ctx(null)).ok).toBe(false);
    expect(receiveWebsiteFrameMessage({ origin: ORIGIN, source: { name: "other" }, data: ack() }, ctx(null)).ok).toBe(false);
    expect(
      receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: ack({ nonce: createWebsiteFrameNonce() }) }, ctx(null)).ok,
    ).toBe(false);
  });

  it("drops a non-handshake message before hello-ack", () => {
    const dirty = { gs: "website-frame", protocol: 1, session: nonce, id: "m2", type: "dirty", payload: { dirty: true } };
    expect(receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: dirty }, ctx(null))).toEqual({
      ok: false,
      reason: "dirty before hello-ack",
    });
    expect(receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: dirty }, ctx(1)).ok).toBe(true);
  });

  it("drops a wrong protocol, a wrong session and an unknown type after the handshake", () => {
    const base = { gs: "website-frame", protocol: 1, session: nonce, id: "m3", type: "dirty", payload: { dirty: true } };
    const check = (data: unknown) => receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data }, ctx(1)).ok;
    expect(check({ ...base, protocol: 2 })).toBe(false);
    expect(check({ ...base, session: createWebsiteFrameNonce() })).toBe(false);
    expect(check({ ...base, type: "eval" })).toBe(false);
    expect(check({ ...base, payload: { dirty: "yes" } })).toBe(false);
    expect(check({ ...base, gs: "other" })).toBe(false);
  });
});

describe("Puck data (R6)", () => {
  const page = (content: unknown[]) => ({ root: { props: {} }, content });

  it("collects nested slot blocks by id", () => {
    const result = inspectWebsitePuckData(
      page([{ type: "Section", props: { id: "s1", items: [{ type: "Hero", props: { id: "h1" } }] } }]),
    );
    expect(result.ok && [...result.blocks.keys()]).toEqual(["s1", "h1"]);
  });

  it("refuses duplicate ids, missing ids, unknown types and legacy zones", () => {
    expect(inspectWebsitePuckData(page([{ type: "Hero", props: { id: "a" } }, { type: "Hero", props: { id: "a" } }])).ok).toBe(false);
    expect(inspectWebsitePuckData(page([{ type: "Hero", props: {} }])).ok).toBe(false);
    expect(inspectWebsitePuckData(page([{ type: "Hero", props: { id: "a" } }]), new Set(["Text"])).ok).toBe(false);
    expect(inspectWebsitePuckData({ ...page([]), zones: {} }).ok).toBe(false);
  });
});

describe("source hint (test 8)", () => {
  it("keeps a repo-relative file and line, drops anything else", () => {
    expect(sanitizeWebsiteFrameSourceHint({ file: "src/blocks/Hero.tsx", line: 12 })).toEqual({ file: "src/blocks/Hero.tsx", line: 12 });
    expect(sanitizeWebsiteFrameSourceHint({ file: "/etc/passwd", line: 1 })).toBeNull();
    expect(sanitizeWebsiteFrameSourceHint({ file: "src/../../x", line: 1 })).toBeNull();
    expect(sanitizeWebsiteFrameSourceHint({ file: "src/<b>.tsx", line: 1 })).toBeNull();
    expect(sanitizeWebsiteFrameSourceHint({ file: "src/a.tsx", line: 0 })).toBeNull();
    expect(sanitizeWebsiteFrameSourceHint(null)).toBeNull();
  });
});

describe("insert-media (host to frame)", () => {
  const valid = {
    blockId: "hero-1",
    field: "image",
    mediaEntryId: "entry-1",
    assetUrl: "https://media.example.com/hero.webp",
    alt: "A stone bridge at dawn",
  };
  const parses = (overrides: Record<string, unknown>) =>
    websiteFrameInsertMediaSchema.safeParse({ ...valid, ...overrides }).success;

  it("parses a valid payload, with an https URL or a site-relative path", () => {
    expect(websiteFrameInsertMediaSchema.parse(valid)).toEqual(valid);
    expect(parses({ assetUrl: "/media/hero.webp" })).toBe(true);
    expect(parses({ alt: "" })).toBe(true);
  });

  it("refuses a bad block id or field", () => {
    expect(parses({ blockId: "" })).toBe(false);
    expect(parses({ blockId: "hero 1" })).toBe(false);
    expect(parses({ blockId: "a".repeat(97) })).toBe(false);
    expect(parses({ field: "items[0].image" })).toBe(false);
    expect(parses({ field: "__proto__.x" })).toBe(false);
  });

  it("refuses a bad URL", () => {
    for (const url of [
      "http://media.example.com/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "blob:https://media.example.com/1",
      "//evil.example/a.png",
      "/\\evil.example/a.png",
      "https://u:p@media.example.com/a.png",
      "hero.webp",
      "",
    ]) {
      expect(isWebsiteFrameAssetUrl(url)).toBe(false);
      expect(parses({ assetUrl: url })).toBe(false);
    }
  });

  it("refuses oversized fields and unknown keys", () => {
    expect(parses({ alt: "a".repeat(501) })).toBe(false);
    expect(parses({ mediaEntryId: "a".repeat(201) })).toBe(false);
    expect(parses({ field: "a".repeat(65) })).toBe(false);
    expect(parses({ assetUrl: `https://media.example.com/${"a".repeat(2048)}` })).toBe(false);
    expect(parses({ extra: true })).toBe(false);
  });

  it("parses a payload with the media blob, and the old payload without it", () => {
    const media = { blob: new Blob(["png"], { type: "image/png" }), alt: "A stone bridge at dawn", width: 1600, height: 900 };
    const parsed = websiteFrameInsertMediaSchema.parse({ ...valid, media });
    expect(parsed.media?.blob).toBe(media.blob);
    expect(parsed.media).toMatchObject({ alt: media.alt, width: 1600, height: 900 });
    expect(parses({ media: { ...media, width: null, height: null } })).toBe(true);
    expect(websiteFrameInsertMediaSchema.parse(valid).media).toBeUndefined();
  });

  it("refuses a media entry that is not a blob or has unknown keys", () => {
    const media = { blob: new Blob(["png"]), alt: "", width: null, height: null };
    expect(parses({ media: { ...media, blob: "data:image/png;base64,AAAA" } })).toBe(false);
    expect(parses({ media: { ...media, blob: undefined } })).toBe(false);
    expect(parses({ media: { ...media, width: -1 } })).toBe(false);
    expect(parses({ media: { ...media, alt: "a".repeat(501) } })).toBe(false);
    expect(parses({ media: { ...media, url: "https://media.example.com/a.png" } })).toBe(false);
  });
});

describe("insert-media-result (frame to host)", () => {
  const message = (payload: unknown) => ({
    gs: "website-frame",
    protocol: 1,
    session: nonce,
    id: "m9",
    type: "insert-media-result",
    payload,
  });
  const receive = (payload: unknown) =>
    receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: message(payload) }, ctx(1));

  it("accepts ok", () => {
    expect(receive({ requestId: "m8", ok: true })).toEqual({
      ok: true,
      message: { type: "insert-media-result", id: "m9", payload: { requestId: "m8", ok: true } },
    });
  });

  it("accepts each refusal code", () => {
    expect(WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES).toEqual([
      "block_not_found",
      "field_not_found",
      "field_not_media",
      "invalid_payload",
      "error",
    ]);
    for (const code of WEBSITE_FRAME_INSERT_MEDIA_ERROR_CODES) {
      expect(receive({ requestId: "m8", ok: false, code, message: "No such block." }).ok).toBe(true);
    }
  });

  it("drops a refusal with no code or an unknown code, and anything before hello-ack", () => {
    expect(receive({ requestId: "m8", ok: false }).ok).toBe(false);
    expect(receive({ requestId: "m8", ok: false, code: "nope" }).ok).toBe(false);
    expect(receive({ ok: true }).ok).toBe(false);
    expect(receive({ requestId: "m8", ok: false, code: "error", message: "a".repeat(2001) }).ok).toBe(false);
    expect(
      receiveWebsiteFrameMessage({ origin: ORIGIN, source: frameWindow, data: message({ requestId: "m8", ok: true }) }, ctx(null)).ok,
    ).toBe(false);
  });
});

describe("set-motion (GRE-2232)", () => {
  const receive = (type: string, payload: unknown) =>
    receiveWebsiteFrameMessage(
      { origin: ORIGIN, source: frameWindow, data: { gs: "website-frame", protocol: 1, session: nonce, id: "m9", type, payload } },
      ctx(1),
    );

  it("reads the engine's motion choices from hello-ack, the same shape the site sends", () => {
    const motion = { effects: ["none", "bg.ascent"], default: { effect: "none", intensity: "off" } };
    const motionEffects = [
      { id: "hero.stone", label: "Hero stone", still: "/motion/stone-still.png" },
      { id: "bg.ascent", label: "Ascent", still: "/motion/ascent-dark.webp", study: "016" },
    ];
    const received = receiveWebsiteFrameMessage(
      { origin: ORIGIN, source: frameWindow, data: ack({ blocks: [{ type: "Hero", label: "Hero", motion }], motionEffects }) },
      ctx(null),
    );
    expect(received.ok && received.message.type === "hello-ack" && received.message.payload).toMatchObject({
      blocks: [{ type: "Hero", motion }],
      motionEffects,
    });
  });

  it("drops a bad motion list but keeps the handshake", () => {
    const received = receiveWebsiteFrameMessage(
      {
        origin: ORIGIN,
        source: frameWindow,
        data: ack({
          blocks: [{ type: "Hero", label: "Hero", motion: { effects: ["BG ASCENT"], default: {} } }],
          motionEffects: [{ id: "bg.ascent", label: "Ascent", still: "https://elsewhere.example/a.webp" }],
        }),
      },
      ctx(null),
    );
    expect(received.ok).toBe(true);
    const payload = received.ok && received.message.type === "hello-ack" ? received.message.payload : null;
    expect(payload?.blocks[0]?.motion).toBeUndefined();
    expect(payload?.motionEffects).toBeUndefined();
  });

  it("sends only a block id and a release choice", () => {
    expect(websiteFrameSetMotionSchema.safeParse({ blockId: "h1", motion: { effect: "bg.ascent", intensity: "subtle" } }).success).toBe(true);
    expect(websiteFrameSetMotionSchema.safeParse({ blockId: "h1", motion: { effect: "bg.ascent", intensity: "extreme" } }).success).toBe(false);
    expect(websiteFrameSetMotionSchema.safeParse({ blockId: "h1", motion: { effect: "<b>", intensity: "full" } }).success).toBe(false);
    expect(websiteFrameSetMotionSchema.safeParse({ blockId: "h1", motion: { effect: "none", intensity: "off" }, code: "x" }).success).toBe(false);
  });

  it("accepts set-motion-result with each refusal code the site sends", () => {
    expect(WEBSITE_FRAME_SET_MOTION_ERROR_CODES).toEqual([
      "block_not_found",
      "block_has_no_motion",
      "effect_not_allowed",
      "invalid_payload",
      "error",
    ]);
    expect(receive("set-motion-result", { requestId: "m8", ok: true }).ok).toBe(true);
    for (const code of WEBSITE_FRAME_SET_MOTION_ERROR_CODES) {
      expect(receive("set-motion-result", { requestId: "m8", ok: false, code, message: "No." }).ok).toBe(true);
    }
    expect(receive("set-motion-result", { requestId: "m8", ok: false, code: "field_not_media" }).ok).toBe(false);
  });
});
