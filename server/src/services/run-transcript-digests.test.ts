import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRunLogTranscriptDigest } from "@greatstone/adapter-utils/run-log-transcript";
import { parseClaudeStdoutLine } from "@greatstone/adapter-claude-local/ui";
import { HttpError, notFound } from "../errors.js";

const pluginStore = vi.hoisted(() => ({ getAdapterPluginByType: vi.fn() }));
vi.mock("./adapter-plugin-store.js", () => pluginStore);

const { createRunTranscriptDigester } = await import("./run-transcript-digests.js");
type RunTranscriptDigestDeps = import("./run-transcript-digests.js").RunTranscriptDigestDeps;

const record = (seq: number, line: unknown) =>
  JSON.stringify({ ts: `2026-09-30T18:00:0${seq}.000Z`, stream: "stdout", chunk: `${JSON.stringify(line)}\n`, seq });
const LOG = [
  record(1, { type: "acpx.tool_call", toolCallId: "t1", name: "Read", status: "pending", input: { file_path: "/Users/john/secret.ts" } }),
  record(2, { type: "acpx.tool_call", toolCallId: "t1", name: "Read", status: "completed", text: "token=abc123" }),
  record(3, { type: "acpx.result", inputTokens: 900, outputTokens: 100, stopReason: "end_turn" }),
].join("\n") + "\n";

const finished = {
  id: "run-1",
  companyId: "company-1",
  status: "succeeded",
  runtimeMode: "legacy",
  logBytes: LOG.length,
  logStore: "local_file",
  logRef: "logs/run-1.ndjson",
  adapterType: "claude_local",
};

function setup(content = LOG) {
  const readLog = vi.fn(async () => ({ content }));
  const redactForRun = vi.fn(async (_companyId: string, _runId: string, value: unknown) => value);
  return {
    readLog,
    redactForRun,
    digestRun: createRunTranscriptDigester({
      readLog,
      redactForRun: redactForRun as RunTranscriptDigestDeps["redactForRun"],
    }),
  };
}

describe("run transcript digests", () => {
  beforeEach(() => {
    pluginStore.getAdapterPluginByType.mockReset();
    pluginStore.getAdapterPluginByType.mockReturnValue(undefined);
  });

  it("digests the board's read window with the board's parser and keeps no content", async () => {
    const { readLog, redactForRun, digestRun } = setup();
    const digest = await digestRun(finished);

    expect(readLog).toHaveBeenCalledWith(finished, { offset: 0, limitBytes: 256_000 });
    expect(redactForRun).toHaveBeenCalledWith("company-1", "run-1", { content: LOG });
    expect(digest).toEqual(
      buildRunLogTranscriptDigest("run-1", LOG, { parseStdoutLine: parseClaudeStdoutLine }),
    );
    expect(digest?.map((entry) => entry.kind)).toEqual(["tool_call", "tool_call", "tool_result", "result"]);
    const json = JSON.stringify(digest);
    for (const secret of ["secret.ts", "abc123", "Read"]) expect(json).not.toContain(secret);
  });

  it("reads only the tail the board reads for a long log", async () => {
    const { readLog, digestRun } = setup();
    await digestRun({ ...finished, logBytes: 300_000 });
    expect(readLog).toHaveBeenCalledWith(expect.anything(), { offset: 44_000, limitBytes: 256_000 });
  });

  it("parses the redacted content", async () => {
    const redacted = record(1, { type: "acpx.status", text: "***" }) + "\n";
    const { redactForRun, digestRun } = setup();
    redactForRun.mockResolvedValueOnce({ content: redacted });
    expect((await digestRun(finished))?.map((entry) => entry.kind)).toEqual(["system"]);
  });

  it.each([
    ["a native run", { runtimeMode: "native" }],
    ["a live run", { status: "running" }],
    ["a board-only parser", { adapterType: "paperclip_runner" }],
    ["an unknown adapter", { adapterType: "custom_plugin" }],
  ])("leaves %s to the board's own log read", async (_label, change) => {
    const { readLog, digestRun } = setup();
    expect(await digestRun({ ...finished, ...change })).toBeNull();
    expect(readLog).not.toHaveBeenCalled();
  });

  it("leaves a type an external adapter can override to the board", async () => {
    pluginStore.getAdapterPluginByType.mockReturnValue({ packageName: "custom-claude" });
    const { readLog, digestRun } = setup();
    expect(await digestRun(finished)).toBeNull();
    expect(readLog).not.toHaveBeenCalled();
  });

  it("treats a missing log as an empty transcript, like the board's 404", async () => {
    const { readLog, digestRun } = setup();
    expect(await digestRun({ ...finished, logRef: null })).toEqual([]);
    expect(readLog).not.toHaveBeenCalled();
    readLog.mockRejectedValueOnce(notFound("Run log not found"));
    expect(await digestRun({ ...finished, id: "run-2" })).toEqual([]);
  });

  it("returns no digest when the read fails for another reason", async () => {
    const { readLog, digestRun } = setup();
    readLog.mockRejectedValueOnce(new HttpError(500, "disk unavailable"));
    expect(await digestRun(finished)).toBeNull();
  });

  it("reuses a finished run's digest until its log size changes", async () => {
    const { readLog, digestRun } = setup();
    await digestRun(finished);
    await digestRun(finished);
    expect(readLog).toHaveBeenCalledTimes(1);
    await digestRun({ ...finished, logBytes: LOG.length + 1 });
    expect(readLog).toHaveBeenCalledTimes(2);
  });
});
