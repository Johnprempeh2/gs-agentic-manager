import { describe, expect, it } from "vitest";
import { deepDivePortalHref } from "./deep-dive-scope";

describe("deepDivePortalHref", () => {
  it("keeps a company-wide Deep Dive link inside one client's portal", () => {
    expect(deepDivePortalHref("r1", "/deep-dive")).toBe("/deep-dive/r1");
    expect(deepDivePortalHref("r1", "/deep-dive/overview")).toBe("/deep-dive/r1");
    expect(deepDivePortalHref("r1", "/deep-dive/files")).toBe("/deep-dive/r1/documents");
    expect(deepDivePortalHref("r1", "/deep-dive/sessions/s9")).toBe("/deep-dive/r1/sessions/s9");
    expect(deepDivePortalHref("r1", "/clients")).toBe("/clients");
  });
});
