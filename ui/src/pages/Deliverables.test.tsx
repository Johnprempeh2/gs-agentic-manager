// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import type { Deliverable, DeliverablesResponse } from "../api/deliverables";
import { DELIVERABLE_IFRAME_SANDBOX } from "../components/deliverables/DeliverableDocument";
import { Deliverables, EXAMPLE_DELIVERABLE_PROMPT, dateRangeStart, groupDeliverables } from "./Deliverables";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deliverablesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  markOpened: vi.fn(),
  mark: vi.fn(),
}));

vi.mock("../api/deliverables", () => ({ deliverablesApi: deliverablesApiMock }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => <span data-testid="agent-avatar" /> }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useSearchParams: actual.useSearchParams,
    Link: ({ to, children, disableIssueQuicklook: _ignored, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

function sample(overrides: Partial<Deliverable> = {}): Deliverable {
  const id = overrides.id ?? "d-1";
  return {
    id,
    companyId: "company-1",
    key: "q3-board-pack",
    version: 1,
    versionCount: 1,
    title: "Q3 board pack",
    summary: "Numbers for the board",
    kind: "report",
    brand: "Greatstone",
    status: "final",
    attachmentId: `att-${id}`,
    contentType: "text/html",
    byteSize: 100,
    originalFilename: "q3.html",
    contentPath: `/api/attachments/att-${id}/content`,
    openPath: `/api/attachments/att-${id}/content`,
    downloadPath: `/api/attachments/att-${id}/content?download=1`,
    issue: { id: "issue-1", identifier: "GRE-1", title: "Quarterly pack" },
    project: { id: "project-1", name: "Board" },
    createdByAgent: { id: "agent-1", name: "Everest" },
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    lastOpenedAt: null,
    href: "/GRE/issues/GRE-1#work-product-d-1",
    ...overrides,
  };
}

function response(deliverables: Deliverable[]): DeliverablesResponse {
  return {
    deliverables,
    total: deliverables.length,
    nextOffset: null,
    facets: { brands: ["Greatstone"], agents: [{ id: "agent-1", name: "Everest" }], projects: [{ id: "project-1", name: "Board" }] },
  };
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Deliverables page", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(entry = "/deliverables") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[entry]}>
            <Deliverables />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    deliverablesApiMock.list.mockReset();
    deliverablesApiMock.get.mockReset();
    deliverablesApiMock.markOpened.mockReset().mockResolvedValue({ ok: true });
    // Detail mirrors whatever the list returned for that id.
    deliverablesApiMock.get.mockImplementation(async (_companyId: string, id: string) => {
      const listed = (await deliverablesApiMock.list.mock.results.at(-1)?.value as DeliverablesResponse | undefined)
        ?.deliverables.find((item) => item.id === id);
      return { ...(listed ?? sample({ id })), versions: [] };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows cards with a sandboxed live thumbnail", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const cards = container.querySelectorAll("[data-testid='deliverable-card']");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Q3 board pack");
    expect(cards[0]!.textContent).toContain("GRE-1");
    expect(cards[0]!.textContent).toContain("Report");
    const frame = container.querySelector<HTMLIFrameElement>("[data-testid='deliverable-thumbnail-frame']");
    expect(frame?.getAttribute("src")).toBe("/api/attachments/att-d-1/content");
    expect(frame?.getAttribute("sandbox")).toBe(DELIVERABLE_IFRAME_SANDBOX);
  });

  it("uses the same sandbox as HTML attachments and never grants app access", () => {
    expect(DELIVERABLE_IFRAME_SANDBOX.split(" ")).toEqual([...HTML_ATTACHMENT_SANDBOX_TOKENS]);
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-forms");
    expect(DELIVERABLE_IFRAME_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("searches as you type and focuses the search box with /", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([sample()]));
    render();
    await flush();

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search deliverables']")!;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(input);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "accra");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(deliverablesApiMock.list).toHaveBeenLastCalledWith(
      "company-1",
      expect.objectContaining({ q: "accra", sort: "newest" }),
    );
  });

  it("opens Quick Look, moves with the arrow keys and closes on Escape", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([
      sample({ id: "d-1", title: "First" }),
      sample({ id: "d-2", title: "Second" }),
    ]));
    render();
    await flush();

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='deliverable-card-preview']")!.click();
    });
    await flush();
    const quickLook = () => document.querySelector<HTMLElement>("[data-testid='deliverable-quicklook']");
    expect(quickLook()?.textContent).toContain("First");
    expect(quickLook()?.textContent).toContain("1 of 2");
    expect(document.querySelector("[data-testid='deliverable-preview-frame']")?.getAttribute("sandbox"))
      .toBe(DELIVERABLE_IFRAME_SANDBOX);
    expect(deliverablesApiMock.markOpened).toHaveBeenCalledWith("company-1", "d-1");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flush();
    expect(quickLook()?.textContent).toContain("Second");
    expect(quickLook()?.textContent).toContain("2 of 2");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await flush();
    expect(quickLook()?.textContent).toContain("1 of 2");

    act(() => {
      quickLook()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(quickLook()).toBeNull();
  });

  it("explains the page and shows an example prompt when there is nothing yet", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([]));
    render();
    await flush();
    const empty = container.querySelector("[data-testid='deliverables-empty']");
    expect(empty?.textContent).toContain("No deliverables yet");
    expect(empty?.textContent).toContain(EXAMPLE_DELIVERABLE_PROMPT);
  });

  it("says no match, not 'nothing yet', when a filter hides everything", async () => {
    deliverablesApiMock.list.mockResolvedValue(response([]));
    render("/deliverables?kind=deck");
    await flush();
    expect(container.querySelector("[data-testid='deliverables-empty']")).toBeNull();
    expect(container.textContent).toContain("No deliverables match.");
    expect(deliverablesApiMock.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "deck" }));
  });
});

describe("deliverable helpers", () => {
  it("groups by project and by month, keeping list order", () => {
    const items = [
      sample({ id: "a", project: { id: "p1", name: "Board" }, createdAt: "2026-09-02T00:00:00.000Z" }),
      sample({ id: "b", project: null, createdAt: "2026-08-15T00:00:00.000Z" }),
      sample({ id: "c", project: { id: "p1", name: "Board" }, createdAt: "2026-08-01T00:00:00.000Z" }),
    ];
    expect(groupDeliverables(items, "project").map((group) => [group.label, group.items.map((item) => item.id)]))
      .toEqual([["Board", ["a", "c"]], ["No project", ["b"]]]);
    expect(groupDeliverables(items, "month").map((group) => group.items.map((item) => item.id)))
      .toEqual([["a"], ["b", "c"]]);
    expect(groupDeliverables(items, "none")).toEqual([{ key: "all", label: null, items }]);
  });

  it("starts weeks on Monday and months on the 1st", () => {
    const thursday = new Date(2026, 9, 1, 15, 30); // Thu 1 Oct 2026
    expect(new Date(dateRangeStart("week", thursday)!).getDate()).toBe(28); // Mon 28 Sep
    expect(new Date(dateRangeStart("month", thursday)!).getDate()).toBe(1);
    expect(dateRangeStart("all", thursday)).toBeUndefined();
  });
});
