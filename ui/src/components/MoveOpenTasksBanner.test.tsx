// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const listIssues = vi.fn(async (..._args: unknown[]) => [{ id: "t1" }, { id: "t2" }]);
const updateIssue = vi.fn(async (..._args: unknown[]) => ({}));
const listAgents = vi.fn(async () => [
  { id: "a1", name: "Ridge", status: "paused" },
  { id: "a2", name: "Mason", status: "idle" },
  { id: "a3", name: "Gone", status: "terminated" },
]);
vi.mock("../api/issues", () => ({
  issuesApi: { list: (...args: unknown[]) => listIssues(...args), update: (...args: unknown[]) => updateIssue(...args) },
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: () => listAgents() } }));
vi.mock("@/context/ConfirmContext", () => ({ useConfirm: () => async () => true }));
const pushToast = vi.fn();
vi.mock("../context/ToastContext", () => ({ useOptionalToastActions: () => ({ pushToast }) }));

import { MoveOpenTasksBanner } from "./MoveOpenTasksBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function render(status: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MoveOpenTasksBanner companyId="c1" agent={{ id: "a1", name: "Ridge", status }} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("MoveOpenTasksBanner", () => {
  it("stays hidden for a working agent", async () => {
    const root = await render("idle");
    expect(root.textContent).toBe("");
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("moves every open task to the chosen working agent", async () => {
    const root = await render("paused");
    expect(root.textContent).toContain("Ridge still has 2 open tasks");
    const select = root.querySelector("select")!;
    const options = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["Choose an agent", "Mason"]);
    await act(async () => {
      select.value = "a2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === "Move 2 tasks")!;
    await act(async () => {
      button.click();
    });
    expect(updateIssue).toHaveBeenCalledTimes(2);
    expect(updateIssue).toHaveBeenCalledWith("t1", { assigneeAgentId: "a2" });
    expect(updateIssue).toHaveBeenCalledWith("t2", { assigneeAgentId: "a2" });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 tasks moved" }));
  });
});
