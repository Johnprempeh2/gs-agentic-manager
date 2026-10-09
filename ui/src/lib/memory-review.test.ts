import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { expiredProposal, invoiceProposal, ownProposal, reviewQueue } from "../fixtures/memoryReviewFixtures";
import { actionErrorText, mergeTargets, personWithApp, readReviewFilters, sortQueue } from "./memory-review";

describe("memory review helpers", () => {
  it("shows the person first with the app as a label", () => {
    expect(personWithApp(invoiceProposal.proposer)).toBe("Ama · via ChatGPT");
    expect(personWithApp(expiredProposal.proposer)).toBe("Everest");
  });

  it("reads only known filter values from the URL", () => {
    const filters = readReviewFilters(new URLSearchParams("scope=s1&person=user:u1&app=ChatGPT&age=overdue&conflict=true"));
    expect(filters).toEqual({ scopeId: "s1", person: "user:u1", app: "ChatGPT", age: "overdue", conflict: "true" });
    expect(readReviewFilters(new URLSearchParams("person=bob&age=old&conflict=yes"))).toEqual({
      scopeId: undefined,
      person: undefined,
      app: undefined,
      age: undefined,
      conflict: undefined,
    });
  });

  it("ranks expired proposals last and the rest oldest first", () => {
    expect(sortQueue(reviewQueue.items).map((item) => item.proposal.id)).toEqual([
      invoiceProposal.proposal.id,
      ownProposal.proposal.id,
      expiredProposal.proposal.id,
    ]);
  });

  it("offers the confirmed card, then other proposals in the same scope, as merge targets", () => {
    const targets = mergeTargets(invoiceProposal, reviewQueue.items);
    expect(targets.map((target) => target.id)).toEqual([invoiceProposal.current!.id, expiredProposal.proposal.id]);
  });

  it("says plainly when a card changed underneath the steward", () => {
    expect(actionErrorText(new ApiError("stale", 409, null))).toMatch(/changed since you opened it/);
    expect(actionErrorText(new ApiError("You proposed this card", 403, null))).toBe("You proposed this card");
  });
});
