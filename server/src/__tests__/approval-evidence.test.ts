import { describe, expect, it } from "vitest";
import { asksToApproveVisualWork } from "../services/approval-evidence.js";

function card(prompt: string, extra: Record<string, unknown> = {}) {
  return { kind: "request_confirmation", payload: { version: 1, prompt, ...extra } };
}

describe("asksToApproveVisualWork (GRE-451)", () => {
  it.each([
    "Approve the new Decisions card design?",
    "Is this screen ready to ship?",
    "Approve the pitch deck for Monday?",
    "Happy with the onboarding video?",
    "Approve the pricing document?",
    "Does the new UI look right?",
    "Approve the mock-up of the settings page?",
  ])("asks for evidence on %j", (prompt) => {
    expect(asksToApproveVisualWork(card(prompt))).toBe(true);
  });

  it.each([
    "Run the backfill on the sandbox database?",
    "Retry the failed run now?",
    "Update live to v1.4.0?",
    "Merge the fix to the build script?",
  ])("does not ask for evidence on %j", (prompt) => {
    expect(asksToApproveVisualWork(card(prompt))).toBe(false);
  });

  it("does not count a plan confirmation, which already shows its document", () => {
    expect(
      asksToApproveVisualWork(card("Approve the plan document?", { target: { type: "issue_document" } })),
    ).toBe(false);
  });

  it("only checks request_confirmation", () => {
    expect(asksToApproveVisualWork({ kind: "ask_user_questions", payload: { prompt: "Which design?" } })).toBe(false);
  });
});
