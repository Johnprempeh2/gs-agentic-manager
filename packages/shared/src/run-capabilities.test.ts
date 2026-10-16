import { describe, expect, it } from "vitest";
import { readRequiredRunCapabilities } from "./run-capabilities.js";
import { createAgentSchema, updateAgentSchema } from "./validators/agent.js";

describe("readRequiredRunCapabilities", () => {
  it("returns nothing when no tools are declared", () => {
    expect(readRequiredRunCapabilities({})).toEqual([]);
    expect(readRequiredRunCapabilities(null)).toEqual([]);
    expect(readRequiredRunCapabilities({ requiredCapabilities: "docker" })).toEqual([]);
  });

  it("keeps known tools once and drops unknown ones", () => {
    expect(
      readRequiredRunCapabilities({ requiredCapabilities: ["docker", " git ", "docker", "network", 3] }),
    ).toEqual(["docker", "git"]);
  });
});

describe("adapterConfig.requiredCapabilities validation", () => {
  it("accepts a list of known tools", () => {
    const parsed = updateAgentSchema.safeParse({ adapterConfig: { requiredCapabilities: ["git", "chromium"] } });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown tool with a clear message", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Builder",
      adapterType: "process",
      adapterConfig: { requiredCapabilities: ["kubernetes"] },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("adapterConfig.requiredCapabilities must be a list of");
  });
});
