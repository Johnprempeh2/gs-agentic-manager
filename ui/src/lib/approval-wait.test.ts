import { describe, expect, it } from "vitest";
import { daysWaiting, pendingListText, pendingSummary, waitingLabel } from "./approval-wait";

const NOW = new Date("2026-10-16T17:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("waitingLabel", () => {
  it("says how long a sign-off has waited once it is a day old", () => {
    expect(waitingLabel({ status: "pending", createdAt: hoursAgo(5) }, NOW)).toBeNull();
    expect(waitingLabel({ status: "pending", createdAt: hoursAgo(30) }, NOW)).toBe("Waiting 1 day");
    expect(waitingLabel({ status: "revision_requested", createdAt: hoursAgo(80) }, NOW)).toBe("Waiting 3 days");
  });

  it("says nothing once a decision is made", () => {
    expect(waitingLabel({ status: "approved", createdAt: hoursAgo(80) }, NOW)).toBeNull();
  });
});

describe("pendingSummary", () => {
  it("counts the waiting sign-offs and names the oldest", () => {
    expect(
      pendingSummary(
        [
          { status: "pending", createdAt: hoursAgo(100) },
          { status: "pending", createdAt: hoursAgo(2) },
          { status: "approved", createdAt: hoursAgo(300) },
        ],
        NOW,
      ),
    ).toBe("2 waiting for you, the oldest for 4 days.");
    expect(pendingSummary([{ status: "pending", createdAt: hoursAgo(2) }], NOW)).toBe("1 waiting for you, from today.");
    expect(pendingSummary([], NOW)).toBeNull();
  });

  it("never counts negative days for a clock that runs ahead", () => {
    expect(daysWaiting(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
  });
});

describe("pendingListText", () => {
  it("lists each waiting sign-off with who asked, how long and a link", () => {
    const now = new Date(2026, 9, 16, 12);
    const text = pendingListText(
      [
        { id: "1", status: "pending", createdAt: new Date(2026, 9, 13, 12), label: "Hire an agent: Designer", requester: "Ridge" },
        { id: "2", status: "pending", createdAt: new Date(2026, 9, 16, 9), label: "Spend more" },
        { id: "3", status: "approved", createdAt: new Date(2026, 9, 1), label: "Old" },
      ],
      (id) => `https://gsam.test/approvals/${id}`,
      now,
    );
    expect(text.split("\n")).toEqual([
      "Sign-offs waiting for me",
      "2 waiting for you, the oldest for 3 days.",
      "",
      "• Hire an agent: Designer (from Ridge, waiting 3 days) https://gsam.test/approvals/1",
      "• Spend more (today) https://gsam.test/approvals/2",
    ]);
  });
});
