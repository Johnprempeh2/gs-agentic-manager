// @vitest-environment jsdom

import type { AnchorHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveInterviewProposal, DeepDiveInterviewReleaseView, DeepDiveInterviewRound } from "@greatstone/shared";
import type { CaseSummary } from "@/api/cases";
import { InterviewReview } from "./DeepDiveInterviewReview";

// Generic fixtures only: "Client company", "Person A". Never a real client.
const COMPANY_ID = "company-1";

const mockApi = vi.hoisted(() => ({
  proposals: vi.fn(),
  decide: vi.fn(),
  release: vi.fn(),
  releaseSynthesis: vi.fn(),
  withdrawSynthesis: vi.fn(),
  progress: vi.fn(),
}));
const mockOrg = vi.hoisted(() => ({ get: vi.fn() }));
const mockCases = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/deepDiveInterviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveInterviews")>()),
  deepDiveInterviewsApi: mockApi,
}));
vi.mock("@/api/deepDiveBoards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveBoards")>()),
  deepDiveOrgApi: mockOrg,
}));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCases,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

const ROUND: DeepDiveInterviewRound = {
  id: "round-1",
  companyId: COMPANY_ID,
  websiteOrganisationId: "org_client",
  mode: "per_team",
  targetMinutes: 20,
  contextPack: {},
  status: "open",
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:00:00.000Z",
  sets: [],
};

function proposal(over: Partial<DeepDiveInterviewProposal>): DeepDiveInterviewProposal {
  return {
    id: "p", roundId: "round-1", kind: "pain", themeKey: null, parentId: null, label: "", statement: "s", unitId: null, voices: 2,
    firstHandVoices: 1, websiteInsightId: null, websiteEmployeeId: null, anonymous: true, sources: [{ interviewId: "i1", userId: null, employeeId: null }],
    status: "proposed", visibility: "internal", rulesVersion: "gsam-synthesis-rules-1", decidedByUserId: null, decidedAt: null,
    createdAt: "2026-10-26T08:00:00.000Z", record: null, ...over,
  };
}

const PROPOSALS = [
  proposal({ id: "pain-1", kind: "pain", themeKey: "pain:order-rekey", label: "Re-keying orders", statement: "Orders are typed in twice.", voices: 2, firstHandVoices: 2,
    sources: [{ interviewId: "i1", userId: "usr_a", employeeId: "emp_a" }, { interviewId: "i2", userId: null, employeeId: null }] }),
  proposal({ id: "quote-a", kind: "quote", parentId: "pain-1", statement: "We re-key every order by hand.", anonymous: false, websiteEmployeeId: "emp_a", websiteInsightId: "ins_a" }),
  proposal({ id: "quote-b", kind: "quote", parentId: "pain-1", statement: "An hour a day on orders.", anonymous: true, websiteInsightId: "ins_b" }),
  proposal({ id: "process-1", kind: "process", label: "Month-end close", statement: "The close waits on one sheet.", unitId: "unit-finance" }),
  proposal({ id: "person-1", kind: "person", statement: "Finance lead", label: "Finance lead", unitId: "unit-finance", websiteEmployeeId: "emp_a", anonymous: false }),
];

function releaseView(over: Partial<DeepDiveInterviewReleaseView> = {}): DeepDiveInterviewReleaseView {
  return {
    roundId: "round-1",
    websiteOrganisationId: "org_client",
    released: null,
    readiness: { ready: false, blockers: [{ code: "undecided", message: "3 themes or quotes still wait for a decision" }], themes: 0, quotes: 0 },
    ...over,
  };
}

function stream(key: string): CaseSummary {
  return { id: `stream-${key}`, companyId: COMPANY_ID, caseType: "deep_dive_stream", key, title: key, fields: {} } as unknown as CaseSummary;
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

function buttons(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text) as HTMLButtonElement[];
}

function cardOf(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLElement>("[data-slot=card]")].find((c) => c.textContent?.includes(text))!;
}

describe("Parallel Interview synthesis review (GRE-2756)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of [...Object.values(mockApi), ...Object.values(mockOrg), ...Object.values(mockCases)]) fn.mockReset();
    mockApi.progress.mockResolvedValue({ people: [{ websiteEmployeeId: "emp_a", name: "Person A" }] });
    mockOrg.get.mockResolvedValue({ companyId: COMPANY_ID, units: [{ id: "unit-finance", name: "Finance" }], people: [], tasks: [] });
    mockCases.list.mockResolvedValue([stream("operations"), stream("people")]);
    mockApi.release.mockResolvedValue(releaseView());
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
          <InterviewReview round={ROUND} companyId={COMPANY_ID} />
        </QueryClientProvider>,
      );
    });
  }

  it("lists each theme with voices, team and provenance, quotes under it, and no person on an anonymous quote", async () => {
    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: PROPOSALS });
    render();
    await waitFor(() => expect(container.textContent).toContain("Orders are typed in twice."));
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Pains", "Processes", "People and roles", "Release to the client"]);
    const pain = cardOf(container, "Orders are typed in twice.");
    expect(pain.textContent).toContain("2 voices, 2 first-hand");
    expect(pain.textContent).toContain("Across teams");
    expect(pain.textContent).toContain("From 2 interviews · rules gsam-synthesis-rules-1");
    const quotes = [...pain.querySelectorAll("li")];
    expect(quotes[0]!.textContent).toContain("Person A");
    expect(quotes[1]!.textContent).toContain("Anonymous");
    expect(quotes[1]!.textContent).not.toContain("Person A");
    // The person is named live from the website, in their team.
    expect(cardOf(container, "Finance lead").textContent).toContain("Person A");
    expect(cardOf(container, "The close waits on one sheet.").textContent).toContain("Finance");
    expect(container.textContent).toContain("5 to decide");
  });

  it("accepts a pain into the chosen stream and GIF cell, and shows the finding it became", async () => {
    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: PROPOSALS });
    mockApi.decide.mockResolvedValue(proposal({ id: "pain-1", status: "accepted", record: { type: "finding", id: "finding-1" } }));
    render();
    await waitFor(() => expect(container.textContent).toContain("Accepting makes a proposed finding, Internal."));
    const pain = cardOf(container, "Orders are typed in twice.");
    const [streamSelect, gifSelect] = [...pain.querySelectorAll("select")];
    streamSelect!.value = "stream-people";
    streamSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    gifSelect!.value = "business-impact";
    gifSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    mockApi.proposals.mockResolvedValue({
      roundId: "round-1",
      proposals: PROPOSALS.map((p) => (p.id === "pain-1" ? { ...p, status: "accepted" as const, decidedAt: "2026-10-26T09:00:00.000Z", record: { type: "finding" as const, id: "finding-1" } } : p)),
    });
    buttons(pain, "Accept")[0]!.click();
    await waitFor(() => expect(mockApi.decide).toHaveBeenCalledWith("pain-1", { decision: "accepted", streamCaseId: "stream-people", gifKey: "business-impact" }));
    await waitFor(() => expect(container.textContent).toContain("Now a proposed finding."));
    expect(container.querySelector('a[href="/deep-dive/findings"]')).toBeTruthy();
    expect(mockApi.release).toHaveBeenCalledTimes(2);
  });

  it("accepts a person or a quote without a stream", async () => {
    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: PROPOSALS });
    mockApi.decide.mockResolvedValue(proposal({ id: "person-1", kind: "person", status: "accepted" }));
    render();
    await waitFor(() => expect(container.textContent).toContain("Accepting makes a person on the organisation board, Internal."));
    const person = cardOf(container, "Finance lead");
    expect(person.querySelector("select")).toBeNull();
    buttons(person, "Accept")[0]!.click();
    await waitFor(() => expect(mockApi.decide).toHaveBeenCalledWith("person-1", { decision: "accepted" }));
    buttons(cardOf(container, "Orders are typed in twice."), "Reject").at(-1)!.click();
    await waitFor(() => expect(mockApi.decide).toHaveBeenCalledWith("quote-b", { decision: "rejected" }));
  });

  it("shows loading, empty and error states", async () => {
    mockApi.proposals.mockReturnValue(new Promise(() => {}));
    render();
    expect(container.textContent).toContain("Loading the synthesis...");
    root.unmount();
    root = createRoot(container);

    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: [] });
    render();
    await waitFor(() => expect(container.textContent).toContain("No synthesis yet."));
    root.unmount();
    root = createRoot(container);

    mockApi.proposals.mockRejectedValue(new Error("The round has not opened on the website, so there are no interviews yet"));
    render();
    await waitFor(() => expect(container.textContent).toContain("so there are no interviews yet"));
    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: PROPOSALS });
    buttons(container, "Try again")[0]!.click();
    await waitFor(() => expect(container.textContent).toContain("Orders are typed in twice."));
  });

  it("releases with a headline only when ready, says what the client sees, and withdraws", async () => {
    mockApi.proposals.mockResolvedValue({ roundId: "round-1", proposals: [] });
    render();
    await waitFor(() => expect(container.textContent).toContain("3 themes or quotes still wait for a decision"));
    expect(container.querySelector('[data-testid="interview-client-sees"]')!.textContent).toContain("The client sees no synthesis yet.");
    expect(buttons(container, "Release")[0]!.disabled).toBe(true);
    root.unmount();
    root = createRoot(container);

    const ready = releaseView({ readiness: { ready: true, blockers: [], themes: 1, quotes: 2 } });
    mockApi.release.mockResolvedValue(ready);
    mockApi.releaseSynthesis.mockResolvedValue({ ...ready, released: { synthesisId: "syn-1", releasedAt: "2026-10-26T10:00:00.000Z" } });
    mockApi.withdrawSynthesis.mockResolvedValue(ready);
    render();
    await waitFor(() => expect(container.textContent).toContain("Release sends 1 accepted theme and 2 accepted quotes."));
    const headline = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(headline, "Orders are typed twice.");
    headline.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    buttons(container, "Release")[0]!.click();
    await waitFor(() => expect(mockApi.releaseSynthesis).toHaveBeenCalledWith("round-1", { headline: "Orders are typed twice." }));
    await waitFor(() => expect(container.textContent).toContain("The client sees the synthesis released"));
    buttons(container, "Withdraw")[0]!.click();
    await waitFor(() => expect(mockApi.withdrawSynthesis).toHaveBeenCalledWith("round-1"));
    await waitFor(() => expect(container.textContent).toContain("The client sees no synthesis yet."));
  });
});
