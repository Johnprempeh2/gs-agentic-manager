import { describe, expect, it } from "vitest";
import { inAppDeliverablePath } from "./deliverable-links";

const origin = "http://localhost:3100";

describe("inAppDeliverablePath", () => {
  it("keeps deliverable links inside the app, with or without the prefix or origin", () => {
    expect(inAppDeliverablePath("/deliverables?open=d-1", origin)).toBe("/deliverables?open=d-1");
    expect(inAppDeliverablePath("/GRE/deliverables?open=d-1", origin)).toBe("/GRE/deliverables?open=d-1");
    expect(inAppDeliverablePath(`${origin}/GRE/deliverables?open=d-1`, origin)).toBe("/GRE/deliverables?open=d-1");
  });

  it("leaves other links alone", () => {
    expect(inAppDeliverablePath(null, origin)).toBeNull();
    expect(inAppDeliverablePath("/GRE/deliverables", origin)).toBeNull();
    expect(inAppDeliverablePath("/GRE/issues/GRE-1?open=d-1", origin)).toBeNull();
    expect(inAppDeliverablePath("https://example.com/GRE/deliverables?open=d-1", origin)).toBeNull();
    expect(inAppDeliverablePath("/api/attachments/a-1/content", origin)).toBeNull();
  });
});
