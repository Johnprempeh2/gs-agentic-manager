// The persisted run log to transcript pipeline. The task thread (browser) and
// the transcript digest route (server) run this same code, so a digest built on
// the server holds the same entries, in the same order, as the transcript the
// browser builds from the full log.
import { redactHomePathUserSegments, redactTranscriptEntryPaths } from "./log-redaction.js";
import type { StdoutLineParser, TranscriptEntry } from "./types.js";

export interface StatefulStdoutParser {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
}

export interface TranscriptParserSource {
  parseStdoutLine: (line: string, ts: string) => TranscriptEntry[];
  createStdoutParser?: () => StatefulStdoutParser;
}

/** One persisted read of a run log: the tail the task thread asks for. */
export const RUN_LOG_READ_LIMIT_BYTES = 256_000;
/**
 * Retained transcript payload budget per run in full task views. A byte budget
 * (rather than a tiny chunk count) keeps the whole streamed scrollback intact:
 * a delta-streaming run emits thousands of one-token chunks in seconds, and the
 * old 200-chunk cap discarded just-rendered messages off the top irreversibly.
 * If a run genuinely exceeds this, the oldest output collapses behind a visible
 * marker instead of vanishing (see `applyRetentionBudget`).
 */
export const TASK_VIEW_MAX_BYTES_PER_RUN = 2_000_000;

export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string; seq?: number };
type TranscriptBuildOptions = { censorUsernameInLogs?: boolean };
type RedactionOptions = { enabled: boolean };

function resolveStdoutParser(source: StdoutLineParser | TranscriptParserSource) {
  if (typeof source === "function") {
    return { parseLine: source, reset: null as (() => void) | null };
  }
  if (source.createStdoutParser) {
    const parser = source.createStdoutParser();
    return { parseLine: parser.parseLine, reset: parser.reset };
  }
  return { parseLine: source.parseStdoutLine, reset: null as (() => void) | null };
}

export function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
    const last = entries[entries.length - 1];
    if (
      last &&
      last.kind === entry.kind &&
      last.delta &&
      last.channel === entry.channel
    ) {
      last.text += entry.text;
      last.ts = entry.ts;
      return;
    }
  }
  entries.push(entry);
}

export function appendTranscriptEntries(entries: TranscriptEntry[], incoming: TranscriptEntry[]) {
  for (const entry of incoming) {
    appendTranscriptEntry(entries, entry);
  }
}

function truncateTranscriptLine(line: string, maxLength = 160) {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - 3)}...`;
}

function formatTranscriptParserError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createTranscriptParseErrorEntry(
  line: string,
  ts: string,
  error: unknown,
  redactionOptions: RedactionOptions,
): TranscriptEntry {
  const errorText = formatTranscriptParserError(error) || "unknown parser error";
  const preview = truncateTranscriptLine(line);
  return {
    kind: "result",
    ts,
    text: redactHomePathUserSegments(
      `Chat transcript error: ${errorText}. Falling back for line: ${preview}`,
      redactionOptions,
    ),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    subtype: "transcript_parse_error",
    isError: true,
    errors: [],
  };
}

function appendParsedTranscriptLine(args: {
  entries: TranscriptEntry[];
  line: string;
  ts: string;
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: (() => void) | null;
  redactionOptions: RedactionOptions;
}) {
  const { entries, line, ts, parseLine, reset, redactionOptions } = args;
  try {
    appendTranscriptEntries(
      entries,
      parseLine(line, ts).map((entry) => redactTranscriptEntryPaths(entry, redactionOptions)),
    );
  } catch (error) {
    reset?.();
    appendTranscriptEntry(entries, createTranscriptParseErrorEntry(line, ts, error, redactionOptions));
  }
}

export function buildTranscript(
  chunks: RunLogChunk[],
  parserSource: StdoutLineParser | TranscriptParserSource,
  opts?: TranscriptBuildOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";
  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };
  const { parseLine, reset } = resolveStdoutParser(parserSource);

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      entries.push({ kind: "stderr", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }
    if (chunk.stream === "system") {
      entries.push({ kind: "system", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      appendParsedTranscriptLine({
        entries,
        line: trimmed,
        ts: chunk.ts,
        parseLine,
        reset,
        redactionOptions,
      });
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    appendParsedTranscriptLine({
      entries,
      line: trailing,
      ts,
      parseLine,
      reset,
      redactionOptions,
    });
  }

  reset?.();

  return entries;
}

/**
 * Chunk-merge / seq-dedupe primitives shared by the live run transcript view
 * (`useLiveRunTranscripts`) and the summary draft stream (`useSummaryDraftStream`).
 *
 * Both consumers ingest the same run-log records from two transports (the
 * persisted offset-read poller and the company events WebSocket), which
 * interleave and re-deliver records. This module centralizes the ordering and
 * de-duplication rules so the two hooks cannot drift apart. The server's
 * transcript digest reads a finished log through the same rules.
 */

export type IncomingRunLogChunk = RunLogChunk & { dedupeKey: string };

/**
 * Per-consumer merge state. `seenChunkKeys` is shared across every run tracked
 * by a single consumer (bounded + cleared past a cap); `trimmedSeqFloorByRun`
 * records, per run, the highest sequenced chunk that has been trimmed out of the
 * retained window so re-delivered older records are dropped rather than
 * re-inserted ahead of newer output.
 */
export interface ChunkMergeRefs {
  seenChunkKeys: Set<string>;
  trimmedSeqFloorByRun: Map<string, number>;
}

const SEEN_CHUNK_KEY_CAP = 12000;

/**
 * Retention budget for a run's kept chunk window. Task views pass a byte budget
 * with `collapseTrimmed` so the just-rendered scrollback is retained and, when
 * the budget is genuinely exceeded, the oldest content collapses behind a
 * visible marker instead of silently vanishing midstream. Compact consumers
 * (dashboard tickers, summary draft) keep the historical chunk-count cap by
 * passing a bare number, which discards silently as before.
 */
export interface ChunkRetentionBudget {
  /** Hard ceiling on retained chunk count. */
  maxChunks?: number;
  /** Soft ceiling on retained chunk payload size (UTF-16 code units ≈ bytes). */
  maxBytes?: number;
  /**
   * When true, trimming leaves a single visible "earlier output trimmed" marker
   * at the head so collapsed content never disappears without a trace. When
   * false (the default for count-only callers), trimming is silent.
   */
  collapseTrimmed?: boolean;
}

/**
 * Text of the synthetic system chunk that marks where older output was
 * collapsed out of the retained window. Rendered as an ordinary system line by
 * `buildTranscript`, so the affordance is adapter-agnostic.
 */
export const TRIMMED_OUTPUT_MARKER_TEXT =
  "⋯ earlier output trimmed to stay within the live transcript buffer ⋯";

export function isTrimmedOutputMarkerChunk(chunk: RunLogChunk): boolean {
  return (
    chunk.stream === "system" &&
    chunk.chunk === TRIMMED_OUTPUT_MARKER_TEXT &&
    chunk.seq === undefined
  );
}

function makeTrimmedOutputMarkerChunk(ts: string): RunLogChunk {
  return { ts, stream: "system", chunk: TRIMMED_OUTPUT_MARKER_TEXT };
}

function chunkRetainedSize(chunk: RunLogChunk): number {
  return chunk.chunk.length;
}

function normalizeRetentionBudget(budget: number | ChunkRetentionBudget): ChunkRetentionBudget {
  return typeof budget === "number" ? { maxChunks: budget } : budget;
}

/**
 * Trim a run's retained window to its budget. Byte-budget trimming keeps the
 * newest chunks and (when `collapseTrimmed`) prepends one marker so the
 * scrollback shows earlier output was collapsed rather than silently dropped.
 * Returns the highest sequenced chunk actually removed so callers can raise the
 * trimmed-seq floor and drop re-delivered older records.
 */
export function applyRetentionBudget(
  chunks: RunLogChunk[],
  budget: ChunkRetentionBudget,
): { chunks: RunLogChunk[]; trimmedSeq: number | null } {
  const { maxChunks, maxBytes, collapseTrimmed } = budget;

  // Peel off any existing marker so it is never counted or duplicated; a single
  // marker is re-added below if trimming is (still) in effect.
  const hadMarker = chunks.length > 0 && isTrimmedOutputMarkerChunk(chunks[0]!);
  const real = hadMarker ? chunks.slice(1) : chunks;

  let removeCount = 0;
  if (typeof maxChunks === "number" && real.length > maxChunks) {
    removeCount = real.length - maxChunks;
  }
  if (typeof maxBytes === "number") {
    let totalBytes = 0;
    for (const chunk of real) totalBytes += chunkRetainedSize(chunk);
    let byteRemove = 0;
    // Always keep the newest chunk even if it alone exceeds the byte budget.
    while (byteRemove < real.length - 1 && totalBytes > maxBytes) {
      totalBytes -= chunkRetainedSize(real[byteRemove]!);
      byteRemove += 1;
    }
    if (byteRemove > removeCount) removeCount = byteRemove;
  }

  if (removeCount <= 0) {
    // Nothing new to trim. Preserve an existing marker so an earlier collapse
    // keeps its trace; otherwise return the marker-stripped array only if we
    // actually stripped one (we never had a real trim to justify keeping it).
    if (hadMarker) return { chunks, trimmedSeq: null };
    return { chunks: real, trimmedSeq: null };
  }

  const removed = real.slice(0, removeCount);
  const kept = real.slice(removeCount);

  let trimmedSeq: number | null = null;
  for (const item of removed) {
    if (typeof item.seq === "number" && (trimmedSeq === null || item.seq > trimmedSeq)) {
      trimmedSeq = item.seq;
    }
  }

  if (collapseTrimmed || hadMarker) {
    const markerTs = kept[0]?.ts ?? removed[removed.length - 1]!.ts;
    return { chunks: [makeTrimmedOutputMarkerChunk(markerTs), ...kept], trimmedSeq };
  }
  return { chunks: kept, trimmedSeq };
}

export function readChunkSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isStructuredStreamingTextDelta(chunk: string): boolean {
  return /"type"\s*:\s*"(?:acpx\.text_delta|text)"/.test(chunk);
}

/**
 * Parse a raw persisted-log slice into ordered chunks. `pendingByRun` carries a
 * partial trailing line across offset reads so a record split across a read
 * boundary is not dropped.
 */
export function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
): IncomingRunLogChunk[] {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${content}`;
  const split = combined.split("\n");
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const parsed: IncomingRunLogChunk[] = [];
  for (const line of split) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown; seq?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({
        ts,
        stream,
        chunk,
        seq: readChunkSeq(raw.seq),
        dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
      });
    } catch {
      // Ignore malformed log rows.
    }
  }

  return parsed;
}

/**
 * Merge incoming chunks into a run's retained window, preserving emit order and
 * de-duplicating across the two delivery transports. Returns the same array
 * reference when nothing changed so callers can bail out of React state updates.
 *
 * Ordering rules (unchanged from the original `useLiveRunTranscripts`
 * implementation):
 * - Sequenced chunks dedupe/order by the server-assigned monotonic `seq`. When
 *   the same `seq` arrives from both transports the longer payload wins (the
 *   websocket copy may be tail-truncated). Records at or below the trimmed
 *   floor are dropped.
 * - Unsequenced chunks dedupe by content key (skipping structured streaming
 *   text deltas, which legitimately repeat) and act as an ordering barrier for
 *   subsequent sequenced inserts.
 */
export function mergeRunLogChunks(
  runId: string,
  prevChunks: RunLogChunk[],
  incoming: IncomingRunLogChunk[],
  refs: ChunkMergeRefs,
  budget: number | ChunkRetentionBudget,
): { chunks: RunLogChunk[]; changed: boolean } {
  if (incoming.length === 0) return { chunks: prevChunks, changed: false };

  const existing = [...prevChunks];
  let changed = false;

  for (const chunk of incoming) {
    if (typeof chunk.seq === "number") {
      const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
      if (chunk.seq <= seqFloor) continue;
      const duplicateAt = existing.findIndex((item) => item.seq === chunk.seq);
      if (duplicateAt !== -1) {
        // Same record arrived via the other delivery path. Prefer the longer
        // payload: websocket chunks may be tail-truncated while the persisted
        // row is complete.
        if (chunk.chunk.length > existing[duplicateAt]!.chunk.length) {
          existing[duplicateAt] = { ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk, seq: chunk.seq };
          changed = true;
        }
        continue;
      }
      // Insert in seq order relative to the trailing sequenced chunks so
      // late-arriving records from the slower delivery path land where they
      // were emitted. Unsequenced chunks act as an ordering barrier.
      let insertAt = existing.length;
      while (insertAt > 0) {
        const prior = existing[insertAt - 1]!;
        if (typeof prior.seq !== "number" || prior.seq < chunk.seq) break;
        insertAt -= 1;
      }
      existing.splice(insertAt, 0, { ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk, seq: chunk.seq });
      changed = true;
      continue;
    }

    if (!isStructuredStreamingTextDelta(chunk.chunk)) {
      if (refs.seenChunkKeys.has(chunk.dedupeKey)) continue;
      refs.seenChunkKeys.add(chunk.dedupeKey);
    }
    existing.push({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk });
    changed = true;
  }

  if (!changed) return { chunks: prevChunks, changed: false };
  if (refs.seenChunkKeys.size > SEEN_CHUNK_KEY_CAP) {
    refs.seenChunkKeys.clear();
  }

  const { chunks: retained, trimmedSeq } = applyRetentionBudget(existing, normalizeRetentionBudget(budget));
  if (trimmedSeq !== null) {
    const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
    if (trimmedSeq > seqFloor) refs.trimmedSeqFloorByRun.set(runId, trimmedSeq);
  }

  return { chunks: retained, changed: true };
}

// ---------------------------------------------------------------------------
// Transcript digest: the structure of a finished run without its content.
// ---------------------------------------------------------------------------

/**
 * Keep only whether a string was empty, blank or present. Thread logic reads
 * `!text` and `text.trim()`, never the words, for a settled run's folded row.
 */
function textShape(text: string | undefined | null): string {
  if (!text) return "";
  return text.trim() ? "·" : " ";
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * Structure-only copy of a finished run's transcript. Every entry keeps its
 * kind, timestamp, ids, channel, lifecycle, token counts and the shape of its
 * text; tool input, tool output, names and all prose are dropped. A task
 * thread assembled from the digest has the same folded rows, counts and
 * markers as one assembled from the full log, because those read only the
 * fields kept here. Returns null when an entry kind is outside this set, so
 * the caller falls back to the full log.
 */
export function digestTranscript(entries: readonly TranscriptEntry[]): TranscriptEntry[] | null {
  const digest: TranscriptEntry[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "assistant":
        digest.push({
          kind: "assistant",
          ts: entry.ts,
          text: textShape(entry.text),
          ...optional("delta", entry.delta),
          ...optional("channel", entry.channel),
          ...optional("itemId", entry.itemId),
        });
        break;
      case "thinking":
        digest.push({
          kind: "thinking",
          ts: entry.ts,
          text: textShape(entry.text),
          ...optional("delta", entry.delta),
          ...optional("lifecycle", entry.lifecycle),
          ...optional("channel", entry.channel),
          ...optional("itemId", entry.itemId),
        });
        break;
      case "tool_call":
        digest.push({
          kind: "tool_call",
          ts: entry.ts,
          name: "",
          input: null,
          ...optional("toolUseId", entry.toolUseId),
          ...optional("invocationId", entry.invocationId),
          ...optional("actionRequestId", entry.actionRequestId),
        });
        break;
      case "tool_result":
        digest.push({
          kind: "tool_result",
          ts: entry.ts,
          toolUseId: entry.toolUseId,
          content: textShape(entry.content),
          isError: entry.isError,
          ...optional("delta", entry.delta),
        });
        break;
      case "result":
        digest.push({
          kind: "result",
          ts: entry.ts,
          text: textShape(entry.text),
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cachedTokens: entry.cachedTokens,
          costUsd: entry.costUsd,
          subtype: entry.subtype,
          isError: entry.isError,
          errors: [],
        });
        break;
      case "init":
        digest.push({ kind: "init", ts: entry.ts, model: "", sessionId: "" });
        break;
      case "diff":
        digest.push({ kind: "diff", ts: entry.ts, changeType: entry.changeType, text: textShape(entry.text) });
        break;
      case "user":
      case "stderr":
      case "system":
      case "stdout":
        digest.push({ kind: entry.kind, ts: entry.ts, text: textShape(entry.text) });
        break;
      default:
        // Runner protocol entries carry identity in their payloads.
        return null;
    }
  }
  return digest;
}

/**
 * Digest one persisted read of a finished run's log exactly as the task thread
 * would build it: the same record parse, merge, transcript build and parser.
 */
export function buildRunLogTranscriptDigest(
  runId: string,
  content: string,
  parserSource: StdoutLineParser | TranscriptParserSource,
): TranscriptEntry[] | null {
  const { chunks } = mergeRunLogChunks(
    runId,
    [],
    parsePersistedLogContent(runId, content, new Map()),
    { seenChunkKeys: new Set(), trimmedSeqFloorByRun: new Map() },
    { maxBytes: TASK_VIEW_MAX_BYTES_PER_RUN, collapseTrimmed: true },
  );
  return digestTranscript(buildTranscript(chunks, parserSource));
}
