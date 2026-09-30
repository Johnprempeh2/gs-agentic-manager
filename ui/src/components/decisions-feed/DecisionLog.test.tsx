// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@greatstone/shared";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { DecisionLog, decisionLogEntry } from "./DecisionLog";

const event = (action: string, details: Record<string, unknown>, extra: Partial<ActivityEvent> = {}) => ({
  id: `${action}-1`,
  companyId: "company-1",
  actorType: "user",
  actorId: "board-user",
  action,
  entityType: "issue",
  entityId: "issue-1",
  agentId: null,
  runId: null,
  details,
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  ...extra,
}) as ActivityEvent;

describe("DecisionLog", () => {
  it("says what the board decided, with its reason when it sent work back", () => {
    expect(decisionLogEntry(event("issue.thread_interaction_accepted", { interactionKind: "request_confirmation" })))
      .toEqual({ verb: "Approved", reason: null });
    expect(decisionLogEntry(event("issue.thread_interaction_accepted", { interactionKind: "suggest_tasks" })).verb)
      .toBe("Accepted the suggested tasks");
    expect(decisionLogEntry(event("issue.thread_interaction_answered", {})).verb).toBe("Answered");
    expect(decisionLogEntry(event("issue.thread_interaction_rejected", { rejectionReason: "  Table this for now. " })))
      .toEqual({ verb: "Sent back", reason: "Table this for now." });
  });

  it("links each decision to its task", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <DecisionLog
          events={[event("issue.thread_interaction_rejected", { rejectionReason: "Use Docker" }, { issueIdentifier: "GRE-7", issueTitle: "Pick a runtime" })]}
        />,
      );
    });
    expect(container.querySelector("a[href='/issues/GRE-7']")?.textContent).toBe("GRE-7 Pick a runtime");
    expect(container.textContent).toContain("Sent back");
    expect(container.textContent).toContain('"Use Docker"');
    act(() => root.unmount());
  });
});
