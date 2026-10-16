import { describe, expect, it } from "vitest";
import { isClientPortalVisible, journeyStageStates } from "./client-journey.js";
import { ndaClears, resolveSetCaseNda, setCaseNdaSchema } from "./validators/client-journey.js";

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
    expect(isClientPortalVisible({ clientFacing: true, status: "final", stageState: "done", confidentiality: "public", ndaCleared: false })).toBe(true);
    expect(isClientPortalVisible({ clientFacing: false, status: "final", stageState: "done", confidentiality: "public", ndaCleared: false })).toBe(false);
    expect(isClientPortalVisible({ clientFacing: true, status: "draft", stageState: "done", confidentiality: "public", ndaCleared: false })).toBe(false);
    for (const stageState of ["current", "next", "side", null] as const) {
      expect(isClientPortalVisible({ clientFacing: true, status: "final", stageState, confidentiality: "public", ndaCleared: true })).toBe(false);
    }
  });
});

describe("NDA status", () => {
  const visible = (status: "required" | "accepted" | "suspended", confidentiality: "internal" | "client" | "public") =>
    isClientPortalVisible({ clientFacing: true, status: "final", stageState: "done", confidentiality, ndaCleared: ndaClears(status) });

  it("required holds client items; accepted and suspended both let them through", () => {
    expect(visible("required", "client")).toBe(false);
    expect(visible("accepted", "client")).toBe(true);
    expect(visible("suspended", "client")).toBe(true);
  });

  it("never lets internal items through, and public items never need the NDA", () => {
    for (const status of ["required", "accepted", "suspended"] as const) {
      expect(visible(status, "internal")).toBe(false);
      expect(visible(status, "public")).toBe(true);
    }
  });

  it("a suspension needs a reason; the old accepted body maps to accepted or required", () => {
    expect(setCaseNdaSchema.safeParse({ status: "suspended" }).success).toBe(false);
    expect(setCaseNdaSchema.safeParse({ status: "suspended", reason: "  " }).success).toBe(false);
    expect(resolveSetCaseNda(setCaseNdaSchema.parse({ status: "suspended", reason: "Engagement already under way" })))
      .toEqual({ status: "suspended", reason: "Engagement already under way" });
    expect(resolveSetCaseNda(setCaseNdaSchema.parse({ status: "accepted", reason: "ignored" }))).toEqual({ status: "accepted", reason: null });
    expect(resolveSetCaseNda(setCaseNdaSchema.parse({ accepted: true }))).toEqual({ status: "accepted", reason: null });
    expect(resolveSetCaseNda(setCaseNdaSchema.parse({ accepted: false }))).toEqual({ status: "required", reason: null });
    expect(setCaseNdaSchema.safeParse({ status: "waived" }).success).toBe(false);
  });
});
