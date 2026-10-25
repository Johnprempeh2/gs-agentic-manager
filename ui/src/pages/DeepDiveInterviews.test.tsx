// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDeepDiveInterviewRound,
  DeepDiveInterviewRoundView,
  DeepDiveInterviewSet,
  UpdateDeepDiveInterviewSet,
} from "@greatstone/shared";
import { DeepDiveInterviews } from "./DeepDiveInterviews";

// Generic fixtures only: "Client company", prefix C001. Never a real client.
const COMPANY_ID = "company-1";

const store = vi.hoisted(() => ({ view: null as unknown }));

function view(): DeepDiveInterviewRoundView {
  return store.view as DeepDiveInterviewRoundView;
}

function draftedSet(): DeepDiveInterviewSet {
  return {
    id: "set-1",
    roundId: "round-1",
    target: { kind: "unit", id: "unit-finance", name: "Finance", detail: "Team" },
    status: "draft",
    questions: [
      {
        prompt: "We understand that month-end close takes nine days. Is that right for your team? What would you add or correct?",
        purpose: "validate",
        streamKey: "operations",
        gifKey: "business-impact",
      },
      {
        prompt: "How does data work today in your team? Walk us through a normal week.",
        purpose: "investigate",
        streamKey: "data",
        gifKey: "current-state",
      },
    ],
    known: [{ streamKey: "operations", gifKey: "current-state", text: "Orders are keyed by hand into the ledger." }],
    leftOut: 33,
    approvedByUserId: null,
    approvedAt: null,
    draftedByAgentId: null,
    draftedByUserId: "user-1",
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
  };
}

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  draftSet: vi.fn(),
  updateSet: vi.fn(),
  redraftSet: vi.fn(),
  approveSet: vi.fn(),
  removeSet: vi.fn(),
}));

vi.mock("@/api/deepDiveInterviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveInterviews")>()),
  deepDiveInterviewsApi: mockApi,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: COMPANY_ID,
    selectedCompany: { id: COMPANY_ID, name: "Client company", issuePrefix: "C001" },
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const FINANCE = { kind: "unit" as const, id: "unit-finance", name: "Finance", detail: "Team" };

/** A fake server with the same rules: one round, edits go back to Draft, approval is a person's. */
function installFakeServer() {
  const stamp = (() => {
    let n = 0;
    return () => `2026-10-25T10:00:${String(n++).padStart(2, "0")}.000Z`;
  })();
  const out = () => structuredClone(view());
  mockApi.get.mockImplementation(async () => out());
  mockApi.create.mockImplementation(async (_companyId: string, input: CreateDeepDiveInterviewRound) => {
    store.view = {
      round: {
        id: "round-1",
        companyId: COMPANY_ID,
        mode: input.mode,
        targetMinutes: input.targetMinutes ?? 20,
        contextPack: input.contextPack ?? {},
        status: "setup",
        createdAt: stamp(),
        updatedAt: stamp(),
        sets: [],
      },
      available: [FINANCE],
    };
    return out();
  });
  mockApi.draftSet.mockImplementation(async () => {
    view().round!.sets.push(draftedSet());
    view().available = [];
    return out();
  });
  mockApi.approveSet.mockImplementation(async () => {
    Object.assign(view().round!.sets[0]!, { status: "approved", approvedAt: "2026-10-25T11:00:00.000Z", approvedByUserId: "user-1", updatedAt: stamp() });
    return out();
  });
  mockApi.updateSet.mockImplementation(async (_id: string, input: UpdateDeepDiveInterviewSet) => {
    Object.assign(view().round!.sets[0]!, { questions: input.questions, status: "draft", approvedAt: null, approvedByUserId: null, updatedAt: stamp() });
    return out();
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

function setValue(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, label: string) {
  // Exact label first; a radio card's text also holds its description.
  const buttons = [...container.querySelectorAll("button")];
  const found =
    buttons.find((entry) => entry.textContent?.trim() === label) ??
    buttons.find((entry) => entry.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

describe("Parallel Interview page (GRE-2611)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.view = { round: null, available: [FINANCE] };
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

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(<QueryClientProvider client={queryClient}><DeepDiveInterviews /></QueryClientProvider>);
    });
  }

  it("sets up a round per person with a context pack, refusing a bad length first", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Set up the round"));

    flushSync(() => button(container, "Per person").click());
    flushSync(() => setValue(container.querySelector<HTMLInputElement>('input[type="number"]')!, "200"));
    flushSync(() => button(container, "Set up the round").click());
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Give a target length of 5 to 90 minutes."));
    expect(mockApi.create).not.toHaveBeenCalled();

    flushSync(() => setValue(container.querySelector<HTMLInputElement>('input[type="number"]')!, "25"));
    const background = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith("About the company"))!;
    flushSync(() => setValue(background.querySelector("textarea")!, "A regional haulier with four depots."));
    flushSync(() => button(container, "Set up the round").click());
    await waitFor(() => expect(container.textContent).toContain("Per person, about 25 minutes"));
    expect(mockApi.create).toHaveBeenCalledWith(COMPANY_ID, {
      mode: "per_person",
      targetMinutes: 25,
      contextPack: { company_background: "A regional haulier with four depots." },
    });
    expect(container.textContent).toContain("A regional haulier with four depots.");
  });

  it("drafts a set, shows what is known and not asked, approves it, and asks again after an edit", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Set up the round"));
    flushSync(() => button(container, "Set up the round").click());
    await waitFor(() => expect(container.textContent).toContain("No question sets yet."));

    flushSync(() => button(container, "Draft questions").click());
    await waitFor(() => expect(container.textContent).toContain("Already known, not asked (1)"));
    expect(mockApi.draftSet).toHaveBeenCalledWith("round-1", { unitId: "unit-finance" });
    expect(container.textContent).toContain("Already known, not asked (1)");
    expect(container.textContent).toContain("Orders are keyed by hand into the ledger.");
    expect(container.textContent).toContain("Validate, Operations: Business impact");
    expect(container.textContent).toContain("33 more unknown cells left out");
    expect(container.textContent).toContain("0 of 1 question sets approved. Invites go out only when a person has approved every set.");

    flushSync(() => button(container, "Approve questions").click());
    await waitFor(() => expect(container.textContent).toContain("All 1 question sets are approved. Invites can go out."));

    flushSync(() => button(container, "Edit").click());
    await waitFor(() => expect(container.textContent).toContain("Saving puts the set back to Draft"));
    flushSync(() => setValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question 2"]')!, "Which reports do you build by hand each month?"));
    flushSync(() => button(container, "Save questions").click());
    await waitFor(() => expect(container.textContent).toContain("0 of 1 question sets approved."));
    expect(mockApi.updateSet).toHaveBeenCalledWith("set-1", {
      questions: [draftedSet().questions[0], { ...draftedSet().questions[1], prompt: "Which reports do you build by hand each month?" }],
    });
    expect(button(container, "Approve questions")).toBeTruthy();
  });

  it("shows the server's refusal instead of failing silently", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Set up the round"));
    flushSync(() => button(container, "Set up the round").click());
    await waitFor(() => expect(container.textContent).toContain("No question sets yet."));
    mockApi.draftSet.mockRejectedValueOnce(new Error("Every cell of the Deep Dive is Known, so there is nothing to ask."));
    flushSync(() => button(container, "Draft questions").click());
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Every cell of the Deep Dive is Known, so there is nothing to ask."),
    );
  });
});
