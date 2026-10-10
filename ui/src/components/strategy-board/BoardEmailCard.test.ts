import { describe, expect, it } from "vitest";
import type { EmailEndpointSummary, StrategyBoardEmail } from "@greatstone/shared";
import { boardEmailLine, secretaryInboxOptions } from "./BoardEmailCard";

function email(overrides: Partial<StrategyBoardEmail>): StrategyBoardEmail {
  return {
    id: "e1",
    companyId: "c1",
    kind: "slippage_alert",
    recipientUserId: "u1",
    recipientEmail: "chair@example.test",
    alertId: null,
    whyRequestId: null,
    meetingDate: null,
    kpiCodes: null,
    publicationId: "p1",
    status: "queued",
    attempts: 1,
    lastError: null,
    createdAt: new Date("2026-10-09T08:00:00Z"),
    ...overrides,
  };
}

describe("board email card", () => {
  it("says what went to whom, and why a failed email was not sent", () => {
    expect(boardEmailLine(email({}))).toBe("2026-10-09 · Slippage alert to chair@example.test · sent");
    expect(boardEmailLine(email({ kind: "meeting_reminder", status: "failed", lastError: "This email inbox is not active" }))).toBe(
      "2026-10-09 · Meeting reminder to chair@example.test · not sent: This email inbox is not active",
    );
  });

  it("offers only inboxes that are not archived", () => {
    const inbox = (id: string, status: string) => ({ id, status }) as EmailEndpointSummary;
    expect(secretaryInboxOptions([inbox("a", "active"), inbox("b", "archived"), inbox("c", "paused")]).map((i) => i.id)).toEqual(["a", "c"]);
  });
});
