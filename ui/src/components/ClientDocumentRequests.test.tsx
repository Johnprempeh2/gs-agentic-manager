// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientDocumentRequest } from "@greatstone/shared";
import { ClientDocumentRequests, outstandingRequestsText, splitRequestTitles } from "./ClientDocumentRequests";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  requestCaseDocuments: vi.fn(),
  addStandardCaseDocumentRequests: vi.fn(),
  removeCaseDocumentRequest: vi.fn(),
  uploadCaseEvidence: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/pipelines", () => ({ pipelinesApi: api }));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast }),
  useOptionalToastActions: () => ({ pushToast }),
}));

const strategy: ClientDocumentRequest = {
  id: "req-1",
  stageId: "stage-1",
  title: "IT strategy",
  note: null,
  createdAt: "2026-10-15T10:00:00.000Z",
  received: null,
};
const accounts: ClientDocumentRequest = {
  id: "req-2",
  stageId: "stage-1",
  title: "Latest accounts",
  note: "Last two years",
  createdAt: "2026-10-15T10:00:00.000Z",
  received: {
    evidenceId: "ev-1",
    title: "Accounts 2025.pdf",
    contentPath: "/api/cases/case-1/evidence/ev-1/content",
    receivedAt: "2026-10-15T12:00:00.000Z",
  },
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ClientDocumentRequests", () => {
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

  function render(stage: Parameters<typeof ClientDocumentRequests>[0]["stage"]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <ClientDocumentRequests caseId="case-1" stage={stage} />
      </QueryClientProvider>,
    ));
  }
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);

  it("counts what has arrived, links the received file and uploads against a missing one", async () => {
    api.uploadCaseEvidence.mockResolvedValue({ id: "ev-2" });
    render({ id: "stage-1", name: "Deep Dive", state: "current", requests: [strategy, accounts], suggestedRequests: [] });

    expect(container.textContent).toContain("1 of 2 received");
    const link = container.querySelector<HTMLAnchorElement>("a[href='/api/cases/case-1/evidence/ev-1/content']");
    expect(link?.textContent).toBe("Accounts 2025.pdf");
    expect(container.textContent).toContain("Last two years");

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Upload IT strategy']")!;
    expect(container.querySelector("input[aria-label='Upload Latest accounts']")).toBeNull();
    const file = new File(["%PDF"], "strategy.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(api.uploadCaseEvidence).toHaveBeenCalledWith("case-1", file, { stageId: "stage-1", requestId: "req-1" });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "IT strategy received" }));
  });

  it("offers the stage's usual list and takes new requests, one per pasted line", async () => {
    api.addStandardCaseDocumentRequests.mockResolvedValue({ created: 2 });
    api.requestCaseDocuments.mockResolvedValue({ created: 1 });
    render({
      id: "stage-1",
      name: "Deep Dive",
      state: "current",
      requests: [],
      suggestedRequests: [{ title: "Organisation chart", note: null }, { title: "IT budget", note: null }],
    });
    expect(container.textContent).toContain("Organisation chart, IT budget");
    act(() => button("Add the usual Deep Dive list (2)")!.click());
    await flush();
    expect(api.addStandardCaseDocumentRequests).toHaveBeenCalledWith("case-1", "stage-1");

    act(() => button("Ask for a document")!.click());
    const field = container.querySelector<HTMLInputElement>("input[aria-label='Document to ask for']")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Supplier contracts");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Add")!.click());
    await flush();
    expect(api.requestCaseDocuments).toHaveBeenCalledWith("case-1", { stageId: "stage-1", titles: ["Supplier contracts"] });
  });

  it("stays out of the way on a stage that has not started and has nothing to ask", () => {
    render({ id: "stage-9", name: "Playback", state: "next", requests: [], suggestedRequests: [] });
    expect(container.querySelector("[data-testid='document-requests']")).toBeNull();
  });

  it("writes the outstanding list for an email and splits pasted lists", () => {
    expect(outstandingRequestsText([strategy, accounts])).toBe(
      "Could you please send us the following documents:\n- IT strategy",
    );
    expect(outstandingRequestsText([accounts])).toBe("");
    expect(splitRequestTitles("- Org chart\n2. IT budget\n\n• Contracts ")).toEqual(["Org chart", "IT budget", "Contracts"]);
  });
});
