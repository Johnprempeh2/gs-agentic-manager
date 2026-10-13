import { describe, expect, it } from "vitest";
import { isClientPortalVisible, journeyStageStates } from "./client-journey.js";

const stages = [
  { id: "discovery", kind: "working", position: 100 },
  { id: "gita", kind: "working", position: 200 },
  { id: "deep-dive", kind: "working", position: 300 },
  { id: "gdxp", kind: "review", position: 400 },
  { id: "playback", kind: "done", position: 500 },
  { id: "paused", kind: "cancelled", position: 900 },
  { id: "lost", kind: "cancelled", position: 1000 },
];

function stateMap(result: ReturnType<typeof journeyStageStates>) {
  return Object.fromEntries(result.map((entry) => [entry.id, entry.state]));
}

describe("journeyStageStates", () => {
  it("marks stages before the current one as done, in journey order", () => {
    expect(journeyStageStates([...stages].reverse(), "deep-dive")).toEqual([
      { id: "discovery", state: "done" },
      { id: "gita", state: "done" },
      { id: "deep-dive", state: "current" },
      { id: "gdxp", state: "next" },
      { id: "playback", state: "next" },
    ]);
  });

  it("treats a done-kind stage the case sits in as complete", () => {
    expect(stateMap(journeyStageStates(stages, "playback"))).toMatchObject({ gdxp: "done", playback: "done" });
  });

  it("uses the stage before a pause, and the paused stage is not complete", () => {
    expect(stateMap(journeyStageStates(stages, "paused", "gita"))).toEqual({
      discovery: "done",
      gita: "next",
      "deep-dive": "next",
      gdxp: "next",
      playback: "next",
      paused: "side",
    });
  });

  it("completes nothing when the case is in an unknown stage", () => {
    expect(journeyStageStates(stages, "missing").every((entry) => entry.state === "next")).toBe(true);
    expect(journeyStageStates(stages, "lost").map((entry) => entry.state)).toEqual([
      "next", "next", "next", "next", "next", "side",
    ]);
  });
});

describe("isClientPortalVisible", () => {
  it("needs client-facing, final and a completed stage", () => {
    expect(isClientPortalVisible({ clientFacing: true, status: "final", stageState: "done" })).toBe(true);
    expect(isClientPortalVisible({ clientFacing: false, status: "final", stageState: "done" })).toBe(false);
    expect(isClientPortalVisible({ clientFacing: true, status: "draft", stageState: "done" })).toBe(false);
    for (const stageState of ["current", "next", "side", null] as const) {
      expect(isClientPortalVisible({ clientFacing: true, status: "final", stageState })).toBe(false);
    }
  });
});
