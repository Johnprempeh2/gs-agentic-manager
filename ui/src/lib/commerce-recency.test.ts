import { describe, expect, it } from "vitest";
import { lastEngagementByClient, recencyLine, recencyOf } from "./commerce-recency";

const NOW = Date.parse("2026-11-11T12:00:00Z");

describe("client recency", () => {
  it("buckets by days since the latest item, as the site did", () => {
    expect(recencyOf("2026-11-05", NOW)).toBe("active");
    expect(recencyOf("2026-10-20", NOW)).toBe("steady");
    expect(recencyOf("2026-09-20", NOW)).toBe("quiet");
    expect(recencyOf("2026-06-01", NOW)).toBe("cold");
    expect(recencyOf(null, NOW)).toBe("none");
    expect(recencyLine("2026-10-30T12:00:00Z", NOW)).toBe("Last item 12 days ago");
  });

  it("takes each client's latest item, by its date or else when it was added", () => {
    const latest = lastEngagementByClient([
      { customer_id: "a", occurred_on: "2026-10-01", created_at: "2026-11-10T00:00:00Z" },
      { customer_id: "a", occurred_on: "2026-10-20" },
      { customer_id: "b", occurred_on: null, created_at: "2026-09-01T00:00:00Z" },
      { customer_id: null, occurred_on: "2026-11-01" },
    ]);
    expect(latest.get("a")).toBe("2026-10-20");
    expect(latest.get("b")).toBe("2026-09-01T00:00:00Z");
    expect(latest.size).toBe(2);
  });
});
