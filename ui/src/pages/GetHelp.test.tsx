// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSupportTicket } from "@/api/clientSupport";
import { ApiError } from "@/api/client";
import { GetHelp, supportFileProblem, supportFileType } from "./GetHelp";

const COMPANY = "00000000-0000-0000-0000-00000000c0de";

const mockSupportApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), edit: vi.fn(), attach: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/clientSupport", () => ({ clientSupportApi: mockSupportApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { issuePrefix: "TCC" } }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date().toISOString();

// Test values only.
const OPEN: ClientSupportTicket = {
  id: "11111111-1111-1111-1111-111111111111",
  companyId: COMPANY,
  kind: "support",
  title: "Board page will not load",
  summary: "Blank page after sign-in.",
  priority: "P2",
  linkedIssueId: null,
  status: "in_progress",
  refusedReason: null,
  hubTicketId: "GRE-9001",
  hubOwner: "Ridge",
  firstResponseDueAt: NOW,
  firstResponseAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  replies: [{ id: "r1", body: "We are looking at it.", sentAt: NOW }],
  attachments: [{ id: "a1", name: "screen.png", contentType: "image/png", byteSize: 2048, sentAt: NOW, createdAt: NOW }],
};

const QUEUED: ClientSupportTicket = {
  ...OPEN,
  id: "22222222-2222-2222-2222-222222222222",
  kind: "upgrade",
  title: "More agents",
  priority: "P3",
  status: "queued",
  hubTicketId: null,
  hubOwner: null,
  firstResponseDueAt: null,
  firstResponseAt: null,
  replies: [],
  attachments: [],
};

const RESOLVED: ClientSupportTicket = { ...OPEN, id: "33333333-3333-3333-3333-333333333333", status: "resolved" };

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GetHelp />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(async () => {
    await flush();
    expect(container.querySelector('[data-testid="get-help-page"], .gs-empty, [role="alert"]')).not.toBeNull();
  });
}

function ticket(id: string) {
  return container.querySelector(`[data-testid="get-help-ticket-${id}"]`) as HTMLElement;
}

function button(scope: ParentNode, label: string) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

async function type(id: string, value: string) {
  const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const proto = Object.getPrototypeOf(element);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function submit() {
  const form = document.querySelector('[data-testid="get-help-form"]') as HTMLFormElement;
  await act(async () => {
    form.requestSubmit();
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "user-1", isInstanceAdmin: false });
  mockSupportApi.list.mockResolvedValue([OPEN, QUEUED, RESOLVED]);
  mockSupportApi.create.mockResolvedValue(QUEUED);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Get help page", () => {
  it("shows each ticket's status, kind, our ticket id, owner, reply times, replies and files", async () => {
    await render();
    const text = ticket(OPEN.id).textContent ?? "";
    expect(text).toContain("Board page will not load");
    expect(text).toContain("In progress");
    expect(text).toContain("Platform support");
    expect(text).toContain("Greatstone ticketGRE-9001");
    expect(text).toContain("Ridge");
    expect(text).toContain("First reply due");
    expect(text).toContain("We are looking at it.");
    expect(text).toContain("screen.png");
    expect(text).toContain("Files (1 of 5)");

    const queued = ticket(QUEUED.id).textContent ?? "";
    expect(queued).toContain("Upgrade request");
    expect(queued).toContain("Not sent yet");
    expect(queued).toContain("No reply yet");
  });

  it("has no edit or add-file button once a ticket is resolved or closed", async () => {
    await render();
    expect(button(ticket(OPEN.id), "Edit")).toBeDefined();
    expect(button(ticket(OPEN.id), "Add file")).toBeDefined();
    expect(button(ticket(RESOLVED.id), "Edit")).toBeUndefined();
    expect(button(ticket(RESOLVED.id), "Add file")).toBeUndefined();
  });

  it("opens an upgrade request at P3 and says it approves no spend", async () => {
    await render();
    await click(button(container, "Open a ticket")!);
    expect(document.body.textContent).toContain("The linked issue stays in this instance.");
    await type("get-help-kind", "upgrade");
    expect(document.querySelector('[data-testid="get-help-kind-help"]')?.textContent).toContain(
      "does not approve a purchase or any spend",
    );
    expect(document.getElementById("get-help-priority")).toBeNull();
    expect(document.querySelector('[data-testid="get-help-fixed-priority"]')?.textContent).toContain(
      "Quality reviews and upgrade requests are always P3.",
    );
    expect((document.getElementById("get-help-issue") as HTMLInputElement).placeholder).toBe("For example TCC-12");
    await type("get-help-title", "More agents");
    await submit();
    expect(mockSupportApi.create).toHaveBeenCalledWith(COMPANY, {
      kind: "upgrade",
      title: "More agents",
      summary: "",
      priority: "P3",
      linkedIssueId: null,
    });
  });

  it("links an issue by its identifier", async () => {
    mockIssuesApi.get.mockResolvedValue({ id: "44444444-4444-4444-4444-444444444444", companyId: COMPANY });
    await render();
    await click(button(container, "Open a ticket")!);
    await type("get-help-priority", "P1");
    await type("get-help-title", "Down");
    await type("get-help-issue", "GRE-12");
    await submit();
    expect(mockIssuesApi.get).toHaveBeenCalledWith("GRE-12");
    expect(mockSupportApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ kind: "support", priority: "P1", linkedIssueId: "44444444-4444-4444-4444-444444444444" }),
    );
  });

  it("says the ticket is closed when an edit is refused (409)", async () => {
    mockSupportApi.edit.mockRejectedValue(new ApiError("conflict", 409, null));
    await render();
    await click(button(ticket(OPEN.id), "Edit")!);
    await type("get-help-title", "New title");
    await submit();
    expect(mockSupportApi.edit).toHaveBeenCalledWith(COMPANY, OPEN.id, { title: "New title", summary: OPEN.summary });
    expect(document.querySelector('[data-testid="get-help-form"] [role="alert"]')?.textContent).toBe(
      "This ticket is closed. Open a new ticket.",
    );
  });

  it("does not load tickets for anyone who is not a signed-in board user", async () => {
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new ApiError("no", 401, null));
    await render();
    expect(mockSupportApi.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Get help is for board members");
  });

  it("checks a file before it is sent", () => {
    const png = { name: "a.png", type: "image/png", size: 10 };
    expect(supportFileProblem(png, 0)).toBeNull();
    expect(supportFileProblem(png, 5)).toContain("5 files at most");
    expect(supportFileProblem({ name: "a.zip", type: "application/zip", size: 10 }, 0)).toContain("PNG, JPEG");
    expect(supportFileProblem({ ...png, size: 5 * 1024 * 1024 + 1 }, 0)).toContain("5 MB");
    expect(supportFileType({ name: "data.CSV", type: "application/vnd.ms-excel" })).toBe("text/csv");
  });
});
