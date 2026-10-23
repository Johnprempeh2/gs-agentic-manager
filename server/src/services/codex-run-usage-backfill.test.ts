import { describe, expect, it } from "vitest";
import { rolloutThreadId, sumRolloutUsageInWindow } from "./codex-run-usage-backfill.js";

const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const tokenCount = (timestamp: string, total: object, last: object) =>
  JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });

// Numbers of a real three-request Codex ACP turn (23 Oct 2026), plus one
// re-sent unchanged update and a later request outside the run.
const rollout = [
  JSON.stringify({ timestamp: "2026-10-23T17:30:57.000Z", type: "session_meta", payload: {} }),
  tokenCount("2026-10-23T17:31:01.000Z", usage(22861, 13056, 38), usage(22861, 13056, 38)),
  tokenCount("2026-10-23T17:31:03.000Z", usage(22861, 13056, 38), usage(22861, 13056, 38)),
  tokenCount("2026-10-23T17:31:05.000Z", usage(45817, 35840, 60), usage(22956, 22784, 22)),
  tokenCount("2026-10-23T17:31:08.000Z", usage(68852, 58624, 65), usage(23035, 22784, 5)),
  tokenCount("2026-10-23T17:40:00.000Z", usage(91000, 81000, 70), usage(22148, 22376, 5)),
].join("\n");

describe("sumRolloutUsageInWindow", () => {
  it("sums every request of the run window once, cached inside input", () => {
    expect(sumRolloutUsageInWindow(rollout, "2026-10-23T17:30:57Z", "2026-10-23T17:31:10Z")).toEqual({
      inputTokens: 68852,
      cachedInputTokens: 58624,
      outputTokens: 65,
      requests: 3,
    });
  });

  it("ignores requests outside the window and returns null when none match", () => {
    expect(sumRolloutUsageInWindow(rollout, "2026-10-23T17:39:00Z", "2026-10-23T17:41:00Z")?.requests).toBe(1);
    expect(sumRolloutUsageInWindow(rollout, "2026-10-24T00:00:00Z", "2026-10-24T01:00:00Z")).toBeNull();
  });

  it("counts every request after the session counter restarts", () => {
    const restarted = [
      tokenCount("2026-10-23T10:00:00Z", usage(5000, 4000, 10), usage(5000, 4000, 10)),
      tokenCount("2026-10-23T10:05:00Z", usage(3000, 2000, 5), usage(3000, 2000, 5)),
    ].join("\n");
    expect(sumRolloutUsageInWindow(restarted, "2026-10-23T10:00:00Z", "2026-10-23T10:10:00Z")).toEqual({
      inputTokens: 8000,
      cachedInputTokens: 6000,
      outputTokens: 15,
      requests: 2,
    });
  });
});

describe("rolloutThreadId", () => {
  it("reads the thread id from a rollout file name", () => {
    expect(rolloutThreadId("rollout-2026-10-23T18-30-57-01a169d0-da99-7632-9eca-8d3407590cf4.jsonl")).toBe(
      "01a169d0-da99-7632-9eca-8d3407590cf4",
    );
    expect(rolloutThreadId("notes.jsonl")).toBeNull();
  });
});
