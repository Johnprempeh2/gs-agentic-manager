// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@greatstone/shared";

const updateIssue = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../api/issues", () => ({
  issuesApi: { update: (...args: unknown[]) => updateIssue(...args) },
}));
const confirm = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@/context/ConfirmContext", () => ({ useConfirm: () => confirm }));
const pushToast = vi.fn();
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

import { IssuesBulkBar } from "./IssuesBulkBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  { id: "a1", name: "Ridge", status: "idle" },
  { id: "a2", name: "Gone", status: "terminated" },
] as unknown as Agent[];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(selectedIds: string[], onClear = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <IssuesBulkBar companyId="c1" agents={agents} selectedIds={selectedIds} onClear={onClear} onDone={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  return onClear;
}

async function choose(value: string) {
  const select = container!.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("IssuesBulkBar", () => {
  it("offers only working agents to assign to", async () => {
    await render(["t1"]);
    const options = [...container!.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toContain("Ridge");
    expect(options).not.toContain("Gone");
  });

  it("changes every selected task after a confirm, then clears the selection", async () => {
    const onClear = await render(["t1", "t2"]);
    await choose("status:done");
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Set 2 tasks to Done?" }));
    expect(updateIssue.mock.calls).toEqual([
      ["t1", { status: "done" }],
      ["t2", { status: "done" }],
    ]);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 tasks changed" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("does nothing when the confirm is declined", async () => {
    confirm.mockResolvedValueOnce(false);
    await render(["t1"]);
    await choose("assignee:a1");
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("keeps the change control off until a task is ticked", async () => {
    await render([]);
    expect((container!.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect(container!.textContent).toContain("Tick the tasks you want to change");
  });
});
