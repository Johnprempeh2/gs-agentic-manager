import { describe, expect, it } from "vitest";
import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_STREAMS,
  deepDiveGifStubBody,
  defaultDeepDiveStreamFields,
  readDeepDiveStreamFields,
} from "./deep-dive.js";

describe("deep dive vocabulary (Book V)", () => {
  it("names the nine Investigation Streams and five GIF documents in canon order", () => {
    expect(DEEP_DIVE_STREAMS.map((stream) => stream.key)).toEqual([
      "leadership",
      "business",
      "operations",
      "people",
      "technology",
      "data",
      "governance",
      "customer-experience",
      "innovation-ai",
    ]);
    expect(DEEP_DIVE_GIF.map((gif) => gif.documentKey)).toEqual([
      "gif-current-state",
      "gif-evidence",
      "gif-business-impact",
      "gif-future-state",
      "gif-transformation-opportunity",
    ]);
  });

  it("stubs a GIF document with only its heading and question", () => {
    expect(deepDiveGifStubBody(DEEP_DIVE_GIF[0])).toBe("# Current state\n\nWhat exists today?\n");
  });

  it("starts every stream Internal, at full depth, with every cell Unknown", () => {
    expect(defaultDeepDiveStreamFields("data")).toEqual({
      stream: "data",
      status: "not_started",
      depth: "full",
      depthReason: "",
      visibility: "internal",
      knowledge: {
        "current-state": "unknown",
        evidence: "unknown",
        "business-impact": "unknown",
        "future-state": "unknown",
        "transformation-opportunity": "unknown",
      },
    });
  });

  it("reads unrecognised values as Unknown and Internal, never Known or Shared", () => {
    const fields = readDeepDiveStreamFields("data", {
      visibility: "SHARED",
      status: "done",
      knowledge: { evidence: "Known", "current-state": "known" },
    });
    expect(fields.visibility).toBe("internal");
    expect(fields.status).toBe("not_started");
    expect(fields.knowledge.evidence).toBe("unknown");
    expect(fields.knowledge["current-state"]).toBe("known");
  });
});
