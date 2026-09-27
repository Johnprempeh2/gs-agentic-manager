import { describe, expect, it } from "vitest";
import { noContactAutofill } from "./no-contact-autofill";

describe("noContactAutofill", () => {
  it("turns autocomplete off and gives the field a search name Safari skips", () => {
    expect(noContactAutofill("routine")).toEqual({ autoComplete: "off", name: "search_routine" });
  });
});
