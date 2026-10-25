// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveOrgBoard, DeepDiveProcessBoard as ProcessBoard } from "@greatstone/shared";
import { DeepDiveOrganisation } from "./DeepDiveOrganisation";
import { DeepDiveProcessBoard } from "./DeepDiveProcessBoard";

// Generic fixtures only: "Client company". Never a real client.
const COMPANY_ID = "company-1";

const store = vi.hoisted(() => ({ org: null as unknown, process: null as unknown }));
const org = () => store.org as DeepDiveOrgBoard;
const proc = () => store.process as ProcessBoard;

function orgBoard(): DeepDiveOrgBoard {
  return {
    companyId: COMPANY_ID,
    units: [
      { id: "u-ops", name: "Operations", unitType: "division", parentId: null, leadPersonId: null, headcount: 3, position: 0, visibility: "internal" },
      { id: "u-field", name: "Field team", unitType: "team", parentId: "u-ops", leadPersonId: null, headcount: null, position: 0, visibility: "internal" },
    ],
    people: [
      { id: "p-ama", name: "Ama", role: "Field supervisor", side: "client", unitId: "u-field", reportsToId: null, visibility: "internal" },
      { id: "p-kofi", name: "Kofi", role: "", side: "client", unitId: null, reportsToId: null, visibility: "internal" },
    ],
    tasks: [
      { id: "t-1", personId: "p-ama", what: "Schedule visits", hoursPerWeek: 40, fate: "automated", why: "", visibility: "internal" },
    ],
  };
}

function processBoard(): ProcessBoard {
  return {
    companyId: COMPANY_ID,
    offerings: [{ id: "o-surveys", name: "Field surveys", position: 0, visibility: "internal" }],
    processes: [
      { id: "pr-plan", name: "Plan the wave", offeringId: "o-surveys", runsPersonId: "p-ama", unitId: null, x: 20, y: 20, visibility: "internal" },
      { id: "pr-run", name: "Run interviews", offeringId: "o-surveys", runsPersonId: null, unitId: null, x: 320, y: 20, visibility: "internal" },
      { id: "pr-clean", name: "Clean the data", offeringId: null, runsPersonId: null, unitId: null, x: null, y: null, visibility: "internal" },
    ],
    handoffs: [],
    people: [{ id: "p-ama", name: "Ama" }],
    units: [],
  };
}

const mockOrgApi = vi.hoisted(() => ({
  get: vi.fn(), addUnit: vi.fn(), updateUnit: vi.fn(), removeUnit: vi.fn(), addPerson: vi.fn(), updatePerson: vi.fn(),
  removePerson: vi.fn(), addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(),
}));
const mockProcessApi = vi.hoisted(() => ({
  get: vi.fn(), saveLayout: vi.fn(), addOffering: vi.fn(), updateOffering: vi.fn(), removeOffering: vi.fn(), addProcess: vi.fn(),
  updateProcess: vi.fn(), removeProcess: vi.fn(), recordHandoff: vi.fn(), updateHandoff: vi.fn(), removeHandoff: vi.fn(),
}));

vi.mock("@/api/deepDiveBoards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveBoards")>()),
  deepDiveOrgApi: mockOrgApi,
  deepDiveProcessApi: mockProcessApi,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY_ID, selectedCompany: { id: COMPANY_ID, name: "Client company", issuePrefix: "C001" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

/** A fake server that keeps the board between calls, so a reload shows what was saved. */
function installFakeServer() {
  const copy = <T,>(value: unknown) => structuredClone(value) as T;
  mockOrgApi.get.mockImplementation(async () => copy(store.org));
  mockOrgApi.updatePerson.mockImplementation(async (id: string, input: Record<string, unknown>) => {
    Object.assign(org().people.find((p) => p.id === id)!, input);
    return copy(store.org);
  });
  mockOrgApi.addPerson.mockImplementation(async (_companyId: string, input: { name: string; role?: string; unitId?: string | null }) => {
    org().people.push({ id: `p-${org().people.length + 1}`, name: input.name, role: input.role ?? "", side: "client", unitId: input.unitId ?? null, reportsToId: null, visibility: "internal" });
    return copy(store.org);
  });
  mockProcessApi.get.mockImplementation(async () => copy(store.process));
  mockProcessApi.saveLayout.mockImplementation(async (_companyId: string, input: { positions: { processId: string; x: number | null; y: number | null }[] }) => {
    for (const position of input.positions) Object.assign(proc().processes.find((p) => p.id === position.processId)!, { x: position.x, y: position.y });
    return copy(store.process);
  });
  mockProcessApi.recordHandoff.mockImplementation(async (_companyId: string, input: { fromProcessId: string; toProcessId: string; what: string }) => {
    proc().handoffs.push({ id: `h-${proc().handoffs.length + 1}`, ...input, visibility: "internal" });
    return copy(store.process);
  });
  mockProcessApi.removeHandoff.mockImplementation(async (id: string) => {
    proc().handoffs = proc().handoffs.filter((h) => h.id !== id);
    return copy(store.process);
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

async function waitFor(assertion: () => void, attempts = 40) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const isSelect = element.tagName === "SELECT";
  const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(isSelect ? "change" : "input", { bubbles: true }));
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

const byLabel = <T extends Element>(container: HTMLElement, label: string) => {
  const found = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`Nothing labelled "${label}"`);
  return found;
};

describe("Deep Dive boards", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.org = orgBoard();
    store.process = processBoard();
    vi.clearAllMocks();
    installFakeServer();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  function render(element: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
    });
  }

  describe("organisation board", () => {
    it("shows units as a tree, the unplaced people and the target state", async () => {
      render(<DeepDiveOrganisation />);
      await waitFor(() => expect(container.textContent).toContain("Organisation board"));
      const ops = byLabel<HTMLElement>(container, "Unit Operations");
      const field = byLabel<HTMLElement>(container, "Unit Field team");
      // Field team is drawn under Operations, with Ama in it.
      expect(ops.closest("li")!.contains(field)).toBe(true);
      expect(field.textContent).toContain("Ama");
      expect(byLabel<HTMLElement>(container, "Unit Operations").textContent).toContain("Nobody placed here yet");
      expect(container.querySelector('[aria-labelledby="deep-dive-unplaced"]')!.textContent).toContain("Kofi");
      // 40 automated hours free one person: 3 -> 2.
      expect(container.querySelector('[aria-labelledby="deep-dive-target-state"]')!.textContent).toMatch(/3\s*→\s*to\s*2/);
    });

    it("places an unplaced person in a unit and shows the saved board", async () => {
      render(<DeepDiveOrganisation />);
      await waitFor(() => expect(container.textContent).toContain("Unplaced (1)"));
      const kofiRow = [...container.querySelectorAll('[aria-labelledby="deep-dive-people"] > ul > li')].find((li) => li.querySelector("p")?.textContent === "Kofi")!;
      const unitSelect = [...kofiRow.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Unit"))!.querySelector("select")!;
      flushSync(() => setValue(unitSelect, "u-ops"));
      await flush();
      await waitFor(() => expect(container.textContent).toContain("Unplaced (0)"));
      expect(mockOrgApi.updatePerson).toHaveBeenCalledWith("p-kofi", { unitId: "u-ops" });
      expect(byLabel<HTMLElement>(container, "Unit Operations").textContent).toContain("Kofi");
    });

    it("drops a dragged person onto a unit", async () => {
      render(<DeepDiveOrganisation />);
      await waitFor(() => expect(container.textContent).toContain("Unplaced (1)"));
      const data = new Map<string, string>();
      const dataTransfer = {
        types: ["application/x-deep-dive-person"],
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? "",
        effectAllowed: "move",
      };
      const chip = [...container.querySelectorAll('[aria-labelledby="deep-dive-unplaced"] li')].find((li) => li.textContent?.includes("Kofi"))!;
      const dragStart = new Event("dragstart", { bubbles: true });
      Object.assign(dragStart, { dataTransfer });
      flushSync(() => chip.dispatchEvent(dragStart));
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.assign(drop, { dataTransfer });
      flushSync(() => byLabel<HTMLElement>(container, "Unit Field team").dispatchEvent(drop));
      await waitFor(() => expect(mockOrgApi.updatePerson).toHaveBeenCalledWith("p-kofi", { unitId: "u-field" }));
      await waitFor(() => expect(container.textContent).toContain("Unplaced (0)"));
    });
  });

  describe("process board", () => {
    const arrows = (container: HTMLElement) => [...container.querySelectorAll("[data-testid=process-canvas] path[data-handoff-id]")];

    it("lays out lanes per offering and draws no arrow where no handoff is recorded", async () => {
      render(<DeepDiveProcessBoard />);
      await waitFor(() => expect(container.querySelector("[data-testid=process-canvas]")).not.toBeNull());
      expect(byLabel<HTMLElement>(container, "Lane Field surveys")).toBeTruthy();
      expect(byLabel<HTMLElement>(container, "Lane: no offering named")).toBeTruthy();
      // Two cards side by side in one lane, in a row: still no arrow.
      expect(byLabel<HTMLElement>(container, "Process Plan the wave").style.left).toBe("20px");
      expect(byLabel<HTMLElement>(container, "Process Run interviews").style.left).toBe("320px");
      expect(byLabel<HTMLElement>(container, "Process Plan the wave").textContent).toContain("Runs it: Ama");
      expect(arrows(container)).toHaveLength(0);
    });

    it("draws an arrow only once a handoff is recorded, and removes it with the handoff", async () => {
      render(<DeepDiveProcessBoard />);
      await waitFor(() => expect(container.querySelector("[data-testid=process-canvas]")).not.toBeNull());

      flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Hands off from"), "pr-plan"));
      flushSync(() => setValue(byLabel<HTMLSelectElement>(container, "Hands off to"), "pr-run"));
      flushSync(() => button(container, "Record handoff").click());
      await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Name what is handed over/));
      expect(mockProcessApi.recordHandoff).not.toHaveBeenCalled();
      expect(arrows(container)).toHaveLength(0);

      flushSync(() => setValue(byLabel<HTMLInputElement>(container, "What is handed over"), "The wave plan"));
      flushSync(() => button(container, "Record handoff").click());
      await waitFor(() => expect(arrows(container)).toHaveLength(1));
      expect(mockProcessApi.recordHandoff).toHaveBeenCalledWith(COMPANY_ID, { fromProcessId: "pr-plan", toProcessId: "pr-run", what: "The wave plan" });
      expect(arrows(container)[0]!.getAttribute("data-handoff-id")).toBe("h-1");
      expect(arrows(container)[0]!.textContent).toBe("The wave plan");

      flushSync(() => byLabel<HTMLButtonElement>(container, "Remove handoff The wave plan").click());
      await waitFor(() => expect(arrows(container)).toHaveLength(0));
    });

    it("saves a dragged card's position on drop and draws no arrow for it", async () => {
      render(<DeepDiveProcessBoard />);
      await waitFor(() => expect(container.querySelector("[data-testid=process-canvas]")).not.toBeNull());
      const card = byLabel<HTMLElement>(container, "Process Clean the data");
      const pointer = (type: string, x: number, y: number) =>
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      const start = { x: parseInt(card.style.left, 10) + 5, y: parseInt(card.style.top, 10) + 5 };
      flushSync(() => card.dispatchEvent(pointer("pointerdown", start.x, start.y)));
      flushSync(() => card.dispatchEvent(pointer("pointermove", start.x + 203, start.y + 41)));
      flushSync(() => card.dispatchEvent(pointer("pointerup", start.x + 203, start.y + 41)));
      await waitFor(() => expect(mockProcessApi.saveLayout).toHaveBeenCalledTimes(1));
      const [, layout] = mockProcessApi.saveLayout.mock.calls[0]!;
      expect(layout.positions).toHaveLength(1);
      expect(layout.positions[0].processId).toBe("pr-clean");
      expect(layout.positions[0].x % 10).toBe(0);
      expect(layout.positions[0].y % 10).toBe(0);
      expect(Object.keys(layout.positions[0]).sort()).toEqual(["processId", "x", "y"]);
      await waitFor(() => expect(byLabel<HTMLElement>(container, "Process Clean the data").style.left).toBe(`${layout.positions[0].x}px`));
      expect(arrows(container)).toHaveLength(0);
      expect(proc().handoffs).toEqual([]);
    });
  });
});
