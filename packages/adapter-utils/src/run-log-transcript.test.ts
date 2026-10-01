import { describe, expect, it } from "vitest";
import {
  buildRunLogTranscriptDigest,
  buildTranscript,
  digestTranscript,
  mergeRunLogChunks,
  parsePersistedLogContent,
  TASK_VIEW_MAX_BYTES_PER_RUN,
} from "./run-log-transcript.js";
import { parseAcpxStdoutLine } from "./acpx-engine/ui.js";
import type { TranscriptEntry } from "./types.js";

describe("digestTranscript", () => {
  it("keeps whether each text was empty, blank or present, and nothing else of it", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: "t1", text: "The answer is 42.", channel: "final", delta: true, itemId: "m1" },
      { kind: "thinking", ts: "t2", text: "", lifecycle: "completed" },
      { kind: "stderr", ts: "t3", text: "  \n" },
      { kind: "tool_result", ts: "t4", toolUseId: "u1", toolName: "Bash", content: "rm -rf /tmp/x", isError: true },
    ];
    expect(digestTranscript(entries)).toEqual([
      { kind: "assistant", ts: "t1", text: "·", channel: "final", delta: true, itemId: "m1" },
      { kind: "thinking", ts: "t2", text: "", lifecycle: "completed" },
      { kind: "stderr", ts: "t3", text: " " },
      { kind: "tool_result", ts: "t4", toolUseId: "u1", content: "·", isError: true },
    ]);
  });

  it("declines runner protocol entries so the board reads the full log", () => {
    expect(digestTranscript([
      { kind: "run_terminal", ts: "t1", turnState: "completed", runState: "succeeded", disposition: "done" },
    ])).toBeNull();
  });

  it("digests one log read exactly as the board would transcribe it", () => {
    const record = (seq: number, chunk: string) =>
      JSON.stringify({ ts: `2026-09-30T18:00:0${seq}.000Z`, stream: "stdout", chunk, seq });
    const line = `${JSON.stringify({ type: "acpx.tool_call", toolCallId: "t1", name: "Read", status: "completed", text: "ok" })}\n`;
    // A tail read starts mid-record and a stdout line can span two records.
    const content = [
      "partial-record-from-an-earlier-offset\"}",
      record(1, line.slice(0, 15)),
      record(2, line.slice(15)),
      JSON.stringify({ ts: "2026-09-30T18:00:03.000Z", stream: "stderr", chunk: "warning\n", seq: 3 }),
    ].join("\n") + "\n";
    const { chunks } = mergeRunLogChunks(
      "run-1",
      [],
      parsePersistedLogContent("run-1", content, new Map()),
      { seenChunkKeys: new Set(), trimmedSeqFloorByRun: new Map() },
      { maxBytes: TASK_VIEW_MAX_BYTES_PER_RUN, collapseTrimmed: true },
    );
    const digest = buildRunLogTranscriptDigest("run-1", content, parseAcpxStdoutLine);
    expect(digest).toEqual(digestTranscript(buildTranscript(chunks, parseAcpxStdoutLine)));
    expect(digest?.map((entry) => [entry.kind, entry.ts])).toEqual([
      ["tool_call", "2026-09-30T18:00:02.000Z"],
      ["tool_result", "2026-09-30T18:00:02.000Z"],
      ["stderr", "2026-09-30T18:00:03.000Z"],
    ]);
  });
});
