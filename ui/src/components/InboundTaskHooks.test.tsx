// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboundTaskHooksDialog, curlExample, hookStatusLine } from "./InboundTaskHooks";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  agents: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("@/api/inboundTaskHooks", () => ({
  inboundTaskHooksApi: { list: mocks.list, create: mocks.create, update: mocks.update, rotate: mocks.rotate, remove: mocks.remove },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hook = {
  id: "h1",
  name: "Website form",
  path: "/api/inbound/tasks/ith_abc",
  assigneeAgentId: null,
  enabled: true,
  lastUsedAt: null,
  useCount: 0,
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-10-16T00:00:00Z",
};

describe("InboundTaskHooksDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.agents.mockResolvedValue([{ id: "agent-1", name: "Ops" }]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <InboundTaskHooksDialog companyId="company-1" open onOpenChange={() => {}} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((element) => element.textContent?.includes(label)) as HTMLButtonElement;

  it("makes a webhook and shows its token once with a ready example", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ ...hook, token: "gsam_ith_secret" });
    await render();
    expect(document.body.textContent).toContain("No webhooks yet.");
    expect(button("Make webhook").disabled).toBe(true);

    const input = document.body.querySelector("#inbound-hook-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Website form");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Make webhook").click(); });
    await flush();

    expect(mocks.create).toHaveBeenCalledWith("company-1", { name: "Website form", assigneeAgentId: null });
    expect(document.body.textContent).toContain("The token is shown only once");
    expect((document.body.querySelector("input[aria-label=Token]") as HTMLInputElement).value).toBe("gsam_ith_secret");
    expect(document.body.querySelector("pre")?.textContent).toContain("Authorization: Bearer gsam_ith_secret");
  });

  it("lists webhooks with their status and turns one off", async () => {
    mocks.list.mockResolvedValue([{ ...hook, useCount: 2, lastUsedAt: new Date().toISOString() }]);
    mocks.update.mockResolvedValue({ ...hook, enabled: false });
    await render();
    expect(document.body.textContent).toContain("2 tasks created");
    expect(document.body.textContent).toContain("New tasks stay unassigned");
    const toggle = document.body.querySelector("[aria-label='Accept tasks from Website form']") as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    await flush();
    expect(mocks.update).toHaveBeenCalledWith("company-1", "h1", { enabled: false });
  });

  it("words the status line and the example", () => {
    expect(hookStatusLine({ ...hook, enabled: false })).toContain("Turned off");
    expect(hookStatusLine(hook)).toBe("Not used yet.");
    expect(hookStatusLine({ ...hook, useCount: 1, lastUsedAt: new Date().toISOString(), lastError: "File \"x\" is empty.", lastErrorAt: new Date().toISOString() }))
      .toMatch(/^1 task created, .* Last problem .*: File "x" is empty\.$/);
    expect(curlExample("https://gsam.test/api/inbound/tasks/ith_abc", "t")).toContain("curl -X POST https://gsam.test/api/inbound/tasks/ith_abc");
  });
});
