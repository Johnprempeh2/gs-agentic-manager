// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEP_DIVE_STREAMS,
  defaultDeepDiveStreamFields,
  type DeepDiveSession,
  type DeepDiveSessionQuestion,
  type DeepDiveStreamKey,
} from "@greatstone/shared";
import type { CaseSummary } from "@/api/cases";
import { DeepDiveSessionDetail, DeepDiveSessions } from "./DeepDiveSessions";

// Generic fixtures only: "Client company", prefix C001. Never a real client.
const COMPANY_ID = "company-1";

const store = vi.hoisted(() => ({ session: null as unknown }));
const navigate = vi.hoisted(() => vi.fn());

function session(): DeepDiveSession {
  return store.session as DeepDiveSession;
}

function streamRow(key: string, index: number): CaseSummary {
  const fields = defaultDeepDiveStreamFields(key as DeepDiveStreamKey);
  if (key === "operations") fields.knowledge["current-state"] = "indicated";
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
    fields,
    parentCaseId: "case-1",
    visibility: "internal",
    clientCaseId: null,
    clientEditableFields: [],
    createdByAgentId: null,
    createdByUserId: "user-1",
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as CaseSummary;
}

function question(id: string, position: number, overrides: Partial<DeepDiveSessionQuestion>): DeepDiveSessionQuestion {
  return {
    id,
    sessionId: "session-1",
    position,
    streamCaseId: "stream-operations",
    gifKey: "current-state",
    gifDocumentId: `cell-${id}`,
    prompt: "What exists today?",
    answer: null,
    answeredAt: null,
    answeredByUserId: null,
    answeredByAgentId: null,
    findingId: null,
    known: { knowledge: "unknown", cellText: null, findings: [], earlierAnswers: [] },
    ...overrides,
  };
}

function plannedSession(): DeepDiveSession {
  return {
    id: "session-1",
    companyId: COMPANY_ID,
    title: "Operations lead interview",
    status: "planned",
    visibility: "internal",
    plannedFor: null,
    startedAt: null,
    closedAt: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    questionCount: 2,
    answeredCount: 0,
    questions: [
      question("q-1", 0, {
        known: {
          knowledge: "indicated",
          cellText: "Two teams share one rota.",
          findings: [],
          earlierAnswers: [
            {
              questionId: "q-old",
              sessionId: "session-0",
              sessionTitle: "HR interview",
              answer: "The rota is a shared spreadsheet.",
              answeredAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        },
      }),
      question("q-2", 1, { gifKey: "business-impact", prompt: "What does a late order cost?" }),
    ],
  };
}

const mockCasesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSessionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  plan: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  addQuestion: vi.fn(),
  updateQuestion: vi.fn(),
  removeQuestion: vi.fn(),
  answerToFinding: vi.fn(),
}));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/deepDiveSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deepDiveSessions")>()),
  deepDiveSessionsApi: mockSessionsApi,
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
  useNavigate: () => navigate,
  useParams: () => ({ sessionId: "session-1" }),
}));

/** A fake server with the same order: Planned -> Live -> Closed, answers only while Live. */
function installFakeServer() {
  mockCasesApi.list.mockResolvedValue(DEEP_DIVE_STREAMS.map((stream, index) => streamRow(stream.key, index)));
  const counts = () => {
    session().questionCount = session().questions.length;
    session().answeredCount = session().questions.filter((q) => q.answer).length;
    return structuredClone(session());
  };
  mockSessionsApi.list.mockImplementation(async () => (store.session ? [counts()] : []));
  mockSessionsApi.plan.mockImplementation(async (_companyId: string, input: { title: string }) => {
    store.session = { ...plannedSession(), title: input.title, questions: [] };
    return counts();
  });
  mockSessionsApi.get.mockImplementation(async () => counts());
  mockSessionsApi.start.mockImplementation(async () => {
    session().status = "live";
    session().startedAt = "2026-10-03T00:00:00.000Z";
    return counts();
  });
  mockSessionsApi.close.mockImplementation(async () => {
    session().status = "closed";
    session().closedAt = "2026-10-03T01:00:00.000Z";
    return counts();
  });
  mockSessionsApi.updateQuestion.mockImplementation(async (id: string, input: { answer?: string | null }) => {
    if (session().status !== "live") throw new Error("This session is not Live, so you cannot answer it");
    const target = session().questions.find((q) => q.id === id)!;
    target.answer = input.answer ?? null;
    return counts();
  });
  mockSessionsApi.answerToFinding.mockImplementation(async (id: string) => {
    const target = session().questions.find((q) => q.id === id)!;
    target.findingId = "finding-1";
    return { finding: { id: "finding-1" }, session: counts() };
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

function button(container: HTMLElement, label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

describe("Deep Dive sessions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    store.session = plannedSession();
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

  it("plans a session and opens it", async () => {
    store.session = null;
    render(<DeepDiveSessions />);
    await waitFor(() => expect(container.textContent).toContain("No sessions yet."));

    flushSync(() => button(container, "Plan session").click());
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Name the session."));
    expect(mockSessionsApi.plan).not.toHaveBeenCalled();

    flushSync(() => setValue(container.querySelector<HTMLInputElement>("input:not([type])")!, "Operations lead interview"));
    flushSync(() => button(container, "Plan session").click());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/deep-dive/sessions/session-1"));
    expect(mockSessionsApi.plan).toHaveBeenCalledWith(COMPANY_ID, { title: "Operations lead interview", plannedFor: null });
  });

  it("shows what is known beside each planned question, runs one question at a time, and closes", async () => {
    render(<DeepDiveSessionDetail />);
    await waitFor(() => expect(container.textContent).toContain("Operations lead interview"));

    // Planning: what is known shows beside each question.
    const first = container.querySelector<HTMLElement>('[data-deep-dive-question="q-1"]')!;
    const known = first.querySelector<HTMLElement>('[aria-label="Already known"]')!;
    expect(known.textContent).toContain("Indicated");
    expect(known.textContent).toContain("Two teams share one rota.");
    expect(known.textContent).toContain("HR interview: The rota is a shared spreadsheet.");
    const second = container.querySelector<HTMLElement>('[data-deep-dive-question="q-2"]')!;
    expect(second.textContent).toContain("Nothing yet. This is a gap worth asking about.");
    // The GIF question picker shows each cell's knowledge.
    expect(container.textContent).toContain("Current state (Indicated)");

    flushSync(() => button(container, "Start session").click());
    await waitFor(() => expect(container.textContent).toContain("Question 1 of 2"));
    expect(mockSessionsApi.start).toHaveBeenCalledWith("session-1");
    // Live: no rewording or removal; the current question has what is known beside it.
    expect(() => button(container, "Remove")).toThrow();
    const live = container.querySelector<HTMLElement>('[aria-labelledby="deep-dive-live-question"]')!;
    expect(live.querySelector("#deep-dive-live-question")?.textContent).toBe("What exists today?");
    expect(live.querySelector('[aria-label="Already known"]')?.textContent).toContain("The rota is a shared spreadsheet.");

    flushSync(() => setValue(live.querySelector("textarea")!, "Orders are keyed by hand."));
    flushSync(() => button(container, "Save and next", live).click());
    await waitFor(() => expect(container.textContent).toContain("Question 2 of 2"));
    expect(mockSessionsApi.updateQuestion).toHaveBeenCalledWith("q-1", { answer: "Orders are keyed by hand." });
    expect(container.querySelector("#deep-dive-live-question")?.textContent).toBe("What does a late order cost?");
    expect(container.textContent).toContain("1 of 2 answered");

    flushSync(() => button(container, "Close session").click());
    await waitFor(() => expect(container.textContent).toContain("Closed"));
    expect(container.querySelector("#deep-dive-live-question")).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-deep-dive-question="q-2"]')!.textContent).toContain("Not answered");
  });

  it("turns an answer into a proposed finding in the same cell", async () => {
    const closed = plannedSession();
    closed.status = "closed";
    closed.startedAt = "2026-10-03T00:00:00.000Z";
    closed.closedAt = "2026-10-03T01:00:00.000Z";
    closed.questions[0]!.answer = "The rota is kept in two places.";
    store.session = closed;
    render(<DeepDiveSessionDetail />);
    await waitFor(() => expect(container.textContent).toContain("The rota is kept in two places."));

    const row = container.querySelector<HTMLElement>('[data-deep-dive-question="q-1"]')!;
    // An unanswered question has nothing to turn into a finding.
    expect(container.querySelector<HTMLElement>('[data-deep-dive-question="q-2"]')!.textContent).not.toContain("Turn into a finding");

    flushSync(() => button(container, "Turn into a finding", row).click());
    expect(row.querySelector("textarea")?.value).toBe("The rota is kept in two places.");
    flushSync(() => button(container, "Propose finding", row).click());
    await waitFor(() => expect(container.textContent).toContain("Proposed as a finding"));
    // Unchanged text: the server uses the answer as the statement.
    expect(mockSessionsApi.answerToFinding).toHaveBeenCalledWith("q-1", {});
  });
});
