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
      asksToApproveVisualWork(card("Approve the plan document?", { target: { type: "issue_document", key: "plan" } })),
    ).toBe(false);
  });

  it("asks for evidence on a card that targets any other document (the GRE-413 pitch case)", () => {
    expect(
      asksToApproveVisualWork(
        card("Approve the pitch one-pager?", { target: { type: "issue_document", key: "pitch" } }),
      ),
    ).toBe(true);
    expect(
      asksToApproveVisualWork(card("Approve the price sheet document?", { target: { type: "issue_document" } })),
    ).toBe(true);
  });

  it("asks for evidence on a release card that names a UI change", () => {
    // Release tasks carry Flint's screenshots, so these cards pass the check in practice.
    expect(asksToApproveVisualWork(card("Update live to rc-2026.10.03 (UI sweep)?"))).toBe(true);
  });

  // GRE-3726: the GRE-3255 card asked to make a repo public. Its details said
  // "docs" and "reports the result", so the card was blocked and the
  // irreversible change went ahead with no card on record.
  const repoPublicCard = (detailLine: string) =>
    [
      "Do you approve that Everest makes the repository Johnprempeh2/indago-portal public now?",
      "",
      "What goes public (all files and all 115 commits of history):",
      `- ${detailLine}`,
      "- No real passwords or tokens. Only test values.",
      "",
      "If you accept: Everest makes the repository public, runs CI again on the PR #26 head, and reports the result.",
      "If you reject: the repository stays private and PR #26 waits on the billing card.",
    ].join("\n");

  it.each([
    repoPublicCard("Code, database migrations and docs that name Indago."),
    repoPublicCard("Code and database migrations that name Indago."),
  ])("does not ask for evidence when only the details below the ask name documents (GRE-3726)", (prompt) => {
    expect(asksToApproveVisualWork(card(prompt))).toBe(false);
  });

  it("still asks for evidence when the ask itself names visual work above the details", () => {
    expect(
      asksToApproveVisualWork(card("Here is the new onboarding screen. Ship it?\n\nIf you accept: Everest merges it.")),
    ).toBe(true);
  });

  it("reads the ask after leading blank lines", () => {
    expect(asksToApproveVisualWork(card("\n\nApprove the pitch deck?\n\nDetails follow."))).toBe(true);
  });

  it("only checks request_confirmation", () => {
    expect(asksToApproveVisualWork({ kind: "ask_user_questions", payload: { prompt: "Which design?" } })).toBe(false);
  });
});
