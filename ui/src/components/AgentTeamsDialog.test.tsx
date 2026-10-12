// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentTeam } from "@greatstone/shared";
import { AgentTeamsDialog } from "./AgentTeamsDialog";

const mockAgentTeamsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/api/agentTeams", () => ({ agentTeamsApi: mockAgentTeamsApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Radix checkbox and select measure themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const agents = [
  { id: "a-mason", name: "Mason", status: "idle" },
  { id: "a-mica", name: "Mica", status: "idle" },
] as Agent[];

const platform: AgentTeam = {
  id: "t-1",
  companyId: "c-1",
  name: "Platform",
  color: "#2563eb",
  description: null,
  leadAgentId: "a-mason",
  memberAgentIds: ["a-mason"],
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

function buttonByText(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === text);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentTeamsDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAgentTeamsApi.create.mockResolvedValue(platform);
    mockAgentTeamsApi.update.mockResolvedValue(platform);
    mockAgentTeamsApi.remove.mockResolvedValue(platform);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(teams: AgentTeam[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentTeamsDialog companyId="c-1" teams={teams} agents={agents} onClose={() => {}} />
        </QueryClientProvider>,
      );
    });
  }

  it("shows an empty state, then creates a team with the chosen members", async () => {
    render([]);
    expect(document.body.textContent).toContain("No teams yet.");

    act(() => buttonByText("New team")!.click());
    const name = document.body.querySelector("input")! as HTMLInputElement;
    act(() => setInputValue(name, "  Platform "));
    const micaBox = Array.from(document.body.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Mica"))!
      .querySelector("button[role=checkbox]") as HTMLButtonElement;
    act(() => micaBox.click());
    act(() => buttonByText("Create team")!.click());
    await flush();

    expect(mockAgentTeamsApi.create).toHaveBeenCalledWith("c-1", {
      name: "Platform",
      color: "#2563eb",
      description: null,
      leadAgentId: null,
      memberAgentIds: ["a-mica"],
    });
  });

  it("lists teams with their lead and asks before deleting", async () => {
    render([platform]);
    expect(document.body.textContent).toContain("1 member · Lead: Mason");

    act(() => (document.body.querySelector('[aria-label="Delete Platform"]') as HTMLButtonElement).click());
    expect(mockAgentTeamsApi.remove).not.toHaveBeenCalled();
    act(() => buttonByText("Delete")!.click());
    await flush();
    expect(mockAgentTeamsApi.remove).toHaveBeenCalledWith("t-1");
  });

  it("unticking the lead clears the lead when saving an edit", async () => {
    render([platform]);
    act(() => buttonByText("Edit")!.click());
    const masonBox = Array.from(document.body.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Mason"))!
      .querySelector("button[role=checkbox]") as HTMLButtonElement;
    act(() => masonBox.click());
    act(() => buttonByText("Save team")!.click());
    await flush();
    expect(mockAgentTeamsApi.update).toHaveBeenCalledWith("t-1", expect.objectContaining({
      leadAgentId: null,
      memberAgentIds: [],
    }));
  });

  it("shows the server error when saving fails", async () => {
    mockAgentTeamsApi.create.mockRejectedValue(new Error("A team with this name already exists"));
    render([]);
    act(() => buttonByText("New team")!.click());
    act(() => setInputValue(document.body.querySelector("input") as HTMLInputElement, "Platform"));
    act(() => buttonByText("Create team")!.click());
    await flush();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("A team with this name already exists");
  });
});
