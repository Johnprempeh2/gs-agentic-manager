// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveFilesResponse } from "@greatstone/shared";
import type { CaseSummary } from "@/api/cases";
import { DeepDiveFiles, heldAndMissing } from "./DeepDiveFiles";

// Generic fixtures only: "Client A", prefix C001. Never a real client.
const COMPANY_ID = "company-1";
const CLIENT = { id: "client-a", title: "Client A", pipelineId: "pipeline-1" };

function item(id: string, caseType: string, key: string): CaseSummary {
  return {
    id,
    companyId: COMPANY_ID,
    projectId: null,
    caseNumber: 1,
    identifier: `C001-${id}`,
    caseType,
    key,
    title: key,
    summary: null,
    status: "draft",
    fields: {},
    parentCaseId: null,
    visibility: "internal",
    clientCaseId: CLIENT.id,
    clientEditableFields: [],
    createdByAgentId: null,
    createdByUserId: "user-1",
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as CaseSummary;
}

const ITEMS = [
  item("record", "deep_dive", "record"),
  item("data", "deep_dive_stream", "data"),
  item("people", "deep_dive_stream", "people"),
];

const SCREEN: DeepDiveFilesResponse = {
  client: CLIENT,
  clients: [CLIENT, { id: "client-b", title: "Client B", pipelineId: "pipeline-1" }],
  evidence: [
    {
      id: "file-1",
      caseId: CLIENT.id,
      kind: "upload",
      title: "Org chart",
      note: null,
      typeLabel: "PDF",
      contentType: "application/pdf",
      byteSize: 100,
      originalFilename: "org.pdf",
      attachmentId: null,
      documentId: null,
      documentKey: null,
      assetId: "asset-1",
      stageId: null,
      stageName: null,
      url: null,
      contentPath: "/api/cases/client-a/evidence/file-1/content",
      downloadPath: null,
      openPath: "/api/cases/client-a/evidence/file-1/content",
      sourceIssue: null,
      addedBy: { type: "user", id: "user-1", name: "Sam Staff" },
      createdAt: "2026-10-12T09:00:00.000Z",
    },
  ],
  requests: [
    { id: "request-1", stageId: "stage-1", title: "Last year's accounts", note: null, createdAt: "2026-10-10T09:00:00.000Z", received: null },
  ],
  links: [
    { id: "link-1", caseId: "data", evidenceId: "file-1", documentRequestId: null, visibility: "internal", linkedBy: null, linkedAt: "2026-10-12T10:00:00.000Z" },
    { id: "link-2", caseId: "people", evidenceId: "file-1", documentRequestId: null, visibility: "shared", linkedBy: null, linkedAt: "2026-10-12T10:00:00.000Z" },
    { id: "link-3", caseId: "data", evidenceId: null, documentRequestId: "request-1", visibility: "internal", linkedBy: null, linkedAt: "2026-10-12T10:00:00.000Z" },
  ],
};

const mockCasesApi = vi.hoisted(() => ({
  list: vi.fn(),
  patch: vi.fn(),
  deepDiveFiles: vi.fn(),
  linkDeepDiveFile: vi.fn(),
  setDeepDiveFileVisibility: vi.fn(),
  unlinkDeepDiveFile: vi.fn(),
}));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
const mockWebsiteModuleApi = vi.hoisted(() => ({ sites: vi.fn() }));
const mockBridgeApi = vi.hoisted(() => ({ deepDiveSync: vi.fn() }));
vi.mock("@/api/website", () => ({ websiteModuleApi: mockWebsiteModuleApi }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mockBridgeApi }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY_ID }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(): Promise<HTMLDivElement> {
  const view = document.createElement("div");
  container = view;
  document.body.appendChild(view);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(view);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <DeepDiveFiles />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 10 && !view.querySelector("[data-deep-dive-file]"); i += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return view;
}

function select(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Deep Dive evidence and files", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockCasesApi.list.mockResolvedValue(ITEMS);
    mockCasesApi.deepDiveFiles.mockResolvedValue(SCREEN);
    mockCasesApi.linkDeepDiveFile.mockResolvedValue(SCREEN.links[0]);
    mockCasesApi.unlinkDeepDiveFile.mockResolvedValue({ deleted: true, link: SCREEN.links[0] });
    mockWebsiteModuleApi.sites.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("counts a linked file as held and a linked request with no file as missing", () => {
    expect(heldAndMissing("data", SCREEN.links, SCREEN.requests)).toEqual({ held: 1, missing: 1 });
    expect(heldAndMissing("people", SCREEN.links, SCREEN.requests)).toEqual({ held: 1, missing: 0 });
    expect(heldAndMissing("record", SCREEN.links, SCREEN.requests)).toEqual({ held: 0, missing: 0 });
    const received = [{ ...SCREEN.requests[0]!, received: { evidenceId: "file-2", title: "Accounts", contentPath: null, receivedAt: "2026-10-13T00:00:00.000Z" } }];
    expect(heldAndMissing("data", SCREEN.links, received)).toEqual({ held: 2, missing: 0 });
  });

  it("counts a request answered on the website as in, and says who answered it", async () => {
    const answered = [{ ...SCREEN.requests[0]!, websiteAnswer: {
      answeredAt: "2026-10-14T09:00:00.000Z", answeredBy: { customerId: "cust-1", name: "Test Client", email: null }, note: null, fileName: "accounts.pdf",
    } }];
    expect(heldAndMissing("data", SCREEN.links, answered)).toEqual({ held: 2, missing: 0 });
    mockCasesApi.deepDiveFiles.mockResolvedValue({ ...SCREEN, requests: answered });
    const container = await render();
    const row = container.querySelector("[data-deep-dive-request='request-1']")!;
    expect(row.textContent).toContain("Answered on the website 14 Oct by Test Client: accounts.pdf");
    expect(row.textContent).toContain("Received");
    expect(container.textContent).toContain("Documents asked for (1, 0 missing)");
  });

  it("hides the website card with no site, and sends the client's Shared items when there is one", async () => {
    let container = await render();
    expect(container.querySelector("[data-testid='deep-dive-website-sync']")).toBeNull();
    act(() => root?.unmount());
    container.remove();

    mockWebsiteModuleApi.sites.mockResolvedValue([{ id: "site-1", name: "Greatstone", domain: "www.greatstone.test" }]);
    mockBridgeApi.deepDiveSync.mockResolvedValue({
      tenantId: CLIENT.id, syncedAt: "2026-10-25T09:00:00.000Z", counts: { items: 3, files: 1, documentRequests: 1, deliverables: 0 },
    });
    container = await render();
    for (let i = 0; i < 10 && !container.querySelector("[data-testid='deep-dive-website-sync']"); i += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const card = container.querySelector("[data-testid='deep-dive-website-sync']")!;
    const button = [...card.querySelectorAll("button")].find((el) => el.textContent === "Send to website")!;
    await act(async () => button.click());
    for (let i = 0; i < 10 && !card.querySelector("[role='status']"); i += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(mockBridgeApi.deepDiveSync).toHaveBeenCalledWith(COMPANY_ID, "site-1", CLIENT.id);
    expect(card.textContent).toContain("3 items, 1 files, 1 document requests, 0 deliverables");
  });

  it("shows where each file came from, who added it, and held and missing per item", async () => {
    const container = await render();
    expect(container.textContent).toContain("This deep dive is about Client A.");
    const provenance = container.querySelector("[data-testid='deep-dive-file-provenance']")!;
    expect(provenance.textContent).toContain("Uploaded, added by Sam Staff");
    expect(container.querySelector("[data-deep-dive-item-counts='data']")!.textContent).toContain("1 held, 1 missing");
    expect(container.querySelector("[data-deep-dive-item-counts='people']")!.textContent).toContain("1 held, 0 missing");
    expect(container.querySelector("[data-deep-dive-request='request-1']")!.textContent).toContain("Missing");
    // One file, two items.
    const file = container.querySelector("[data-deep-dive-file='file-1']")!;
    expect([...file.querySelectorAll("[data-deep-dive-file-link]")].map((el) => el.getAttribute("data-deep-dive-file-link")))
      .toEqual(["data", "people"]);
  });

  it("links a file to another item and unlinks it from one item only", async () => {
    const container = await render();
    const file = container.querySelector("[data-deep-dive-file='file-1']")!;
    await act(async () => select(file.querySelector("select[aria-label='Link to an item']")!, "record"));
    expect(mockCasesApi.linkDeepDiveFile).toHaveBeenCalledWith("record", { evidenceId: "file-1" });

    const unlink = file.querySelector<HTMLButtonElement>("button[aria-label='Unlink from Data']")!;
    await act(async () => unlink.click());
    expect(mockCasesApi.unlinkDeepDiveFile).toHaveBeenCalledTimes(1);
    expect(mockCasesApi.unlinkDeepDiveFile).toHaveBeenCalledWith("data", "link-1");
  });
});
