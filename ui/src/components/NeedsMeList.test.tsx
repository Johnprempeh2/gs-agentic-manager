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

import { NeedsMeList } from "./NeedsMeList";

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

  it("renders nothing when nothing is assigned and decisions are left out", () => {
    render(<NeedsMeList needsMe={needsMe({ assignedTasks: [] })} />);
    expect(container.innerHTML).toBe("");
  });
});
