// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { AgentProjectAccessSettings } from "./AgentProjectAccessSettings";

vi.mock("../api/agents", () => ({ agentsApi: {
  projectAccess: vi.fn(), addProjectAccess: vi.fn(),
} }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("agent project access repair", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.mocked(agentsApi.projectAccess).mockResolvedValue({ projectIds: ["first"], canManage: true });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <AgentProjectAccessSettings agentId="agent" companyId="company" projects={[
        { id: "first", name: "First" }, { id: "second", name: "Second" },
      ]} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

  it("keeps the selected project after a failed save so the operator can retry", async () => {
    vi.mocked(agentsApi.addProjectAccess).mockRejectedValue(new Error("Save failed"));
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { container.querySelector("button")!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(agentsApi.addProjectAccess).toHaveBeenCalledWith("agent", ["second"], "company");
    expect(container.querySelector("select")?.value).toBe("second");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
  });
});
