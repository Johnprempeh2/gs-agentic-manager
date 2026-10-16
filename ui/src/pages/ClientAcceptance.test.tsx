// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClientAcceptance } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { ClientAcceptancePage } from "./ClientAcceptance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The Radix checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const api = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn() }));
vi.mock("../api/clientAcceptance", () => ({ clientAcceptanceApi: api }));

const open: PublicClientAcceptance = {
  companyName: "Greatstone",
  clientName: "Omni Group",
  packTitle: "Engagement pack",
  packPath: "/api/client-acceptance/gsa_accept_abc/pack",
  status: "open",
  expiresAt: "2026-11-15T09:00:00.000Z",
  acceptedAt: null,
  acceptedName: null,
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ClientAcceptancePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/accept/gsa_accept_abc"]}>
          <Routes>
            <Route path="accept/:token" element={<ClientAcceptancePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await vi.waitFor(async () => {
      await flush();
      expect(container.textContent).not.toContain("Loading...");
    });
  }

  it("shows the pack and accepts once the form is complete", async () => {
    api.get.mockResolvedValue(open);
    api.accept.mockResolvedValue({ ...open, status: "accepted", acceptedAt: "2026-10-16T10:00:00.000Z", acceptedName: "Ada Mensah" });
    await render();
    expect(api.get).toHaveBeenCalledWith("gsa_accept_abc");
    expect(container.textContent).toContain("Engagement pack for Omni Group");
    expect(container.querySelector<HTMLAnchorElement>("a[href='/api/client-acceptance/gsa_accept_abc/pack']")).not.toBeNull();

    const submit = container.querySelector<HTMLButtonElement>("button[type='submit']")!;
    expect(submit.disabled).toBe(true);
    type(container.querySelector<HTMLInputElement>("#client-acceptance-name")!, "Ada Mensah");
    type(container.querySelector<HTMLInputElement>("#client-acceptance-email")!, "ada@omni.com");
    expect(submit.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>("#client-acceptance-agree")!.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await vi.waitFor(async () => {
      await flush();
      expect(container.querySelector("[data-testid='client-acceptance-done']")).not.toBeNull();
    });

    expect(api.accept).toHaveBeenCalledWith("gsa_accept_abc", { name: "Ada Mensah", role: null, email: "ada@omni.com", agree: true });
    expect(container.querySelector("[data-testid='client-acceptance-done']")!.textContent).toContain("Ada Mensah accepted");
  });

  it("says plainly when the link no longer works", async () => {
    api.get.mockRejectedValue(new ApiError("This link has expired", 404, null));
    await render();
    expect(container.querySelector("[data-testid='client-acceptance-missing']")!.textContent).toContain("Ask your contact to send you a new one");
  });
});
