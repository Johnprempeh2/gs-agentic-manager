// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClientDeliverable } from "@greatstone/shared";
import { ApiError } from "../api/client";
import { ClientDeliverablePage } from "./ClientDeliverable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The Radix checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const api = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn() }));
vi.mock("../api/clientPublications", () => ({ clientDeliverableApi: api }));

const open: PublicClientDeliverable = {
  companyName: "Greatstone",
  clientName: "Omni Group",
  title: "North Star summary",
  version: 2,
  contentPath: "/api/client-deliverable/gsa_deliver_abc/content",
  url: null,
  status: "open",
  expiresAt: "2026-11-24T09:00:00.000Z",
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

describe("ClientDeliverablePage", () => {
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
        <MemoryRouter initialEntries={["/deliverable/gsa_deliver_abc"]}>
          <Routes>
            <Route path="deliverable/:token" element={<ClientDeliverablePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await vi.waitFor(async () => {
      await flush();
      expect(container.textContent).not.toContain("Loading...");
    });
  }

  it("shows the frozen deliverable and accepts once the form is complete", async () => {
    api.get.mockResolvedValue(open);
    api.accept.mockResolvedValue({ ...open, status: "accepted", acceptedAt: "2026-10-25T10:00:00.000Z", acceptedName: "Ada Mensah" });
    await render();
    expect(api.get).toHaveBeenCalledWith("gsa_deliver_abc");
    expect(container.textContent).toContain("North Star summary for Omni Group");
    expect(container.querySelector<HTMLAnchorElement>("a[href='/api/client-deliverable/gsa_deliver_abc/content']")).not.toBeNull();

    const submit = container.querySelector<HTMLButtonElement>("button[type='submit']")!;
    expect(submit.disabled).toBe(true);
    type(container.querySelector<HTMLInputElement>("#client-deliverable-name")!, "Ada Mensah");
    type(container.querySelector<HTMLInputElement>("#client-deliverable-email")!, "ada@omni.com");
    expect(submit.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>("#client-deliverable-agree")!.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await vi.waitFor(async () => {
      await flush();
      expect(container.querySelector("[data-testid='client-deliverable-done']")).not.toBeNull();
    });

    expect(api.accept).toHaveBeenCalledWith("gsa_deliver_abc", { name: "Ada Mensah", role: null, email: "ada@omni.com", agree: true });
    expect(container.querySelector("[data-testid='client-deliverable-done']")!.textContent).toContain("Ada Mensah accepted North Star summary");
    expect(container.textContent).toContain("You will get a receipt by email");
  });

  it("says plainly when the link no longer works", async () => {
    api.get.mockRejectedValue(new ApiError("This link has expired", 404, null));
    await render();
    expect(container.querySelector("[data-testid='client-deliverable-missing']")!.textContent).toContain("Ask your contact to send you a new one");
  });
});
