import { describe, expect, it } from "vitest";
import { parseRate, poundsPerDollar, previewRows, priceCounts, rateStaleness, showRate, usdToGbpMinor } from "./commerce-currency";

describe("commerce currency", () => {
  it("converts exactly as the website does: dollars divided by the rate, whole pounds", () => {
    expect(usdToGbpMinor(100_000, 1.32)).toBe(75_800); // the site's own worked example: $1,000 at 1.32 is £758
    expect(usdToGbpMinor(14_500, 1.3)).toBe(11_200);
    expect(usdToGbpMinor(8_000, 1)).toBe(8_000); // a rate of 1.00 shows stored numbers as pounds
    expect(usdToGbpMinor(null, 1.3)).toBeNull();
    expect(usdToGbpMinor(100, 0)).toBeNull();
  });

  it("reads a rate as dollars for one pound", () => {
    expect(parseRate("1.30")).toEqual({ rate: 1.3 });
    expect(parseRate("0.05")).toHaveProperty("problem");
    expect(parseRate("abc")).toHaveProperty("problem");
    expect(showRate("1.300000")).toBe("1.30");
    expect(showRate("1.234567")).toBe("1.234567");
    expect(poundsPerDollar(1.25)).toBe("0.8000");
  });

  it("says how stale the rate is", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(rateStaleness("2026-11-11T08:00:00Z", now)).toMatchObject({ level: "fresh", label: "Set today" });
    expect(rateStaleness("2026-10-25T08:00:00Z", now)).toMatchObject({ level: "ageing", days: 17 });
    expect(rateStaleness("2026-09-01T08:00:00Z", now)).toMatchObject({ level: "stale" });
    expect(rateStaleness(null, now)).toBeNull();
  });

  it("previews the highest priced published dollar offerings, and counts what the rate reprices", () => {
    const rows = [
      { id: "a", name: "Cheap", status: "published", from_price_minor: "5000", from_price_currency: "USD",
        variants: [{ base_price_minor: "5000", currency: "USD" }, { base_price_minor: null, currency: null }] },
      { id: "b", name: "Dear", status: "published", from_price_minor: 100_000, from_price_currency: "USD",
        variants: [{ base_price_minor: 100_000, currency: "USD" }, { base_price_minor: 2000, currency: "GBP" }] },
      { id: "c", name: "Draft", status: "draft", from_price_minor: 900_000, from_price_currency: "USD", variants: [] },
      { id: "d", name: "Pounds", status: "published", from_price_minor: 700_000, from_price_currency: "GBP", variants: [] },
    ];
    const preview = previewRows(rows, 1.32, 1.25);
    expect(preview.map((r) => r.name)).toEqual(["Dear", "Cheap"]);
    expect(preview[0]).toMatchObject({ now: 75_800, next: 80_000 });
    expect(previewRows(rows, 1.32, null)[0]!.next).toBeNull();
    expect(priceCounts(rows)).toEqual({ usd: 2, other: { GBP: 1 }, products: 2 });
  });
});
