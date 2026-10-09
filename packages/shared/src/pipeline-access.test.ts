import { describe, expect, it } from "vitest";
import {
  pipelineAccessLevelFor,
  pipelineAllPipelinesLevel,
  planPipelineLevelChange,
} from "./pipeline-access.js";

const ALL = ["a", "b", "c"];
const cases = (pipelineIds: string[] | null) => ({ permissionKey: "pipelines:cases", scope: pipelineIds ? { pipelineIds } : null });
const write = (pipelineIds: string[] | null) => ({ permissionKey: "pipelines:write", scope: pipelineIds ? { pipelineIds } : null });

describe("pipelineAccessLevelFor", () => {
  it("reads mixed grants per pipeline", () => {
    const grants = [write(["a"]), cases(null)];
    expect(pipelineAccessLevelFor(grants, "a")).toBe("administer");
    expect(pipelineAccessLevelFor(grants, "b")).toBe("work_cases");
    expect(pipelineAccessLevelFor([cases(["a"])], "b")).toBe("view");
  });
});

describe("planPipelineLevelChange", () => {
  it("adds one pipeline to Administer and leaves others alone", () => {
    expect(planPipelineLevelChange([cases(null)], "b", "administer", ALL)).toEqual({
      cases: { granted: true, pipelineIds: null },
      write: { granted: true, pipelineIds: ["b"] },
    });
  });

  it("turns all-pipelines Administer into the other pipelines when one drops to Work cases", () => {
    expect(planPipelineLevelChange([write(null)], "b", "work_cases", ALL)).toEqual({
      cases: { granted: true, pipelineIds: ["b"] },
      write: { granted: true, pipelineIds: ["a", "c"] },
    });
  });

  it("removes the grant when its last pipeline goes to View", () => {
    expect(planPipelineLevelChange([write(["a"]), cases(["a"])], "a", "view", ALL)).toEqual({
      cases: { granted: false },
      write: { granted: false },
    });
  });
});

describe("pipelineAllPipelinesLevel", () => {
  it("is the level for one all-pipelines grant and null when mixed or picked", () => {
    expect(pipelineAllPipelinesLevel([])).toBe("view");
    expect(pipelineAllPipelinesLevel([write(null)])).toBe("administer");
    expect(pipelineAllPipelinesLevel([cases(null)])).toBe("work_cases");
    expect(pipelineAllPipelinesLevel([cases(["a"])])).toBeNull();
    expect(pipelineAllPipelinesLevel([write(["a"]), cases(null)])).toBeNull();
  });
});
