import { describe, expect, it } from "vitest";
import type { DecisionCard, NeedsMe } from "@greatstone/shared";
import { questionCard, reviewCard } from "../fixtures/decisionsFeedFixtures";
import { needsYouAsks } from "./needs-you-rows";

function confirmationCard(): DecisionCard {
  const card = questionCard("int-7", "issue-42", "GRE-42");
  card.decision = "Confirm the launch date is 3 November.";
  card.items = card.items.map((item) => ({
    ...item,
    subject: { ...item.subject, metadata: { ...item.subject.metadata, kind: "request_confirmation" } },
  })) as DecisionCard["items"];
  return card;
}

function needsMe(input: Partial<NeedsMe>): NeedsMe {
  return {
    companyId: "company-1",
    generatedAt: "",
    count: 0,
    decisionCount: 0,
    assignedTaskCount: 0,
    decisions: [],
    assignedTasks: [],
    overdueWaits: [],
    ...input,
  };
}

describe("needsYouAsks", () => {
  it("names each ask the way Desk does and opens a question on its own card", () => {
    const asks = needsYouAsks(needsMe({ decisions: [reviewCard(), questionCard(), confirmationCard()] }));
    expect(asks.get("issue-120")).toEqual({
      action: "Review",
      prompt: "Summit asks you to review the new price list.",
      href: "/issues/GRE-120",
    });
    expect(asks.get("issue-44")).toMatchObject({ action: "Question", href: "/issues/GRE-44#interaction-int-1" });
    expect(asks.get("issue-42")).toMatchObject({
      action: "Confirmation",
      prompt: "Confirm the launch date is 3 November.",
      href: "/issues/GRE-42#interaction-int-7",
    });
  });

  it("labels assigned tasks and overdue waits, and keeps the first ask for a task", () => {
    const asks = needsYouAsks(needsMe({
      decisions: [reviewCard()],
      assignedTasks: [
        { id: "issue-120", identifier: "GRE-120", title: "New price list for 2027", status: "in_review", priority: "low", updatedAt: "" },
        { id: "t1", identifier: "GRE-9", title: "Sign the lease", status: "todo", priority: "low", updatedAt: "" },
      ],
      overdueWaits: [{
        id: "w1", identifier: "GRE-10", title: "Bank details", status: "blocked", priority: "low", updatedAt: "",
        assigneeAgentId: null, owner: "user", action: "Send the bank details to Ridge.", waitingSinceAt: "", waitingForMs: 0, recheckWokenAt: null,
      }],
    }));
    expect(asks.get("issue-120")?.action).toBe("Review");
    expect(asks.get("t1")).toEqual({ action: "Your task", prompt: null, href: null });
    expect(asks.get("w1")).toEqual({ action: "Waiting on you", prompt: "Send the bank details to Ridge.", href: null });
  });

  it("is empty before the data loads", () => {
    expect(needsYouAsks(undefined).size).toBe(0);
  });
});
