// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { invoiceProposal, ownProposal, reviewQueue } from "../fixtures/memoryReviewFixtures";
import { MemoryReview } from "./MemoryReview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reviewApiMock = vi.hoisted(() => ({
  queue: vi.fn(),
  act: vi.fn(),
  stewards: vi.fn(),
  setSteward: vi.fn(),
}));

vi.mock("../api/memoryReview", () => ({ memoryReviewApi: reviewApiMock }));
vi.mock("../api/access", () => ({
  accessApi: { listMembers: vi.fn(async () => ({ members: [], access: { canManageMembers: false } })) },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co-kestrel" }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    useSearchParams: actual.useSearchParams,
    useNavigate: actual.useNavigate,
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/memory/review" element={<MemoryReview />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

const body = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;

function typeInto(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  reviewApiMock.queue.mockResolvedValue(reviewQueue);
  reviewApiMock.stewards.mockResolvedValue({ scopes: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("MemoryReview", () => {
  it("shows the oldest proposal beside the confirmed card it changes, with the person and app", async () => {
    await renderAt("/memory/review");
    const proposed = document.body.querySelector('section[aria-label="Proposed"]')!;
    const current = document.body.querySelector('section[aria-label="Confirmed now"]')!;
    expect(proposed.textContent).toContain("first working day");
    expect(current.textContent).toContain("last working day of the month");
    expect(body()).toContain("Ama");
    expect(body()).toContain("· via ChatGPT");
    expect(body()).toContain("Over 7 days · 9 days");
    // Expired ranks last in the list even when the server order differs.
    const rows = [...document.body.querySelectorAll('section[aria-label="Review queue"] li')].map((row) => row.textContent);
    expect(rows.at(-1)).toContain("Old supplier note");
  });

  it("blocks confirm on your own proposal and says why", async () => {
    await renderAt(`/memory/review?card=${ownProposal.proposal.id}`);
    expect(button("Confirm").disabled).toBe(true);
    expect(button("Edit and submit").disabled).toBe(false);
    expect(body()).toContain("You proposed this card. Another steward must confirm it.");
    expect(body()).toContain("Nothing confirmed yet");
    expect(body()).toContain("Conflict");
  });

  it("confirms with a reason and the version the steward saw", async () => {
    reviewApiMock.act.mockResolvedValue({ record: { ...invoiceProposal.proposal, status: "approved" } });
    await renderAt(`/memory/review?card=${invoiceProposal.proposal.id}`);
    act(() => button("Confirm").click());
    await flush();
    const submit = [...document.body.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    typeInto(document.getElementById("steward-reason") as HTMLTextAreaElement, "Matches the new finance rule");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flush();
    expect(reviewApiMock.act).toHaveBeenCalledWith("co-kestrel", invoiceProposal.proposal.id, {
      action: "confirm",
      expectedVersion: 2,
      reason: "Matches the new finance rule",
    });
  });

  it("shows a plain message when the card changed since it was opened", async () => {
    reviewApiMock.act.mockRejectedValue(new ApiError("Version mismatch", 409, null));
    await renderAt(`/memory/review?card=${invoiceProposal.proposal.id}`);
    act(() => button("Reject").click());
    await flush();
    typeInto(document.getElementById("steward-reason") as HTMLTextAreaElement, "Wrong date");
    const submit = [...document.body.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
    await act(async () => submit.click());
    await flush();
    expect(body()).toContain("This card changed since you opened it");
  });

  it("counts active filters on the phone Filters button", async () => {
    await renderAt("/memory/review?age=overdue&conflict=true");
    expect(button("Filters (2)")).toBeTruthy();
    expect(reviewApiMock.queue).toHaveBeenCalledWith("co-kestrel", expect.objectContaining({ age: "overdue", conflict: "true" }));
  });

  it("keeps steward setup on its own Stewards view", async () => {
    reviewApiMock.stewards.mockResolvedValue({
      scopes: [
        { scopeId: "scope-legal", scopeName: "Legal and contracts", scopeKind: "organization", primaryUserId: null, backupUserId: null, ownerOnly: false },
      ],
    });
    await renderAt("/memory/review");
    expect(body()).not.toContain("Legal and contracts");
    expect(reviewApiMock.stewards).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    await renderAt("/memory/review?view=stewards");
    expect(body()).toContain("Legal and contracts");
    expect(document.body.querySelector('section[aria-label="Review queue"]')).toBeNull();
  });

  it("tells a non-steward they cannot review", async () => {
    reviewApiMock.queue.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderAt("/memory/review");
    expect(body()).toContain("Only stewards and the owner can review memory.");
  });
});
