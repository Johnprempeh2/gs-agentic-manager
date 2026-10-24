import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import {
  agentMaxConcurrentRuns,
  describeTaskRunState,
  deriveTaskRunState,
  deriveTaskRunStates,
  formatRunDuration,
} from "./task-run-state";

const NOW = Date.parse("2026-10-24T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function run(overrides: Partial<LiveRunForIssue>): LiveRunForIssue {
  return {
    id: "run",
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: ago(4 * MIN),
    finishedAt: null,
    createdAt: ago(5 * MIN),
    agentId: "lintel",
    agentName: "Lintel",
    adapterType: "claude_local",
    issueId: "issue",
    ...overrides,
  };
}

const lintelOneSlot = new Map([["lintel", { id: "lintel", status: "running", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }]]);
const labels: Record<string, string> = { "gre-2217": "GRE-2217", "gre-2019": "GRE-2019" };
const issueLabel = (id: string) => labels[id];

describe("deriveTaskRunState", () => {
  it("running: says Working with elapsed time and last output", () => {
    const runs = [run({ id: "r1", issueId: "gre-2217", lastEventAt: ago(20_000) })];
    const state = deriveTaskRunState("gre-2217", runs, { now: NOW, agentsById: lintelOneSlot });
    expect(state?.kind).toBe("running");
    const copy = describeTaskRunState(state!, { now: NOW, issueLabel });
    expect(copy.label).toBe("Working");
    expect(copy.detail).toBe("4 min · last output 20s ago");
  });

  it("queued behind a busy slot: never says Working, names the blocking task and the limit", () => {
    const runs = [
      run({ id: "r1", issueId: "gre-2217", lastEventAt: ago(10_000) }),
      run({ id: "r2", status: "queued", issueId: "gre-2019", startedAt: null, createdAt: ago(2 * MIN) }),
    ];
    const state = deriveTaskRunState("gre-2019", runs, { now: NOW, agentsById: lintelOneSlot });
    expect(state).toMatchObject({
      kind: "queued",
      position: 1,
      queueLength: 1,
      reason: { kind: "behind", blockingIssueId: "gre-2217", maxConcurrentRuns: 1 },
    });
    const copy = describeTaskRunState(state!, { now: NOW, issueLabel });
    expect(copy.label).toBe("Queued");
    expect(copy.detail).toBe("Behind GRE-2217 (Lintel runs 1 at a time)");
    expect(copy.blockingIssueId).toBe("gre-2217");
  });

  it("queued: shows the place in the agent's queue when more than one waits", () => {
    const runs = [
      run({ id: "r1", issueId: "gre-2217" }),
      run({ id: "q-new", status: "queued", issueId: "b", startedAt: null, createdAt: ago(1 * MIN) }),
      run({ id: "q-old", status: "queued", issueId: "a", startedAt: null, createdAt: ago(9 * MIN) }),
    ];
    const states = deriveTaskRunStates(runs, { now: NOW, agentsById: lintelOneSlot });
    expect(states.get("a")).toMatchObject({ position: 1, queueLength: 2 });
    const copy = describeTaskRunState(states.get("b")!, { now: NOW, issueLabel });
    expect(copy.detail).toBe("Behind GRE-2217 (Lintel runs 1 at a time) · 2nd of 2 waiting");
  });

  it("queued: agent paused wins over the slot reason", () => {
    const agents = new Map([["lintel", { id: "lintel", status: "paused" }]]);
    const runs = [run({ id: "q", status: "queued", issueId: "a", startedAt: null })];
    const copy = describeTaskRunState(deriveTaskRunState("a", runs, { now: NOW, agentsById: agents })!, { now: NOW });
    expect(copy.detail).toBe("Lintel is paused");
  });

  it("queued: release drain and instance holds", () => {
    const runs = [run({ id: "q", status: "queued", issueId: "a", startedAt: null, currentStatusMessage: "Waiting: low memory (1.2 GB free, floor 2 GB)" })];
    const release = deriveTaskRunState("a", runs, { now: NOW, releaseDraining: true })!;
    expect(describeTaskRunState(release, { now: NOW }).detail).toBe("Waiting for a release to finish");
    const hold = deriveTaskRunState("a", runs, { now: NOW })!;
    expect(describeTaskRunState(hold, { now: NOW }).detail).toBe("Waiting: low memory (1.2 GB free, floor 2 GB)");
  });

  it("queued with a free slot reads Starting soon", () => {
    const runs = [run({ id: "q", status: "queued", issueId: "a", startedAt: null })];
    const copy = describeTaskRunState(deriveTaskRunState("a", runs, { now: NOW })!, { now: NOW });
    expect(copy.detail).toBe("Starting soon");
  });

  it("stuck: running but silent for 10+ minutes shows a quiet warning", () => {
    const runs = [run({ id: "r1", issueId: "a", startedAt: ago(30 * MIN), lastEventAt: ago(12 * MIN) })];
    const state = deriveTaskRunState("a", runs, { now: NOW })!;
    expect(state.kind).toBe("stuck");
    expect(describeTaskRunState(state, { now: NOW }).label).toBe("No output for 12 min");
  });

  it("a task with both a running and a queued run shows as running", () => {
    const runs = [
      run({ id: "q", status: "queued", issueId: "a", startedAt: null }),
      run({ id: "r", issueId: "a" }),
    ];
    expect(deriveTaskRunState("a", runs, { now: NOW })?.kind).toBe("running");
  });

  it("ignores runs with no task and finished runs", () => {
    const runs = [run({ id: "r", issueId: null }), run({ id: "f", status: "succeeded", issueId: "a" })];
    expect(deriveTaskRunStates(runs, { now: NOW }).size).toBe(0);
  });
});

describe("agentMaxConcurrentRuns", () => {
  it("reads the agent limit and falls back to the server default", () => {
    expect(agentMaxConcurrentRuns({ id: "a", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })).toBe(1);
    expect(agentMaxConcurrentRuns({ id: "a", runtimeConfig: {} })).toBe(20);
    expect(agentMaxConcurrentRuns(null)).toBe(20);
  });
});

describe("formatRunDuration", () => {
  it("keeps chip text short", () => {
    expect(formatRunDuration(20_000)).toBe("20s");
    expect(formatRunDuration(12 * MIN)).toBe("12 min");
    expect(formatRunDuration(65 * MIN)).toBe("1 h 5 min");
  });
});
