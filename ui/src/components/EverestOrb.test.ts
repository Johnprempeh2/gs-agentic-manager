import { describe, expect, it } from "vitest";
import { isLeadWorking } from "./EverestOrb";

describe("EverestOrb", () => {
  it("animates only when the lead has a running run", () => {
    expect(isLeadWorking([{ agentId: "everest" }], "everest")).toBe(true);
    expect(isLeadWorking([{ agentId: "mica" }], "everest")).toBe(false);
  });
});
