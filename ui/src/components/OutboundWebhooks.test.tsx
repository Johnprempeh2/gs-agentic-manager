// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundWebhooksDialog, eventsInWords, outboundStatusLine } from "./OutboundWebhooks";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  deliveries: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/api/outboundWebhooks", () => ({ outboundWebhooksApi: mocks }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The event checkboxes measure themselves; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const webhook = {
  id: "o1",
  name: "Slack #ops",
  maskedUrl: "https://hooks.slack.com/…ABCD",
  events: ["task.done", "decision.needed"],
  enabled: true,
  lastDeliveryAt: null,
  lastDeliveryOk: null,
  lastError: null,
  createdAt: "2026-10-16T04:00:00Z",
};

describe("OutboundWebhooksDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

  function type(selector: string, value: string) {
    const input = document.body.querySelector(selector) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function open() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <OutboundWebhooksDialog companyId="company-1" open onOpenChange={() => {}} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("adds an address with the default events and shows the signing secret once", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ ...webhook, signingSecret: "gsam_whsec_abc" });
    await open();
    expect(document.body.textContent).toContain("No addresses yet.");
    expect(button("Add address").disabled).toBe(true);
    type("#outbound-webhook-name", "Slack #ops");
    type("#outbound-webhook-url", "https://hooks.slack.com/services/T/B/ABCD");
    await act(async () => { button("Add address").click(); });
    await flush();
    expect(mocks.create).toHaveBeenCalledWith("company-1", {
      name: "Slack #ops",
      url: "https://hooks.slack.com/services/T/B/ABCD",
      events: ["task.done", "decision.needed", "client.stage_changed"],
    });
    expect((document.body.querySelector("input[aria-label='Signing secret']") as HTMLInputElement).value).toBe("gsam_whsec_abc");
  });

  it("sends a test and shows the delivery log", async () => {
    mocks.list.mockResolvedValue([webhook]);
    mocks.test.mockResolvedValue({ id: "d1", event: "test", summary: "Test", ok: false, httpStatus: 404, error: "The address answered 404", durationMs: 30, createdAt: new Date().toISOString() });
    mocks.deliveries.mockResolvedValue([
      { id: "d1", event: "task.done", summary: "Done: GS-1 Proposal", ok: true, httpStatus: 200, error: null, durationMs: 30, createdAt: new Date().toISOString() },
    ]);
    await open();
    expect(document.body.textContent).toContain("Sends when: a task is done, a decision is needed from you.");
    await act(async () => { button("Send test").click(); });
    await flush();
    expect(mocks.test).toHaveBeenCalledWith("company-1", "o1");
    expect(document.body.textContent).toContain("Test failed: The address answered 404");
    await act(async () => { button("Delivery log").click(); });
    await flush();
    expect(document.body.querySelector("ul[aria-label='Delivery log']")?.textContent).toContain("A task is done: Done: GS-1 Proposal. Sent.");
  });

  it("words the status and events", () => {
    expect(outboundStatusLine({ ...webhook, enabled: false } as never)).toContain("Turned off");
    expect(outboundStatusLine(webhook as never)).toBe("Nothing sent yet.");
    expect(eventsInWords(["client.stage_changed"])).toBe("a client moves stage");
  });
});
