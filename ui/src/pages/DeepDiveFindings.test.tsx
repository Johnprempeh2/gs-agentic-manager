// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEP_DIVE_STREAMS, type DeepDiveFinding, type ProposeDeepDiveFinding } from "@greatstone/shared";
import type { CaseSummary } from "@/api/cases";
import { DeepDiveFindings } from "./DeepDiveFindings";

// Generic fixtures only: "Client company", prefix C001. Never a real client.
const COMPANY_ID = "company-1";
const CLIENT_ID = "client-1";

const store = vi.hoisted(() => ({ findings: [] as unknown[] }));

function findings(): DeepDiveFinding[] {
  return store.findings as DeepDiveFinding[];
}

function streamRow(key: string, index: number): CaseSummary {
  return {
    id: `stream-${key}`,
    companyId: COMPANY_ID,
    projectId: null,
    caseNumber: index + 2,
    identifier: `C001-C${index + 2}`,
    caseType: "deep_dive_stream",
    key,
    title: `Deep dive: ${key}`,
    summary: null,
    status: "draft",
    fields: {},
    parentCaseId: "case-1",
    visibility: "internal",
    // Operations is the one stream about a client, so it can cite evidence.
    clientCaseId: key === "operations" ? CLIENT_ID : null,
    clientEditableFields: [],
    createdByAgentId: null,
    createdByUserId: "user-1",
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as CaseSummary;
}

const mockCasesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockFindingsApi = vi.hoisted(() => ({
  list: vi.fn(),
  propose: vi.fn(),
  decide: vi.fn(),
  setVisibility: vi.fn(),
  clientEvidence: vi.fn(),
}));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/deepDiveFindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveFindings")>()),
  deepDiveFindingsApi: mockFindingsApi,
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

/** A fake server with the same rules: propose, a person decides, a validated replacement supersedes. */
function installFakeServer() {
  mockCasesApi.list.mockResolvedValue(DEEP_DIVE_STREAMS.map((stream, index) => streamRow(stream.key, index)));
  mockFindingsApi.clientEvidence.mockResolvedValue([
    { id: "evidence-1", caseId: CLIENT_ID, kind: "link", title: "Ops interview notes", typeLabel: "Link" },
  ]);
  mockFindingsApi.list.mockImplementation(async () => structuredClone(findings()));
  mockFindingsApi.propose.mockImplementation(async (_companyId: string, input: ProposeDeepDiveFinding) => {
    const finding: DeepDiveFinding = {
      id: `finding-${findings().length + 1}`,
      companyId: COMPANY_ID,
      streamCaseId: input.streamCaseId,
      gifKey: input.gifKey,
      gifDocumentId: `${input.streamCaseId}-gif-${input.gifKey}`,
      statement: input.statement,
      status: "proposed",
      visibility: "internal",
      supersedesFindingId: input.supersedesFindingId ?? null,
      supersededByFindingId: null,
      proposedByAgentId: null,
      proposedByUserId: "user-1",
      decidedByUserId: null,
      decidedAt: null,
      supersededAt: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      evidence: (input.evidenceIds ?? []).map((id) => ({ id, title: "Ops interview notes", kind: "link", clientCaseId: CLIENT_ID })),
    };
    store.findings.push(finding);
    return finding;
  });
  mockFindingsApi.decide.mockImplementation(async (id: string, decision: "validated" | "rejected") => {
    const finding = findings().find((entry) => entry.id === id)!;
    finding.status = decision;
    if (decision === "validated" && finding.supersedesFindingId) {
      const old = findings().find((entry) => entry.id === finding.supersedesFindingId)!;
      old.status = "superseded";
      old.supersededByFindingId = finding.id;
    }
    return finding;
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

function setValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLTextAreaElement ? "input" : "change", { bubbles: true }));
}

function button(container: HTMLElement, label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

function findingEl(container: HTMLElement, id: string) {
  const el = container.querySelector<HTMLElement>(`[data-deep-dive-finding="${id}"]`);
  if (!el) throw new Error(`No finding ${id}`);
  return el;
}

describe("DeepDiveFindings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.findings = [];
    vi.clearAllMocks();
    installFakeServer();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DeepDiveFindings />
        </QueryClientProvider>,
      );
    });
  }

  it("proposes with evidence, validates, and replaces a finding without editing it", async () => {
    render();
    await waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());

    const [streamSelect] = [...container.querySelectorAll("select")];
    flushSync(() => setValue(streamSelect!, "stream-operations"));
    await waitFor(() => expect(container.textContent).toContain("Ops interview notes"));
    flushSync(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    flushSync(() => setValue(container.querySelector("textarea")!, "Orders are re-keyed by hand."));
    flushSync(() => button(container, "Propose").click());

    await waitFor(() => expect(container.querySelector('[data-deep-dive-finding="finding-1"]')).not.toBeNull());
    expect(mockFindingsApi.propose).toHaveBeenCalledWith(COMPANY_ID, {
      streamCaseId: "stream-operations",
      gifKey: "current-state",
      statement: "Orders are re-keyed by hand.",
      evidenceIds: ["evidence-1"],
      supersedesFindingId: null,
    });
    const first = findingEl(container, "finding-1");
    expect(first.dataset.status).toBe("proposed");
    expect(first.textContent).toContain("Evidence: Ops interview notes");
    // A finding is shown, never offered for editing.
    expect(first.querySelector("textarea, input[type='text']")).toBeNull();

    flushSync(() => button(container, "Validate", first).click());
    await waitFor(() => expect(findingEl(container, "finding-1").dataset.status).toBe("validated"));
    expect(mockFindingsApi.decide).toHaveBeenCalledWith("finding-1", "validated");

    flushSync(() => button(container, "Replace", findingEl(container, "finding-1")).click());
    await waitFor(() => expect(container.textContent).toContain("Propose a replacement"));
    flushSync(() => setValue(container.querySelector("textarea")!, "Orders are re-keyed by hand, twice a day."));
    flushSync(() => button(container, "Propose").click());
    await waitFor(() => expect(container.querySelector('[data-deep-dive-finding="finding-2"]')).not.toBeNull());
    expect(mockFindingsApi.propose).toHaveBeenLastCalledWith(
      COMPANY_ID,
      expect.objectContaining({ supersedesFindingId: "finding-1", evidenceIds: ["evidence-1"] }),
    );
    // Proposing a replacement leaves the old finding validated.
    expect(findingEl(container, "finding-1").dataset.status).toBe("validated");

    flushSync(() => button(container, "Validate", findingEl(container, "finding-2")).click());
    await waitFor(() => expect(findingEl(container, "finding-1").dataset.status).toBe("superseded"));
    expect(findingEl(container, "finding-1").textContent).toContain("Orders are re-keyed by hand.");
    expect(findingEl(container, "finding-1").textContent).toContain("Replaced by a newer finding");
  });

  it("asks for the finding before proposing, and says when a stream has no client evidence", async () => {
    render();
    await waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());
    expect(container.textContent).toContain("not linked to a client yet");
    flushSync(() => button(container, "Propose").click());
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Write the finding."));
    expect(mockFindingsApi.propose).not.toHaveBeenCalled();
  });
});
