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
  it("Inbox: lists decisions and assigned tasks under one count that matches needs-me", () => {
    const data = needsMe();
    render(<NeedsMeList needsMe={data} includeDecisions />);

    const section = container.querySelector('section[aria-label="Needs you"]');
    expect(section).not.toBeNull();
    expect(section!.querySelector("h2")?.textContent).toContain(String(data.count));
    expect(section!.querySelectorAll("li")).toHaveLength(data.count);
    expect(container.textContent).toContain("Sign off the Indago statement of work");
    expect(container.querySelector('a[href="/issues/GRE-9"]')).not.toBeNull();
    // Task cards open their task; company-level cards open Decisions.
    expect(container.querySelector('a[href="/issues/GRE-44"]')).not.toBeNull();
    expect(container.querySelector('a[href="/decisions"]')).not.toBeNull();
  });

  it("Decisions and Focus: shows only assigned tasks, since cards are already on screen", () => {
    render(<NeedsMeList needsMe={needsMe()} />);

    const section = container.querySelector('section[aria-label="Assigned to you"]');
    expect(section).not.toBeNull();
    expect(section!.querySelectorAll("li")).toHaveLength(1);
    expect(container.textContent).toContain("Sign off the Indago statement of work");
    expect(container.textContent).not.toContain("Decision");
  });

  it("lists a wait over 24h first, with its age, once (GRE-500)", () => {
    const card = questionCard();
    const data = needsMe({
      decisions: [card],
      assignedTasks: [],
      overdueWaits: [
        {
          id: card.task!.id,
          identifier: card.task!.identifier,
          title: "Pick the release month",
          status: "blocked",
          priority: "high",
          updatedAt: "2026-10-01T05:00:00.000Z",
          assigneeAgentId: "agent-1",
          owner: "board",
          action: "John picks the month.",
          waitingSinceAt: "2026-10-01T03:00:00.000Z",
          waitingForMs: 26 * 60 * 60 * 1000,
          recheckWokenAt: null,
        },
      ],
    });
    render(<NeedsMeList needsMe={data} includeDecisions />);

    const items = container.querySelectorAll("li");
    // The wait replaces its own decision card: one row, not two.
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Waiting 1d 2h");
    expect(items[0]!.textContent).toContain("Pick the release month");
  });

  it("shows waits on the Decisions page too, under Needs you", () => {
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
    render(<NeedsMeList needsMe={data} />);
    expect(container.querySelector('section[aria-label="Needs you"]')).not.toBeNull();
    expect(container.textContent).toContain("Waiting 2d");
    expect(container.querySelector('a[href="/issues/GRE-7"]')).not.toBeNull();
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
