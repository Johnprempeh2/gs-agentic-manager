// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveDraft } from "@greatstone/shared";
import { DeepDiveTile } from "@/components/DeepDiveTile";
import { DeepDiveQuestions, DeepDiveRegisters } from "./DeepDivePortal";

// Generic fixtures only: "Demo client". Never a real client.

const SCOPE = {
  companyId: "company-1",
  recordCaseId: "record-1",
  record: { id: "record-1", identifier: "C001-C1", title: "Deep Dive", clientCaseId: "client-1", clientName: "Demo client", organisationId: null, workstreams: ["Evidence"], status: "active" as const, draftsWaiting: 1, findingsToValidate: 2, createdAt: "2026-11-01T00:00:00.000Z" },
};

const mockRecordsApi = vi.hoisted(() => ({ drafts: vi.fn(), decide: vi.fn(), list: vi.fn() }));
vi.mock("@/api/deepDiveRecords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveRecords")>()),
  deepDiveRecordsApi: mockRecordsApi,
}));
vi.mock("@/lib/deep-dive-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deep-dive-scope")>()),
  useDeepDiveScope: () => SCOPE,
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function draft(overrides: Partial<DeepDiveDraft>): DeepDiveDraft {
  return {
    id: "draft-1",
    companyId: "company-1",
    recordCaseId: "record-1",
    kind: "interview_log",
    title: "Demo interview (2026-11-12)",
    payload: {
      notionPage: "https://www.notion.so/demo",
      meetingTitle: "Demo interview",
      heldOn: "2026-11-12",
      interviewee: "Demo Person, Finance lead",
      questionSource: "Demo guide",
      items: [
        { question: "How is a month closed?", status: "answered", answer: "By hand.", quote: "We close by hand.", workstream: "Evidence", pillars: ["process"] },
        { question: "Who signs the forecast?", status: "not_answered" },
      ],
      outsideNotes: [{ note: "A new ERP is on trial." }],
    },
    status: "draft",
    version: 3,
    createdByAgentId: "agent-1",
    createdByRunId: "run-1",
    createdByUserId: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}

async function settle(check: () => void) {
  for (let i = 0; i < 20; i += 1) {
    try {
      check();
      return;
    } catch {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  check();
}

describe("Deep Dive portal (GRE-4430)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>));
  }

  it("shows a tile with what waits for a person", () => {
    render(<DeepDiveTile record={SCOPE.record} to="/deep-dive/record-1" />);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/deep-dive/record-1");
    expect(link.textContent).toContain("Demo client");
    expect(link.textContent).toContain("1 draft to review · 2 findings to validate");
  });

  it("lists an agent's interview draft with every answer, and a person approves the version on screen", async () => {
    mockRecordsApi.drafts.mockResolvedValue([draft({}), draft({ id: "draft-2", status: "approved", title: "Earlier interview" })]);
    mockRecordsApi.decide.mockResolvedValue(draft({ status: "approved" }));
    render(<DeepDiveQuestions />);

    await settle(() => expect(container.textContent).toContain("Waiting for review (1)"));
    expect(container.textContent).toContain("1 answered · 0 unclear · 1 not answered · 1 note");
    expect(container.textContent).toContain("We close by hand.");
    expect(container.textContent).toContain("Approved interviews (1)");

    const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await act(async () => approve.click());
    await settle(() => expect(mockRecordsApi.decide).toHaveBeenCalledWith(SCOPE, "draft-1", { decision: "approved", expectedVersion: 3 }));
  });

  it("groups proposed register rows by register and leaves rejected ones out", async () => {
    mockRecordsApi.drafts.mockResolvedValue([
      draft({ id: "r1", kind: "record_proposal", title: "Risk: files late", payload: { register: "Risks", values: { Risk: "Files arrive late" } } }),
      draft({ id: "r2", kind: "record_proposal", title: "Turned down", status: "rejected", payload: { register: "Risks", values: { Risk: "No" } } }),
    ]);
    render(<DeepDiveRegisters />);
    await settle(() => expect(container.textContent).toContain("Files arrive late"));
    expect(container.textContent).not.toContain("Turned down");
  });
});
