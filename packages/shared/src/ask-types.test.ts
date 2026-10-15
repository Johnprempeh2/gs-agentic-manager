import { describe, expect, it } from "vitest";
import { ASK_TYPES, ASK_TYPE_COPY, readAskType } from "./ask-types.js";
import { createIssueThreadInteractionSchema } from "./validators/issue.js";

describe("ask types", () => {
  it("reads a known ask type and ignores anything else", () => {
    expect(readAskType({ askType: "send_file" })).toBe("send_file");
    expect(readAskType({ askType: "fax" })).toBeNull();
    expect(readAskType(null)).toBeNull();
  });

  it("has plain-words copy for every type, with no dashes", () => {
    for (const type of ASK_TYPES) {
      const copy = ASK_TYPE_COPY[type];
      for (const text of Object.values(copy)) {
        expect(text.trim()).not.toBe("");
        expect(text).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it("accepts askType on a request_confirmation and rejects unknown values", () => {
    const base = { kind: "request_confirmation", payload: { version: 1, prompt: "Did you send it?" } };
    expect(createIssueThreadInteractionSchema.safeParse({ ...base, payload: { ...base.payload, askType: "confirm_sent" } }).success).toBe(true);
    expect(createIssueThreadInteractionSchema.safeParse({ ...base, payload: { ...base.payload, askType: "fax" } }).success).toBe(false);
  });
});
