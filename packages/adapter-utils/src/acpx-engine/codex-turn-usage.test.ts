import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeAcpxTurnUsage } from "./execute.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

type TokenCount = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
type TokenUsageEvent = { total: TokenCount; last: TokenCount };

// Real Codex token_count events (numbers only) from local Codex CLI sessions.
const fixture = JSON.parse(
  readFileSync(path.join(here, "__fixtures__/codex-token-count-events.json"), "utf8"),
) as {
  multiRequestTurn: TokenUsageEvent[];
  turnWithRepeatedUpdate: TokenUsageEvent[];
  counterRestart: { before: TokenUsageEvent[]; after: TokenUsageEvent[] };
};

// codex-acp's own conversion: its inputTokens exclude cached reads.
function toTokenCount(usage: TokenCount): TokenCount {
  return { ...usage, inputTokens: usage.inputTokens - usage.cachedInputTokens };
}
function toPromptUsage(count: TokenCount) {
  return {
    totalTokens: count.totalTokens,
    inputTokens: count.inputTokens,
    cachedReadTokens: count.cachedInputTokens,
    outputTokens: count.outputTokens,
    thoughtTokens: count.reasoningOutputTokens,
  };
}

/** Load the accumulator exactly as shipped in the codex-acp patch. */
function loadPatchedAccumulator() {
  const patch = readFileSync(
    path.join(repoRoot, "patches/@agentclientprotocol__codex-acp@1.6.2.patch"),
    "utf8",
  ).split("\n");
  const start = patch.findIndex((line) => line.startsWith("+function paperclipAccumulateTurnUsage("));
  expect(start).toBeGreaterThan(-1);
  const body: string[] = [];
  for (let i = start; i < patch.length && patch[i]!.startsWith("+"); i += 1) body.push(patch[i]!.slice(1));
  const source = `${body.join("\n")}\n}\nreturn paperclipAccumulateTurnUsage;`;
  return new Function("toTokenCount", source)(toTokenCount) as (
    state: Record<string, unknown>,
    tokenUsage: TokenUsageEvent,
  ) => void;
}

const accumulate = loadPatchedAccumulator();

/** One ACP prompt: codex-acp clears the turn fields, then folds every update. */
function runTurn(state: Record<string, unknown>, events: TokenUsageEvent[]): TokenCount | null {
  state.paperclipTurnUsage = null;
  state.paperclipTurnRawUsage = null;
  for (const event of events) accumulate(state, event);
  return (state.paperclipTurnUsage as TokenCount | null) ?? null;
}

describe("codex-acp patch: turn usage covers every model request", () => {
  it("sums a real 30-request turn to the session total delta, not the last request", () => {
    const events = fixture.multiRequestTurn;
    expect(events).toHaveLength(30);
    const turn = runTurn({}, events)!;
    const end = events.at(-1)!.total;
    // Fresh session, so the delta is the end total itself.
    expect(turn).toEqual(toTokenCount(end));
    expect(turn.totalTokens).toBe(2_273_660);
    // Stock codex-acp reported only this.
    expect(events.at(-1)!.last.totalTokens).toBe(89_072);
  });

  it("counts a re-sent unchanged update once", () => {
    const events = fixture.turnWithRepeatedUpdate;
    expect(events[0]!.total).toEqual(events[1]!.total);
    const state: Record<string, unknown> = {};
    const turn = runTurn(state, events)!;
    expect(turn.totalTokens).toBe(events[0]!.last.totalTokens + events[2]!.last.totalTokens);
  });

  it("matches the total delta for a turn that follows an earlier one in the same process", () => {
    const state: Record<string, unknown> = {};
    const events = fixture.multiRequestTurn;
    runTurn(state, events.slice(0, 10));
    const second = runTurn(state, events.slice(10))!;
    const before = events[9]!.total;
    const after = events.at(-1)!.total;
    expect(second.totalTokens).toBe(after.totalTokens - before.totalTokens);
    expect(second.outputTokens).toBe(after.outputTokens - before.outputTokens);
  });

  it("uses the post value alone when the session counter restarts", () => {
    const state: Record<string, unknown> = {};
    runTurn(state, fixture.counterRestart.before);
    const turn = runTurn(state, fixture.counterRestart.after)!;
    const after = fixture.counterRestart.after.at(-1)!;
    // The restarted total is below a naive delta's assumption; the run is its own total.
    expect(turn.totalTokens).toBe(after.total.totalTokens);
  });

  it("keeps counting when the counter drops mid-turn", () => {
    const zero = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    const usage = (input: number, cached: number, output: number) => ({
      ...zero,
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
    });
    const turn = runTurn({}, [
      { total: usage(50_000, 40_000, 100), last: usage(10_000, 8_000, 50) },
      { total: usage(12_000, 9_000, 60), last: usage(12_000, 9_000, 60) },
    ])!;
    expect(turn).toEqual(toTokenCount(usage(22_000, 17_000, 110)));
  });
});

describe("summarizeAcpxTurnUsage for Codex", () => {
  const events = fixture.multiRequestTurn;
  const turnTotal = toPromptUsage(runTurn({}, events)!);
  const lastOnly = toPromptUsage(toTokenCount(events.at(-1)!.last));

  it("stores the whole turn with cached reads inside input (OpenAI convention)", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: { usage: { cumulative: turnTotal } },
      eventBreakdown: turnTotal,
      eventCostUsd: null,
      acpxAgent: "codex",
    });
    expect(summary.usage).toEqual({
      inputTokens: 2_261_868,
      cachedInputTokens: 2_167_296,
      outputTokens: 11_792,
    });
    expect(summary.usageCompleteness).toBeNull();
  });

  it("marks a Codex run partial when only the last request was reported", () => {
    // Stock codex-acp: usage_update carries no breakdown and the prompt
    // response holds one request.
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: { usage: { cumulative: lastOnly } },
      eventBreakdown: null,
      eventCostUsd: null,
      acpxAgent: "codex",
    });
    expect(summary.usage).toEqual({ inputTokens: 88_911, cachedInputTokens: 88_576, outputTokens: 161 });
    expect(summary.usageCompleteness).toBe("partial");
  });

  it("leaves Claude usage unchanged", () => {
    const breakdown = { inputTokens: 40, outputTokens: 700, cachedReadTokens: 60, cachedWriteTokens: 5 };
    for (const acpxAgent of ["claude", undefined]) {
      const summary = summarizeAcpxTurnUsage({
        preStatus: null,
        postStatus: { usage: { cumulative: breakdown } },
        eventBreakdown: null,
        eventCostUsd: null,
        acpxAgent,
      });
      expect(summary.usage).toEqual({ inputTokens: 45, outputTokens: 700, cachedInputTokens: 60 });
      expect(summary.usageCompleteness).toBeNull();
    }
  });
});
