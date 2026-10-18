import { describe, expect, it } from "vitest";
import { dealFollowUpEmail } from "./DevtoolsFollowUpEmail";

describe("dealFollowUpEmail", () => {
  it("drafts a follow-up from the deal's last and next step", () => {
    const seed = dealFollowUpEmail(
      "Acme pilot",
      { lastActivitySubject: "Demo call", nextActivitySubject: "Send the proposal", nextActivityDate: "2026-10-22" },
      { name: "Sam Smith", email: "sam@acme.test" },
    );
    expect(seed.to).toEqual(["sam@acme.test"]);
    expect(seed.subject).toBe("Acme pilot: following up");
    expect(seed.text).toContain("Hello Sam,");
    expect(seed.text).toContain("Thank you for your time on our demo call.");
    expect(seed.text).toContain("Next step: Send the proposal (22 Oct).");
  });

  it("falls back to a plain draft with no contact or steps", () => {
    const seed = dealFollowUpEmail("Beta", {}, null);
    expect(seed.to).toEqual([]);
    expect(seed.text.startsWith("Hello,\n\nThank you for your time recently.")).toBe(true);
    expect(seed.text).not.toContain("Next step");
  });
});
