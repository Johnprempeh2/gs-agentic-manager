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

import { ActivityRow } from "./ActivityRow";

describe("ActivityRow", () => {
  it("keeps reference chips outside the row link, so no link sits inside another", () => {
    const event = {
      id: "event-1",
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-18",
      details: { addedReferencedIssues: [{ id: "issue-231", identifier: "GRE-231", title: "Referenced task" }] },
      createdAt: new Date("2026-09-30T10:00:00.000Z"),
    } as unknown as ActivityEvent;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ActivityRow
          event={event}
          agentMap={new Map()}
          entityNameMap={new Map([["issue:issue-18", "GRE-18"]])}
        />,
      );
    });

    expect(container.querySelector("a[href='/issues/GRE-18']")).not.toBeNull();
    expect(container.textContent).toContain("GRE-231");
    expect(container.querySelector("a a")).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("names the task from the activity row when the page has no map entry for it", () => {
    const event = {
      id: "event-2",
      companyId: "company-1",
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-99",
      details: { status: "blocked" },
      createdAt: new Date("2026-09-30T10:00:00.000Z"),
      issueIdentifier: "GRE-99",
      issueTitle: "Renew the domain",
    } as unknown as ActivityEvent;
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(<ActivityRow event={event} agentMap={new Map()} entityNameMap={new Map()} />);
    });
    expect(container.textContent).toContain("GRE-99");
    expect(container.textContent).toContain("Renew the domain");
    expect(container.querySelector("a[href='/issues/GRE-99']")).not.toBeNull();
    act(() => root.unmount());
  });
});
