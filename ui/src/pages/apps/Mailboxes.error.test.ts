import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { connectErrorText } from "./Mailboxes";

describe("connectErrorText", () => {
  it("shows the refused field's message instead of a bare Validation error", () => {
    const error = new ApiError("Validation error", 400, {
      error: "Validation error",
      details: [{ path: ["host"], message: "Enter the server name only, such as imap.example.com" }],
    });
    expect(connectErrorText(error)).toBe("Enter the server name only, such as imap.example.com");
  });

  it("falls back to the error message", () => {
    expect(connectErrorText(new Error("Sign-in failed"))).toBe("Sign-in failed");
  });
});
