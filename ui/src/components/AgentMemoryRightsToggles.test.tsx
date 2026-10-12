// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryRightsToggles } from "./AgentMemoryRightsToggles";

const settingsMock = vi.hoisted(() => vi.fn());
const changeGrantMock = vi.hoisted(() => vi.fn());
const boardAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/memoryGraph", () => ({
  memoryGraphApi: {
    settings: (companyId: string) => settingsMock(companyId),
    changeGrant: (companyId: string, body: unknown) => changeGrantMock(companyId, body),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: () => boardAccessMock() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyId = "company-1";
const agentId = "agent-1";

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentMemoryRightsToggles", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChanged = vi.fn();
  const onError = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    settingsMock.mockResolvedValue({ companyId, enabled: true, retainMode: "extract", updatedAt: null });
    boardAccessMock.mockResolvedValue({
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });
    changeGrantMock.mockResolvedValue({ principalType: "agent", principalId: agentId, permissions: ["memory:contribute"] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(grants: Array<{ permissionKey: string; scope?: unknown }> = []) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentMemoryRightsToggles
            companyId={companyId}
            agentId={agentId}
            grants={grants}
            onChanged={onChanged}
            onError={onError}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const toggle = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;

  it("writes through the memory grants route for an owner", async () => {
    await render([{ permissionKey: "memory:approve", scope: null }]);
    const contribute = toggle("Can contribute to organisation memory")!;
    expect(contribute.disabled).toBe(false);
    await act(async () => contribute.click());
    await flush();
    expect(changeGrantMock).toHaveBeenCalledWith(companyId, expect.objectContaining({
      principalType: "agent",
      principalId: agentId,
      permission: "memory:contribute",
      enabled: true,
    }));
    expect(onChanged).toHaveBeenCalled();

    await act(async () => toggle("Can approve organisation memory (operational)")!.click());
    await flush();
    expect(changeGrantMock).toHaveBeenLastCalledWith(companyId, expect.objectContaining({
      permission: "memory:approve",
      enabled: false,
    }));
  });

  it("shows the server refusal", async () => {
    changeGrantMock.mockRejectedValue(new Error("Only a company owner or admin can set memory rights"));
    await render();
    await act(async () => toggle("Can contribute to organisation memory")!.click());
    await flush();
    expect(onError).toHaveBeenCalledWith("Only a company owner or admin can set memory rights");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("locks the toggles for a caller who cannot grant", async () => {
    boardAccessMock.mockResolvedValue({
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    });
    await render();
    expect(toggle("Can contribute to organisation memory")!.disabled).toBe(true);
    expect(toggle("Can approve organisation memory (operational)")!.disabled).toBe(true);
    expect(container.textContent).toContain("Only a company owner or admin can change this.");
  });

  it("locks a toggle whose grant has its own scope settings", async () => {
    await render([{ permissionKey: "memory:contribute", scope: { memoryScopeIds: ["client-1"] } }]);
    expect(toggle("Can contribute to organisation memory")!.disabled).toBe(true);
    expect(toggle("Can approve organisation memory (operational)")!.disabled).toBe(false);
  });

  it("is not offered while memory is off", async () => {
    settingsMock.mockResolvedValue({ companyId, enabled: false, retainMode: "extract", updatedAt: null });
    await render();
    expect(toggle("Can contribute to organisation memory")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
