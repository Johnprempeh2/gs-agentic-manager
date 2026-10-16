import { describe, expect, it } from "vitest";
import { markParts, searchTerms } from "./MemoryRecordList";

describe("search marking", () => {
  it("keeps words of two letters or more, longest first, once each", () => {
    expect(searchTerms("  Invoice a in INVOICE  ")).toEqual(["invoice", "in"]);
    expect(searchTerms(undefined)).toEqual([]);
  });

  it("marks matches whatever their case, and treats symbols as plain text", () => {
    expect(markParts("Invoices go out in May", searchTerms("invoices may"))).toEqual([
      { text: "Invoices", match: true },
      { text: " go out in ", match: false },
      { text: "May", match: true },
    ]);
    expect(markParts("Costs (GBP) rose", ["(gbp)"])).toEqual([
      { text: "Costs ", match: false },
      { text: "(GBP)", match: true },
      { text: " rose", match: false },
    ]);
    expect(markParts("Nothing here", [])).toEqual([{ text: "Nothing here", match: false }]);
  });
});
