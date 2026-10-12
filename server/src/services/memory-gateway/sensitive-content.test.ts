import { describe, expect, it } from "vitest";
import { detectSensitiveContent, MemorySensitiveContentError } from "./sensitive-content.js";

// Synthetic values only, joined at runtime so no token-shaped string is committed.
const join = (...parts: string[]) => parts.join("");

describe("detectSensitiveContent (GRE-868)", () => {
  it.each([
    ["github_token", join("ghp", "_", "SYNTHETICkestrelWORKSfixture00000000")],
    ["anthropic_key", join("sk-", "ant-", "SYNTHETICfixture000000000")],
    ["aws_access_key", join("AKIA", "SYNTHETIC0000000")],
    ["database_url", "postgres://syn:syn@localhost/syn"],
    ["database_url", "mongodb+srv://syn:syn@cluster.example/syn"],
    ["private_key", join("-----BEGIN ", "PRIVATE KEY-----")],
    ["card_number", "4111 1111 1111 1111"],
    ["card_number", "4111-1111-1111-1111"],
    ["uk_phone", "07700 900123"],
    ["uk_phone", "+44 7700 900123"],
  ])("finds %s", (type, value) => {
    expect(detectSensitiveContent(`Synthetic note: ${value}.`)).toContain(type);
  });

  it.each([
    "Kestrel Works prefers invoices in GBP.",
    "Meeting on 2026-10-05 at 14:30, 3 attendees, ticket 1234 5678.",
    // 16 digits that fail the Luhn check, and a repeated digit that passes it.
    "Order 1234 5678 9012 3456 shipped.",
    "Placeholder 0000 0000 0000 0000.",
    "postgres://localhost/syn has no password.",
    "Call the office on 020 7946 0000.",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(detectSensitiveContent(text)).toEqual([]);
  });

  it("names pattern types in the error, never the value", () => {
    const error = new MemorySensitiveContentError(["card_number"]);
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/card_number/);
    expect(error.message).toMatch(/pattern-based/);
  });
});
