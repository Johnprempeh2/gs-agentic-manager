// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { localToday, rescheduleOptions } from "../lib/calendar";
import { Calendar } from "./Calendar";

const api = vi.hoisted(() => ({ calendar: vi.fn(), update: vi.fn(), pushToast: vi.fn(), copy: vi.fn() }));

vi.mock("../api/calendar", () => ({ calendarApi: { get: api.calendar } }));
vi.mock("../api/issues", () => ({ issuesApi: { update: api.update } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "c1", selectedCompany: { id: "c1", name: "Acme", issuePrefix: "ACM" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: api.copy }));
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

// Radix DropdownMenu opens and selects on pointer events, not a bare click.
function pointerClick(el: Element) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  (el as HTMLElement).click();
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

  it("moves a task's due date from the day list menu, which also works on phones", async () => {
    await render();
    const trigger = container.querySelector('[aria-label="Change the due date of Send the proposal"]');
    expect(trigger).not.toBeNull();
    // Goals have no menu.
    expect(container.querySelector('[aria-label="Change the due date of Launch"]')).toBeNull();
    await act(async () => pointerClick(trigger!));
    await flushReact();
    const first = rescheduleOptions("2026-10-20", localToday())[0]!;
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) =>
      node.textContent?.startsWith(first.label),
    );
    expect(item).toBeDefined();
    await act(async () => pointerClick(item!));
    await flushReact();
    expect(api.update).toHaveBeenCalledWith("t1", { dueDate: first.date });
  });

  it("copies the week ahead as text", async () => {
    const today = localToday();
    api.calendar.mockResolvedValue({ from: today, to: today, items: [item({ date: today, title: "Due today" })] });
    api.copy.mockResolvedValue(undefined);
    await render();
    const button = container.querySelector('[aria-label="Copy the week ahead"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(api.copy).toHaveBeenCalledTimes(1);
    const text = api.copy.mock.calls[0]![0] as string;
    expect(text).toMatch(/^The week ahead, /);
    expect(text).toContain("Due: ACM-1 Due today");
    expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull();
  });

  it("shows one week with every item in week view", async () => {
    api.calendar.mockResolvedValue({
      from: "2026-09-28",
      to: "2026-11-01",
      items: [
        ...[1, 2, 3, 4, 5].map((n) => item({ id: `t${n}`, title: `Task ${n}`, identifier: `ACM-${n}` })),
        item({ id: "other", date: "2026-10-05", title: "Other week" }),
      ],
    });
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/calendar?month=2026-10&day=2026-10-20&view=week"]}>
            <Calendar />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await flushReact();
    const text = container.textContent ?? "";
    expect(text).toContain("19 to 25 October 2026");
    expect(text).toContain("5 this week");
    // No "+N more": all five tasks on the 20th show in the grid.
    expect(text).not.toContain("more");
    expect(chip("Task 5")).toBeDefined();
    expect(chip("Other week")).toBeUndefined();
    expect(container.querySelector('[aria-label="Next week"]')).not.toBeNull();
  });
});
