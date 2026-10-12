/**
 * Chunk-merge / seq-dedupe primitives shared by the live run transcript view
 * (`useLiveRunTranscripts`) and the summary draft stream (`useSummaryDraftStream`).
 * They live with the transcript build in adapter-utils so the server's
 * transcript digest reads a log exactly as these consumers do.
 */
export {
  TRIMMED_OUTPUT_MARKER_TEXT,
  applyRetentionBudget,
  isStructuredStreamingTextDelta,
  isTrimmedOutputMarkerChunk,
  mergeRunLogChunks,
  parsePersistedLogContent,
  readChunkSeq,
} from "@greatstone/adapter-utils/run-log-transcript";
export type {
  ChunkMergeRefs,
  ChunkRetentionBudget,
  IncomingRunLogChunk,
} from "@greatstone/adapter-utils/run-log-transcript";
