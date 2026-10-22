// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeedsMe } from "@greatstone/shared";
import { FIXTURE_COMPANY_ID, connectionAlertCard, questionCard } from "../fixtures/decisionsFeedFixtures";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { NeedsMeList, formatWaitAge } from "./NeedsMeList";

let container: HTMLDivElement;
let root: Root;

function needsMe(overrides: Partial<NeedsMe> = {}): NeedsMe {
  const decisions = overrides.decisions ?? [questionCard(), connectionAlertCard()];
  const assignedTasks = overrides.assignedTasks ?? [
    {
      id: "issue-9",
      identifier: "GRE-9",
      title: "Sign off the Indago statement of work",
      status: "todo",
      priority: "high",
      updatedAt: "2026-10-02T05:00:00.000Z",
    },
  ];
  return {
    companyId: FIXTURE_COMPANY_ID,
    generatedAt: "2026-10-02T05:00:00.000Z",
    count: decisions.length + assignedTasks.length,
    decisionCount: decisions.length,
    assignedTaskCount: assignedTasks.length,
    decisions,
    assignedTasks,
    overdueWaits: overrides.overdueWaits ?? [],
    expiredCards: overrides.expiredCards ?? [],
  };
}

function render(node: ReactNode) {
  act(() => root.render(node));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NeedsMeList (GRE-358)", () => {
  it("Inbox Mine: lists only the assigned tasks, with their own count, never decisions", () => {
    const data = needsMe();
    render(<NeedsMeList needsMe={{ ...data, overdueWaits: [], expiredCards: [] }} />);

    expect(container.querySelector('section[aria-label="Needs you"]')).toBeNull();
    const section = container.querySelector('section[aria-label="Assigned to you"]');
    expect(section!.querySelector("h2")?.textContent).toContain(String(data.assignedTaskCount));
    expect(section!.querySelectorAll("li")).toHaveLength(data.assignedTaskCount);
    expect(container.querySelector('a[href="/issues/GRE-9"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Decision");
  });

  it("Decisions and Focus: shows only assigned tasks, since cards are already on screen", () => {
    render(<NeedsMeList needsMe={needsMe()} />);

    const section = container.querySelector('section[aria-label="Assigned to you"]');
    expect(section).not.toBeNull();
    expect(section!.querySelectorAll("li")).toHaveLength(1);
    expect(container.textContent).toContain("Sign off the Indago statement of work");
    expect(container.textContent).not.toContain("Decision");
  });

  it("shows waits on the Desk under Overdue, with no second count", () => {
    const data = needsMe({
      assignedTasks: [],
      overdueWaits: [
        {
          id: "issue-7",
          identifier: "GRE-7",
          title: "Sign the contract",
          status: "blocked",
          priority: "high",
          updatedAt: "2026-10-01T05:00:00.000Z",
          assigneeAgentId: "agent-1",
          owner: "user",
          action: "John signs.",
          waitingSinceAt: "2026-09-30T03:00:00.000Z",
          waitingForMs: 48 * 60 * 60 * 1000,
          recheckWokenAt: "2026-10-01T03:00:00.000Z",
        },
      ],
    });
    render(<NeedsMeList needsMe={data} includeAssigned={false} />);
    const section = container.querySelector('section[aria-label="Overdue"]');
    expect(section).not.toBeNull();
    // The rows are part of the Decisions count above them: no number of their own.
    expect(section!.querySelector("h2")?.textContent).toBe("Overdue");
    expect(container.textContent).toContain("Waiting 2d");
    expect(container.querySelector('a[href="/issues/GRE-7"]')).not.toBeNull();
  });

  it("lists an agent's expired question under Overdue, linking to its task", () => {
    const data = needsMe({
      assignedTasks: [],
      expiredCards: [
        {
          interactionId: "card-1",
          id: "issue-12",
          identifier: "GRE-12",
          title: "Book the Indago interviews",
          question: "Which week suits you?",
          expiredAt: "2026-10-02T04:00:00.000Z",
        },
      ],
    });
    render(<NeedsMeList needsMe={data} includeAssigned={false} />);
    expect(container.querySelector('section[aria-label="Overdue"]')).not.toBeNull();
    const row = container.querySelector('[data-testid="needs-me-expired-card"]');
    expect(row?.textContent).toContain("Question expired");
    expect(row?.textContent).toContain("Which week suits you?");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe("/issues/GRE-12");
  });

  it("formats wait ages in days and hours", () => {
    const hour = 60 * 60 * 1000;
    expect(formatWaitAge(5 * hour)).toBe("5h");
    expect(formatWaitAge(24 * hour)).toBe("1d");
    expect(formatWaitAge(27 * hour + 59 * 60 * 1000)).toBe("1d 3h");
  });

  it("leaves assigned tasks out when asked, as on the Decisions page (GRE-586)", () => {
    render(<NeedsMeList needsMe={needsMe()} includeAssigned={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when nothing is assigned and decisions are left out", () => {
    render(<NeedsMeList needsMe={needsMe({ assignedTasks: [] })} />);
    expect(container.innerHTML).toBe("");
  });
});
