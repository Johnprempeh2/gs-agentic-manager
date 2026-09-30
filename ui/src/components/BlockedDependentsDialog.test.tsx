// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendWithBlockedDependentsHandoff,
  BLOCKED_DEPENDENTS_CONFLICT_CODE,
} from "../lib/blocked-dependents-handoff";
import { ApiError } from "../api/client";
import { BlockedDependentsDialogHost } from "./BlockedDependentsDialog";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({ issuesApi: { list: listMock } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dependents = [
  { id: "dep-1", identifier: "GRE-2", title: "Wire the board", status: "todo" },
  { id: "dep-2", identifier: "GRE-3", title: "Write docs", status: "blocked" },
];

function conflict() {
  return new ApiError("GRE-1 still blocks open tasks", 409, {
    error: "GRE-1 still blocks open tasks",
    code: BLOCKED_DEPENDENTS_CONFLICT_CODE,
    details: { code: BLOCKED_DEPENDENTS_CONFLICT_CODE, dependents },
  });
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`No button "${text}"`);
  return button;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

/** Starts a cancel whose first send is refused with the blocked-dependents 409. */
async function startCancel() {
  const send = vi
    .fn<(data: Record<string, unknown>) => Promise<string>>()
    .mockRejectedValueOnce(conflict())
    .mockResolvedValue("saved");
  const result = sendWithBlockedDependentsHandoff("issue-1", { status: "cancelled" }, send);
  result.catch(() => undefined);
  await flush();
  return { send, result };
}

beforeEach(async () => {
  listMock.mockReset();
  listMock.mockResolvedValue([
    { id: "issue-1", identifier: "GRE-1", title: "The cancelled task", status: "in_progress" },
    { id: "dep-1", identifier: "GRE-2", title: "Wire the board", status: "todo" },
    { id: "done-1", identifier: "GRE-8", title: "Already shipped", status: "done" },
    { id: "kept-1", identifier: "GRE-9", title: "The kept task", status: "todo" },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <BlockedDependentsDialogHost />
      </QueryClientProvider>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("BlockedDependentsDialogHost (GRE-235)", () => {
  it("opens on the blocked-dependents 409 and lists each dependent", async () => {
    await startCancel();

    const list = document.querySelector('[aria-label="Blocked tasks"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("GRE-2");
    expect(list!.textContent).toContain("Wire the board");
    expect(list!.textContent).toContain("GRE-3");
    expect(list!.textContent).toContain("Write docs");
    expect(document.body.textContent).toContain("This task blocks 2 other tasks");
  });

  it("Remove re-sends the cancel with blockedDependents remove", async () => {
    const { send, result } = await startCancel();

    await click(buttonByText("Remove blocker"));

    await expect(result).resolves.toBe("saved");
    expect(send).toHaveBeenLastCalledWith({ status: "cancelled", blockedDependents: { action: "remove" } });
    expect(document.querySelector('[aria-label="Blocked tasks"]')).toBeNull();
  });

  it("Move lets you pick an open task and re-sends with blockedDependents move", async () => {
    const { send, result } = await startCancel();

    await click(buttonByText("Move to another task"));
    const targets = document.querySelector('[aria-label="Tasks to wait on"]')!;
    // The cancelled task, its dependents and closed tasks are not offered.
    expect(targets.textContent).not.toContain("GRE-1");
    expect(targets.textContent).not.toContain("GRE-2");
    expect(targets.textContent).not.toContain("GRE-8");
    expect(buttonByText("Move and cancel task").disabled).toBe(true);

    const kept = Array.from(targets.querySelectorAll("button")).find((b) => b.textContent?.includes("GRE-9"))!;
    await click(kept);
    await click(buttonByText("Move and cancel task"));

    await expect(result).resolves.toBe("saved");
    expect(send).toHaveBeenLastCalledWith({
      status: "cancelled",
      blockedDependents: { action: "move", issueId: "kept-1" },
    });
  });

  it("Cancel closes the dialog without re-sending", async () => {
    const { send, result } = await startCancel();

    await click(buttonByText("Cancel"));

    await expect(result).rejects.toThrow("Nothing changed");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
