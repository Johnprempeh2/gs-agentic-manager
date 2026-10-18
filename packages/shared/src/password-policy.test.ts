import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, passwordProblem } from "./password-policy.js";

describe("passwordProblem", () => {
  it("accepts a long password that is not well known", () => {
    expect(passwordProblem("blue kettle on the hill")).toBeNull();
    expect(passwordProblem("fixture-password", { email: "ann@example.com" })).toBeNull();
  });

  it("refuses short, overlong and one-character passwords", () => {
    expect(passwordProblem("short-pass1")).toContain("at least 12");
    expect(passwordProblem("a".repeat(PASSWORD_MAX_LENGTH + 1))).toContain("at most");
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toContain("more than one or two");
    expect(passwordProblem("abababababababab")).toContain("more than one or two");
  });

  it("refuses well-known passwords whatever their case", () => {
    expect(passwordProblem("Password1234")).toContain("too well known");
    expect(passwordProblem("QWERTY123456")).toContain("too well known");
  });

  it("refuses a password built from the account's email", () => {
    expect(passwordProblem("annabel.smith2026", { email: "Annabel.Smith@example.com" })).toContain("email");
    // A short name inside a longer password, or a very short local part, is fine.
    expect(passwordProblem("first-password-for-the-owner", { email: "owner@example.com" })).toBeNull();
    expect(passwordProblem("bob kettle on the hill", { email: "bob@example.com" })).toBeNull();
  });
});
