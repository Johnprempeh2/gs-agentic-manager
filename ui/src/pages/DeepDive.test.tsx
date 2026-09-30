// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEEP_DIVE_GIF, DEEP_DIVE_STREAMS, defaultDeepDiveStreamFields } from "@greatstone/shared";
import { ApiError } from "@/api/client";
import type { CaseDetail, CaseSummary, CreateCaseInput } from "@/api/cases";
import { DeepDive, startDeepDiveRecord } from "./DeepDive";

// Generic fixtures only: "Client company", prefix C001. Never a real client.
const COMPANY_ID = "company-1";

type StoredCase = CaseSummary & { documents: Map<string, string> };

const store = vi.hoisted(() => ({ cases: [] as unknown[] }));

function stored(): StoredCase[] {
  return store.cases as StoredCase[];
}

function findStored(idOrIdentifier: string) {
  const row = stored().find((entry) => entry.id === idOrIdentifier || entry.identifier === idOrIdentifier);
  if (!row) throw new ApiError("Case not found", 404, null);
  return row;
}

function summary(row: StoredCase): CaseSummary {
  const { documents: _documents, ...rest } = row;
  return { ...rest, fields: structuredClone(row.fields) };
}

function toDetail(row: StoredCase): CaseDetail {
  return {
    ...summary(row),
    parent: null,
    labels: [],
    issueLinks: [],
    attachments: [],
    documents: [...row.documents.entries()].map(([key, body]) => ({
      key,
      document: {
        id: `${row.id}-${key}`,
        companyId: row.companyId,
        title: key,
        format: "markdown",
        latestBody: body,
        latestRevisionId: `${row.id}-${key}-r1`,
        latestRevisionNumber: 1,
        createdByAgentId: null,
        createdByUserId: "user-1",
        updatedByAgentId: null,
        updatedByUserId: "user-1",
        lockedAt: null,
        lockedByAgentId: null,
        lockedByUserId: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    })),
  };
}

function insertCase(input: CreateCaseInput): StoredCase {
  const number = stored().length + 1;
  const row: StoredCase = {
    id: `case-${number}`,
    companyId: COMPANY_ID,
    projectId: null,
    caseNumber: number,
    identifier: `C001-C${number}`,
    caseType: input.caseType,
    key: input.key ?? null,
    title: input.title,
    summary: null,
    status: "draft",
    fields: structuredClone(input.fields ?? {}),
    parentCaseId: input.parentCaseId ?? null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    documents: new Map(),
  };
  store.cases.push(row);
  return row;
}

const mockCasesApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  upsertDocument: vi.fn(),
}));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
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
  useNavigate: () => vi.fn(),
  useCaseHref: () => (...segments: string[]) => `/C001/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

function installFakeServer() {
  mockCasesApi.list.mockImplementation(async (_companyId: string, params: { types?: string[] }) =>
    stored().filter((row) => !params.types || params.types.includes(row.caseType)).map(summary),
  );
  mockCasesApi.get.mockImplementation(async (id: string) => toDetail(findStored(id)));
  // The real route upserts on caseType + key; keep that so a duplicate create would show.
  mockCasesApi.create.mockImplementation(async (_companyId: string, input: CreateCaseInput) => {
    const existing = stored().find((row) => row.caseType === input.caseType && row.key === (input.key ?? null));
    if (existing) {
      existing.title = input.title;
      if (input.fields) existing.fields = structuredClone(input.fields);
      return toDetail(existing);
    }
    return toDetail(insertCase(input));
  });
  mockCasesApi.patch.mockImplementation(async (id: string, input: { fields?: Record<string, unknown> }) => {
    const row = findStored(id);
    if (input.fields) row.fields = structuredClone(input.fields);
    return toDetail(row);
  });
  mockCasesApi.upsertDocument.mockImplementation(
    async (id: string, key: string, data: { body: string; baseRevisionId?: string | null }) => {
      const row = findStored(id);
      if (row.documents.has(key) && !data.baseRevisionId) {
        throw new ApiError("Case document update requires baseRevisionId", 409, null);
      }
      row.documents.set(key, data.body);
      return { document: { key, body: data.body }, revision: {} };
    },
  );
}

/** A complete record: Data evidence and Leadership current state are Known, one Indicated. */
function seedRecord() {
  const record = insertCase({ caseType: "deep_dive", key: "record", title: "Deep dive record" });
  record.documents.set("north-star", "# North Star\n\nThe chief executive's words, who said them and when.\n\nBe the most trusted operator in the region.\n");
  for (const stream of DEEP_DIVE_STREAMS) {
    const fields = defaultDeepDiveStreamFields(stream.key);
    if (stream.key === "data") fields.knowledge.evidence = "known";
    if (stream.key === "leadership") {
      fields.knowledge["current-state"] = "known";
      fields.knowledge["future-state"] = "indicated";
    }
    const row = insertCase({
      caseType: "deep_dive_stream",
      key: stream.key,
      title: `Deep dive: ${stream.label}`,
      parentCaseId: record.id,
      fields: { ...fields },
    });
    for (const gif of DEEP_DIVE_GIF) {
      row.documents.set(gif.documentKey, `# ${gif.label}\n\n${gif.question}\n`);
    }
  }
  const data = stored().find((row) => row.key === "data")!;
  data.documents.set("gif-evidence", "# Evidence\n\nWhat objectively supports this understanding?\n\n- Finance export, 12 Sep, pulled by us\n");
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

function setSelect(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function streamSection(container: HTMLElement, key: string) {
  return container.querySelector<HTMLElement>(`[data-deep-dive-stream="${key}"]`)!;
}

function selectIn(section: HTMLElement, label: string) {
  const match = [...section.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label));
  return match!.querySelector("select")!;
}

describe("DeepDive", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <DeepDive />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  beforeEach(() => {
    store.cases.length = 0;
    installFakeServer();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the nine streams by five GIF questions from the stored cases", async () => {
    seedRecord();
    await renderPage();

    await waitFor(() => expect(container.querySelectorAll("[data-deep-dive-cell]")).toHaveLength(45));
    const sections = [...container.querySelectorAll<HTMLElement>("[data-deep-dive-stream]")];
    expect(sections.map((section) => section.dataset.deepDiveStream)).toEqual(DEEP_DIVE_STREAMS.map((s) => s.key));
    for (const section of sections) {
      expect(section.querySelectorAll("[data-deep-dive-cell]")).toHaveLength(5);
    }

    const evidence = container.querySelector<HTMLAnchorElement>('[data-deep-dive-cell="data:evidence"]')!;
    expect(evidence.dataset.knowledge).toBe("known");
    expect(evidence.textContent).toContain("Known");
    await waitFor(() => expect(evidence.textContent).toContain("Finance export, 12 Sep, pulled by us"));
    const dataCase = stored().find((row) => row.key === "data")!;
    expect(evidence.getAttribute("href")).toBe(`/C001/cases/${dataCase.identifier}#document-gif-evidence`);

    // A stub holds only the heading and the question, so it reads as no answer yet.
    const stub = container.querySelector('[data-deep-dive-cell="people:current-state"]')!;
    expect(stub.textContent).toContain("Unknown");
    expect(stub.textContent).toContain("No answer yet");

    await waitFor(() => expect(container.textContent).toContain("Be the most trusted operator in the region."));
    expect(container.querySelector('[data-testid="deep-dive-coverage"]')?.textContent).toBe(
      "2 of 45 cells known. 1 indicated, 42 unknown.",
    );
    const draft = [...container.querySelectorAll("button")].find((b) => b.textContent === "Draft the agent team");
    expect(draft?.disabled).toBe(true);
  });

  it("creates the record once however many times Start is pressed", async () => {
    await renderPage();
    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start the deep dive record",
    )!;
    expect(startButton).toBeTruthy();

    startButton.click();
    startButton.click();
    await waitFor(() => expect(container.querySelectorAll("[data-deep-dive-cell]")).toHaveLength(45));
    await waitFor(() => expect(mockCasesApi.upsertDocument).toHaveBeenCalledTimes(45));

    expect(mockCasesApi.create).toHaveBeenCalledTimes(10);
    expect(stored()).toHaveLength(10);
    for (const row of stored().filter((entry) => entry.caseType === "deep_dive_stream")) {
      expect([...row.documents.keys()].sort()).toEqual(DEEP_DIVE_GIF.map((gif) => gif.documentKey).sort());
      expect(row.documents.get("gif-evidence")).toBe("# Evidence\n\nWhat objectively supports this understanding?\n");
    }

    // Running it again on a complete record creates nothing.
    await startDeepDiveRecord(COMPANY_ID);
    expect(mockCasesApi.create).toHaveBeenCalledTimes(10);
    expect(mockCasesApi.upsertDocument).toHaveBeenCalledTimes(45);
    expect(stored()).toHaveLength(10);
  });

  it("fills in only what is missing from a partial record", async () => {
    seedRecord();
    const people = stored().find((row) => row.key === "people")!;
    people.documents.delete("gif-evidence");
    const fieldsBefore = structuredClone(stored().find((row) => row.key === "data")!.fields);

    await startDeepDiveRecord(COMPANY_ID);

    expect(mockCasesApi.create).not.toHaveBeenCalled();
    expect(mockCasesApi.upsertDocument).toHaveBeenCalledTimes(1);
    expect(mockCasesApi.upsertDocument).toHaveBeenCalledWith(people.id, "gif-evidence", expect.anything());
    expect(stored().find((row) => row.key === "data")!.fields).toEqual(fieldsBefore);
  });

  it("refuses to reduce a stream without a named reason", async () => {
    seedRecord();
    await renderPage();
    await waitFor(() => expect(streamSection(container, "data")).toBeTruthy());

    const section = streamSection(container, "data");
    setSelect(selectIn(section, "Depth"), "reduced");
    await flush();

    const form = section.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(section.querySelector('[role="alert"]')?.textContent).toContain("Name the reason");
    expect(mockCasesApi.patch).not.toHaveBeenCalled();

    setInput(section.querySelector<HTMLInputElement>("form input")!, "   ");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(mockCasesApi.patch).not.toHaveBeenCalled();

    setInput(section.querySelector<HTMLInputElement>("form input")!, "Covered by the Technology stream this round");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(mockCasesApi.patch).toHaveBeenCalledTimes(1));
    const [, patch] = mockCasesApi.patch.mock.calls[0]!;
    expect(patch.fields).toMatchObject({
      stream: "data",
      depth: "reduced",
      depthReason: "Covered by the Technology stream this round",
      visibility: "internal",
      knowledge: { evidence: "known" },
    });
    await waitFor(() =>
      expect(streamSection(container, "data").textContent).toContain("Reduced: Covered by the Technology stream this round"),
    );
  });

  it("creates nothing Shared: every stream starts Internal", async () => {
    await renderPage();
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Start the deep dive record")!.click();
    await waitFor(() => expect(container.querySelectorAll("[data-deep-dive-stream]")).toHaveLength(9));

    const streams = stored().filter((row) => row.caseType === "deep_dive_stream");
    expect(streams).toHaveLength(9);
    for (const row of streams) {
      expect(row.fields.visibility).toBe("internal");
      expect(Object.values(row.fields.knowledge as Record<string, string>).every((k) => k === "unknown")).toBe(true);
    }
    expect(JSON.stringify(mockCasesApi.create.mock.calls)).not.toContain("shared");
    for (const section of container.querySelectorAll<HTMLElement>("[data-deep-dive-stream]")) {
      expect(selectIn(section, "Visibility").value).toBe("internal");
    }
    expect(container.querySelector('[data-testid="deep-dive-coverage"]')?.textContent).toBe(
      "0 of 45 cells known. 0 indicated, 45 unknown.",
    );
  });
});
