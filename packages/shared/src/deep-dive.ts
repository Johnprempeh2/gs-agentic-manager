/**
 * Deep Dive vocabulary (Greatstone Method, Book V). Method vocabulary only:
 * never client data. The record lives in Cases: one `deep_dive` record case,
 * nine `deep_dive_stream` cases (one per Investigation Stream) and five GIF
 * documents on each stream.
 */

export const DEEP_DIVE_CASE_TYPES = {
  record: "deep_dive",
  stream: "deep_dive_stream",
  blueprint: "agent_team_blueprint",
} as const;

/** Key of the single record case per company. */
export const DEEP_DIVE_RECORD_KEY = "record";

/** Documents on the record case. */
export const DEEP_DIVE_RECORD_DOCUMENTS = [
  { key: "north-star", label: "North Star", prompt: "The chief executive's words, who said them and when." },
  { key: "scope", label: "Scope", prompt: "What the deep dive covers (Book V, Ch 6)." },
  { key: "success-criteria", label: "Success criteria", prompt: "How we will know the deep dive succeeded (Book V, Ch 10)." },
] as const;

/** The nine Investigation Streams (Book V, Ch 7) and the chapters that conduct them (Part III). */
export const DEEP_DIVE_STREAMS = [
  { key: "leadership", label: "Leadership", conductedThrough: "Ch 11 Executive Interviews, Ch 12 Leadership Investigation" },
  { key: "business", label: "Business", conductedThrough: "Ch 13 Process Investigation (no chapter of its own)" },
  { key: "operations", label: "Operations", conductedThrough: "Ch 13 Process Investigation" },
  { key: "people", label: "People", conductedThrough: "Ch 18 People Investigation" },
  { key: "technology", label: "Technology", conductedThrough: "Ch 14 Technology Investigation" },
  { key: "data", label: "Data", conductedThrough: "Ch 15 Data Investigation" },
  { key: "governance", label: "Governance", conductedThrough: "Ch 16 Governance Investigation" },
  { key: "customer-experience", label: "Customer experience", conductedThrough: "Ch 17 Customer Investigation" },
  { key: "innovation-ai", label: "Innovation and Artificial Intelligence", conductedThrough: "Ch 19 Innovation and AI Investigation" },
] as const;

export type DeepDiveStreamKey = (typeof DEEP_DIVE_STREAMS)[number]["key"];

/**
 * The five GIF questions. `key` is the stream's `knowledge` field key;
 * `documentKey` is the stream case document holding the answer.
 */
export const DEEP_DIVE_GIF = [
  { key: "current-state", documentKey: "gif-current-state", label: "Current state", question: "What exists today?" },
  { key: "evidence", documentKey: "gif-evidence", label: "Evidence", question: "What objectively supports this understanding?" },
  { key: "business-impact", documentKey: "gif-business-impact", label: "Business impact", question: "Why does it matter?" },
  { key: "future-state", documentKey: "gif-future-state", label: "Future state", question: "What capability should exist?" },
  { key: "transformation-opportunity", documentKey: "gif-transformation-opportunity", label: "Transformation opportunity", question: "What should change?" },
] as const;

export type DeepDiveGifKey = (typeof DEEP_DIVE_GIF)[number]["key"];

export const DEEP_DIVE_STREAM_STATUSES = ["not_started", "under_way", "examined", "blocked"] as const;
export type DeepDiveStreamStatus = (typeof DEEP_DIVE_STREAM_STATUSES)[number];

/** Streams are never dropped, only reduced in depth with a named reason (Ch 7). */
export const DEEP_DIVE_DEPTHS = ["full", "reduced"] as const;
export type DeepDiveDepth = (typeof DEEP_DIVE_DEPTHS)[number];

/** Internal is the default; nothing is created Shared. */
export const DEEP_DIVE_VISIBILITIES = ["internal", "shared"] as const;
export type DeepDiveVisibility = (typeof DEEP_DIVE_VISIBILITIES)[number];

/** Place the known, validate the indicated, investigate only the unknown. Only a person sets Known. */
export const DEEP_DIVE_KNOWLEDGE = ["known", "indicated", "unknown"] as const;
export type DeepDiveKnowledge = (typeof DEEP_DIVE_KNOWLEDGE)[number];

export const DEEP_DIVE_LABELS: Record<DeepDiveStreamStatus | DeepDiveDepth | DeepDiveVisibility | DeepDiveKnowledge, string> = {
  not_started: "Not started",
  under_way: "Under way",
  examined: "Examined",
  blocked: "Blocked",
  full: "Full",
  reduced: "Reduced",
  internal: "Internal",
  shared: "Shared",
  known: "Known",
  indicated: "Indicated",
  unknown: "Unknown",
};

/** The `fields` object of a stream case, always written whole. */
export interface DeepDiveStreamFields {
  stream: DeepDiveStreamKey;
  status: DeepDiveStreamStatus;
  depth: DeepDiveDepth;
  depthReason: string;
  visibility: DeepDiveVisibility;
  knowledge: Record<DeepDiveGifKey, DeepDiveKnowledge>;
}

export function defaultDeepDiveStreamFields(stream: DeepDiveStreamKey): DeepDiveStreamFields {
  return {
    stream,
    status: "not_started",
    depth: "full",
    depthReason: "",
    visibility: "internal",
    knowledge: Object.fromEntries(DEEP_DIVE_GIF.map((gif) => [gif.key, "unknown"])) as Record<DeepDiveGifKey, DeepDiveKnowledge>,
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Read stream fields defensively: anything missing or unrecognised falls back
 * to the default (Unknown, Internal), never to Known or Shared.
 */
export function readDeepDiveStreamFields(stream: DeepDiveStreamKey, raw: Record<string, unknown> | null | undefined): DeepDiveStreamFields {
  const fallback = defaultDeepDiveStreamFields(stream);
  const source = raw ?? {};
  const rawKnowledge = (source.knowledge ?? {}) as Record<string, unknown>;
  return {
    stream,
    status: pick(source.status, DEEP_DIVE_STREAM_STATUSES, fallback.status),
    depth: pick(source.depth, DEEP_DIVE_DEPTHS, fallback.depth),
    depthReason: typeof source.depthReason === "string" ? source.depthReason : "",
    visibility: pick(source.visibility, DEEP_DIVE_VISIBILITIES, fallback.visibility),
    knowledge: Object.fromEntries(
      DEEP_DIVE_GIF.map((gif) => [gif.key, pick(rawKnowledge[gif.key], DEEP_DIVE_KNOWLEDGE, "unknown")]),
    ) as Record<DeepDiveGifKey, DeepDiveKnowledge>,
  };
}

/** The stub body for a missing GIF document: only a heading and the question. */
export function deepDiveGifStubBody(gif: (typeof DEEP_DIVE_GIF)[number]): string {
  return `# ${gif.label}\n\n${gif.question}\n`;
}
