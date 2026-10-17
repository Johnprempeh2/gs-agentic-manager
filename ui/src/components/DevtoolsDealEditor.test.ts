import { describe, expect, it } from "vitest";
import { applyDealDraft, draftFromFields } from "./DevtoolsDealEditor";

describe("DevTools deal editor", () => {
  it("reads a Pipedrive deal into the form", () => {
    expect(
      draftFromFields({
        dealValue: 12500,
        dealCurrency: "GBP",
        dealOwner: "John",
        expectedCloseDate: "2026-11-30",
        probability: 60,
        nextActivityDate: "2026-10-20",
        nextActivitySubject: "Demo",
      }),
    ).toEqual({
      value: "12500",
      currency: "GBP",
      owner: "John",
      expectedClose: "2026-11-30",
      probability: "60",
      nextActivityDate: "2026-10-20",
      nextActivitySubject: "Demo",
    });
  });

  it("writes deal keys, keeps other fields and removes cleared ones", () => {
    const fields = { dealStatus: "Open", dealValue: 500, dealCurrency: "USD", channel: "referral", probability: 20 };
    const next = applyDealDraft(fields, {
      ...draftFromFields(fields),
      value: "750",
      currency: "gbp",
      probability: "",
      nextActivityDate: "2026-10-21",
      nextActivitySubject: " Send proposal ",
    });
    expect(next).toEqual({
      dealStatus: "Open",
      dealValue: 750,
      dealCurrency: "GBP",
      channel: "referral",
      nextActivityDate: "2026-10-21",
      nextActivitySubject: "Send proposal",
    });
  });

  it("keeps a Pipedrive lead on its lead keys", () => {
    const next = applyDealDraft({ leadValue: 100, leadCurrency: "EUR" }, { ...draftFromFields({ leadValue: 100, leadCurrency: "EUR" }), owner: "Ben" });
    expect(next).toEqual({ leadValue: 100, leadCurrency: "EUR", leadOwner: "Ben" });
  });

  it("drops the next step text when no date is set, and rejects bad numbers", () => {
    expect(applyDealDraft({}, { ...draftFromFields({}), nextActivitySubject: "Call" })).toEqual({});
    expect(() => applyDealDraft({}, { ...draftFromFields({}), value: "lots" })).toThrow("Value must be a number");
    expect(() => applyDealDraft({}, { ...draftFromFields({}), probability: "140" })).toThrow("Probability must be between 0 and 100");
  });
});
