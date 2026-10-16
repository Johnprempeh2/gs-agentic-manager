import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, localToday } from "@/lib/calendar";
import { IssueDueDateRow } from "./IssueDueDateRow";

const api = vi.hoisted(() => ({ goals: vi.fn() }));
vi.mock("@/api/goals", () => ({ goalsApi: { list: api.goals } }));

async function flushReact() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("IssueDueDateRow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.goals.mockResolvedValue([
      { id: "csf", parentId: null, kind: "csf", status: "active", title: "CSF" },
      { id: "objective", parentId: "csf", kind: "objective", status: "active", title: "Objective" },
    ]);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render(props: { goalId: string | null; dueDate: string | null; status?: string }, onUpdate = vi.fn()) {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <IssueDueDateRow companyId="c1" status="todo" onUpdate={onUpdate} {...props} />
        </QueryClientProvider>,
      ),
    );
    await flushReact();
    return onUpdate;
  }

  function shortcut(label: string) {
    return Array.from(container.querySelectorAll('[aria-label="Quick due dates"] button')).find(
      (button) => button.textContent === label,
    ) as HTMLButtonElement | undefined;
  }

  it("sets an overdue task's due date to today in one click", async () => {
    const onUpdate = await render({ goalId: "objective", dueDate: addDays(localToday(), -2) });
    expect(container.textContent).toContain("Overdue");
    await act(async () => {
      shortcut("Today")!.click();
    });
    expect(onUpdate).toHaveBeenCalledWith({ dueDate: localToday() });
  });

  it("leaves out the shortcut for the date the task already has, and all of them once it is done", async () => {
    await render({ goalId: "objective", dueDate: localToday() });
    expect(shortcut("Today")).toBeUndefined();
    expect(shortcut("Tomorrow")).toBeDefined();
    await render({ goalId: "objective", dueDate: localToday(), status: "done" });
    expect(container.querySelector('[aria-label="Quick due dates"]')).toBeNull();
  });

  it("shows a read-only date in words", async () => {
    await render({ goalId: null, dueDate: "2026-10-31", status: "done" });
    expect(container.textContent).toContain("31 Oct 2026");
  });
});
