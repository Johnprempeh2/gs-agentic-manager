// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeedsMe } from "@greatstone/shared";
import { NeedsYouAlert } from "./NeedsYouAlert";

const state = vi.hoisted(() => ({ data: null as NeedsMe | null, pushToast: vi.fn() }));

vi.mock("../hooks/useDecisionsFeed", () => ({ useNeedsMe: () => ({ data: state.data }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "c" }) }));
vi.mock("../context/ToastContext", () => ({ useOptionalToastActions: () => ({ pushToast: state.pushToast }) }));

const needsMe = (cards: Array<{ id: string; title: string; kind?: string }>): NeedsMe =>
  ({
    companyId: "c",
    generatedAt: "",
    count: cards.length,
    decisionCount: cards.length,
    assignedTaskCount: 0,
    decisions: cards.map((card) => ({ kind: "review", task: null, ...card })),
    assignedTasks: [],
    overdueWaits: [],
  }) as unknown as NeedsMe;

let root: Root;
let container: HTMLDivElement;

function render() {
  act(() => root.render(<NeedsYouAlert />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.pushToast.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("NeedsYouAlert", () => {
  it("says in the app when a new decision arrives and notifications are blocked", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    state.data = needsMe([{ id: "a", title: "Approve the brief" }]);
    render();
    expect(state.pushToast).not.toHaveBeenCalled();

    state.data = needsMe([
      { id: "a", title: "Approve the brief" },
      { id: "b", title: "Pick a date" },
      { id: "x", title: "Offline", kind: "outage" },
    ]);
    render();
    expect(state.pushToast).toHaveBeenCalledTimes(1);
    expect(state.pushToast.mock.calls[0]![0]).toMatchObject({
      title: "Something new needs you",
      body: "Pick a date",
      action: { label: "Open Decisions", href: "/decisions" },
    });
  });

  it("stays quiet when this browser shows notifications already", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    state.data = needsMe([]);
    render();
    state.data = needsMe([{ id: "a", title: "Approve the brief" }]);
    render();
    expect(state.pushToast).not.toHaveBeenCalled();
  });
});
