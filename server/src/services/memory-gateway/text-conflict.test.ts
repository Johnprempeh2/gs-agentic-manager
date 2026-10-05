import { describe, expect, it } from "vitest";
import { textConflictTerms, type TextConflictInput } from "./text-conflict.js";

const entry = (content: string, tags: Partial<TextConflictInput> = {}): TextConflictInput => ({
  title: null,
  content,
  entities: [],
  topics: [],
  ...tags,
});

const approved = entry("Alder care plan is £180/month.", { entities: ["Alder"], topics: ["care plan price"] });

describe("textConflictTerms (GRE-934)", () => {
  it("flags an untagged entry that states a different price for the same subject", () => {
    const terms = textConflictTerms(entry("Alder care plan is £150/month."), approved);
    expect(terms).toContain("alder");
    expect(terms).toContain("£150/month vs £180/month");
  });

  it("flags a wrongly tagged entry by its text", () => {
    const wrong = entry("Alder care plan is £150/month.", { entities: ["Birch"], topics: ["onboarding"] });
    expect(textConflictTerms(wrong, approved)).toContain("£150/month vs £180/month");
  });

  it("does not flag the same price, however it is written", () => {
    expect(textConflictTerms(entry("Alder care plan is £180/month."), approved)).toEqual([]);
    expect(textConflictTerms(entry("The Alder care plan costs GBP 180 per month."), approved)).toEqual([]);
  });

  it("does not flag a different subject", () => {
    expect(textConflictTerms(entry("Birch care plan is £150/month."), approved)).toEqual([]);
    expect(textConflictTerms(entry("Our office lease is £150/month."), approved)).toEqual([]);
    expect(textConflictTerms(entry("The care plan for Birch is £150/month."), entry("The care plan for Alder is £180/month."))).toEqual([]);
  });

  it("does not compare different kinds of value", () => {
    expect(textConflictTerms(entry("Alder care plan is £180/year."), approved)).toEqual([]);
    expect(textConflictTerms(entry("Alder care plan renews on 1 March 2027."), approved)).toEqual([]);
  });

  it("flags differing amounts, percentages, dates, times and quantities", () => {
    expect(textConflictTerms(entry("Kestrel retainer is GBP 2,500 a month."), entry("Kestrel retainer is GBP 4,000 a month."))).toContain(
      "GBP 2,500 a month vs GBP 4,000 a month",
    );
    expect(textConflictTerms(entry("Kestrel discount is 15% on renewal."), entry("Kestrel discount is 10% on renewal."))).toContain("15% vs 10%");
    expect(textConflictTerms(entry("Kestrel contract ends on 31 March 2027."), entry("Kestrel contract ends 2027-06-30."))).toContain(
      "31 March 2027 vs 2027-06-30",
    );
    expect(textConflictTerms(entry("Kestrel contract ends 30/06/2027."), entry("Kestrel contract ends 2027-06-30."))).toEqual([]);
    expect(textConflictTerms(entry("Kestrel stand-up is at 10:00."), entry("Kestrel stand-up is at 09:30."))).toContain("10:00 vs 09:30");
    expect(textConflictTerms(entry("Kestrel invoices are due in 14 days."), entry("Kestrel invoices are due in 30 days."))).toContain("14 days vs 30 days");
  });

  it("reads £1.5k as 1500", () => {
    expect(textConflictTerms(entry("Kestrel setup fee is £1.5k."), entry("Kestrel setup fee is £1,500."))).toEqual([]);
  });

  it("needs values in both texts", () => {
    expect(textConflictTerms(entry("Alder care plan is changing soon."), approved)).toEqual([]);
  });
});
