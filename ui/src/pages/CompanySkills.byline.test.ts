import { describe, expect, it } from "vitest";
import { skillCardByline } from "./CompanySkills";

describe("skillCardByline", () => {
  it("says Built in for app skills and drops a bare commit hash", () => {
    expect(skillCardByline({ required: true, author: "GS Agentic Manager bundled", version: "1.2.0" })).toBe("Built in");
    expect(skillCardByline({ required: false, author: "affaan-m/ecc", version: "e482e57" })).toBe("by affaan-m/ecc");
    expect(skillCardByline({ required: false, author: "you", version: "2.0.1" })).toBe("by you · 2.0.1");
  });
});
