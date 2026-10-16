import { describe, expect, it } from "vitest";

import { nextWorkMode, titleForPendingWorkMode, workModeMetaList } from "./work-mode-meta";

describe("work mode metadata", () => {
  it("orders issue work modes as auto, planning, then ask", () => {
    expect(workModeMetaList().map((mode) => mode.value)).toEqual(["standard", "planning", "ask"]);
    expect(workModeMetaList().map((mode) => mode.label)).toEqual(["Auto mode", "Plan mode", "Ask mode"]);
  });

  it("cycles issue work modes as auto, planning, ask, then auto", () => {
    expect(nextWorkMode("standard")).toBe("planning");
    expect(nextWorkMode("planning")).toBe("ask");
    expect(nextWorkMode("ask")).toBe("standard");
  });

  it("uses graduated tooltip copy", () => {
    expect(titleForPendingWorkMode("standard")).toBe("Auto mode: The agent starts the work straight away. Click to change.");
    expect(titleForPendingWorkMode("planning")).toBe("Plan mode: The agent writes a plan for you to approve before it starts. Click to change.");
    expect(titleForPendingWorkMode("ask")).toBe("Ask mode: The agent answers your question and changes nothing. Click to change.");
  });
});
