import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";

// The default telemetry endpoint belongs to the upstream project, so an
// install never reports to it unless its config file opts in.
describe("telemetry default", () => {
  it("is off when the config file does not turn it on", () => {
    expect(loadConfig().telemetryEnabled).toBe(false);
  });
});
