import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { commentSubmitErrorText } from "./comment-submit-error";

describe("commentSubmitErrorText", () => {
  it("names the failing field instead of only 'Validation error' (GRE-1688)", () => {
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: [{
        code: "too_big",
        path: ["target", "key"],
        message: "Too big: expected string to have <=120 characters",
      }],
    });
    expect(commentSubmitErrorText(error)).toBe(
      "Validation error: target.key: Too big: expected string to have <=120 characters",
    );
  });

  it("caps the list and counts the rest", () => {
    const details = ["a", "b", "c"].map((field) => ({ path: [field], message: "Required" }));
    const error = new ApiError("Validation error", 400, { error: "Validation error", details });
    expect(commentSubmitErrorText(error)).toBe("Validation error: a: Required; b: Required (+1 more)");
  });

  it("keeps the server message when there are no field details", () => {
    expect(commentSubmitErrorText(new ApiError("Only the conversation owner can start a new session", 403, {
      error: "Only the conversation owner can start a new session",
    }))).toBe("Only the conversation owner can start a new session");
    expect(commentSubmitErrorText(new Error("offline"))).toBe("offline");
    expect(commentSubmitErrorText("boom")).toBe("Could not post your comment");
  });
});
