// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { Calendar } from "./Calendar";

const api = vi.hoisted(() => ({ calendar: vi.fn(), update: vi.fn(), pushToast: vi.fn() }));

vi.mock("../api/calendar", () => ({ calendarApi: { get: api.calendar } }));
vi.mock("../api/issues", () => ({ issuesApi: { update: api.update } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: api.pushToast }) }));

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "task",
    id: "t1",
    date: "2026-10-20",
    title: "Send the proposal",
    identifier: "ACM-1",
    status: "todo",
    closed: false,
    agentName: null,
    goalTitle: null,
    times: [],
    runCount: 0,
    timeZone: null,
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

/** jsdom has no DataTransfer, so the test carries one on a plain event. */
function dragEvent(type: string, store: Map<string, string>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      get types() {
        return [...store.keys()];
      },
      setData: (key: string, value: string) => store.set(key, value),
      getData: (key: string) => store.get(key) ?? "",
      effectAllowed: "all",
      dropEffect: "none",
    },
  });
  return event;
}

describe("Calendar drag to reschedule", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.calendar.mockResolvedValue({
      from: "2026-09-28",
      to: "2026-11-01",
      items: [item({}), item({ kind: "goal", id: "g1", title: "Launch", identifier: null })],
    });
    api.update.mockResolvedValue({ id: "t1" });
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/calendar?month=2026-10&day=2026-10-20"]}>
            <Calendar />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await flushReact();
  }

  function chip(title: string) {
    return Array.from(container.querySelectorAll<HTMLAnchorElement>("a[draggable]")).find(
      (link) => link.textContent === title,
    );
  }


  it("only lets open tasks be dragged", async () => {
    await render();
    expect(chip("Send the proposal")?.getAttribute("draggable")).toBe("true");
    expect(chip("Launch")?.getAttribute("draggable")).toBe("false");
  });

  it("moves a task's due date to the day it is dropped on", async () => {
    await render();
    const store = new Map<string, string>();
    const target = Array.from(container.querySelectorAll("button[aria-pressed]")).find(
      (button) => button.textContent === "23",
    )!.parentElement!;
    await act(async () => {
      chip("Send the proposal")!.dispatchEvent(dragEvent("dragstart", store));
      target.dispatchEvent(dragEvent("dragover", store));
      target.dispatchEvent(dragEvent("drop", store));
    });
    await flushReact();
    expect(api.update).toHaveBeenCalledWith("t1", { dueDate: "2026-10-23" });
    expect(api.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("does nothing when a task is dropped on its own day", async () => {
    await render();
    const store = new Map<string, string>();
    const own = Array.from(container.querySelectorAll("button[aria-pressed]")).find(
      (button) => button.textContent === "20",
    )!.parentElement!;
    await act(async () => {
      chip("Send the proposal")!.dispatchEvent(dragEvent("dragstart", store));
      own.dispatchEvent(dragEvent("drop", store));
    });
    await flushReact();
    expect(api.update).not.toHaveBeenCalled();
  });
});
