// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

// Portal documents (GRE-4084): the list with status, a new draft and an edit on their routes with an Idempotency-Key,
// submit and withdraw after a confirm, and Approve and publish shown only to a person with Publish rights.

const COMPANY = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const SITE = "51e00000-0000-4000-8000-000000000001";
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const DRAFT = "d0c00000-0000-4000-8000-000000000001";
const PENDING = "d0c00000-0000-4000-8000-000000000002";
const PUBLISHED = "d0c00000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const KEY = expect.stringMatching(/^[A-Za-z0-9_-]{22}$/);

const mocks = vi.hoisted(() => ({
  documents: { create: vi.fn(), edit: vi.fn(), step: vi.fn() },
  bridge: { list: vi.fn() },
  boardAccess: vi.fn(),
  siteAccess: vi.fn(),
}));
vi.mock("@/api/website-portal-documents", () => ({ websitePortalDocumentsApi: mocks.documents }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mocks.bridge }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.boardAccess } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { issuePrefix: "GRE" } }) }));
vi.mock("@/api/website", () => ({ websiteModuleApi: { access: mocks.siteAccess, sites: vi.fn() } }));

import { WebsitePortalDocuments, portalDocumentRow } from "./WebsitePortalDocuments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, customer_id: CUSTOMER, kind: "engagement_pack", series: null, version: 1, title: `Pack ${status}`, summary: null,
  action: "none", confirmation_text: null, signatory_email: null, status, content_sha256: status === "draft" ? null : SHA,
  created_by_kind: "agent", updated_at: "2026-11-06T10:00:00Z", row_version: 3, ...extra,
});
const documents = [doc(DRAFT, "draft"), doc(PENDING, "pending_approval"), doc(PUBLISHED, "published")];

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
const button = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === name);
const row = (container: HTMLElement, title: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="portal-document-row"]')).find((entry) => entry.textContent?.includes(title))!;
const field = (container: ParentNode, label: string) => {
  const target = Array.from(container.querySelectorAll("label")).find((entry) => entry.textContent === label)!;
  return document.getElementById(target.htmlFor) as HTMLInputElement;
};

describe("WebsitePortalDocuments", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.bridge.list.mockImplementation((_company: string, _site: string, resource: string) =>
      Promise.resolve(resource === "customers"
        ? { items: [{ id: CUSTOMER, name: "Acme Ltd" }], nextCursor: null }
        : { items: documents, nextCursor: null }));
    mocks.documents.create.mockResolvedValue({ item: doc(DRAFT, "draft") });
    mocks.documents.edit.mockResolvedValue({ item: doc(DRAFT, "draft") });
    mocks.documents.step.mockResolvedValue({ item: doc(DRAFT, "pending_approval") });
    mocks.boardAccess.mockResolvedValue({ source: "session", userId: "user-1" });
    mocks.siteAccess.mockResolvedValue({ view: true, edit: true, publish: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter><WebsitePortalDocuments companyId={COMPANY} siteId={SITE} /></MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("lists each document with its client, kind and status", async () => {
    await render();
    const rows = container.querySelectorAll('[data-testid="portal-document-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Draft");
    expect(rows[0]!.textContent).toContain("Acme Ltd · Engagement pack · Version 1 · Drafted by an agent");
    expect(rows[1]!.textContent).toContain("Waiting for approval");
    expect(rows[2]!.textContent).toContain("Published");
  });

  it("creates a draft for the picked client", async () => {
    await render();
    click(button("New draft")!);
    await flush();
    const editor = container.querySelector<HTMLFormElement>('[data-testid="portal-document-editor"]')!;
    click(button("Create draft", editor)!);
    await flush();
    expect(editor.textContent).toContain("customerId");
    expect(mocks.documents.create).not.toHaveBeenCalled();
    setValue(field(editor, "Client company") as unknown as HTMLSelectElement, CUSTOMER);
    setValue(field(editor, "Kind") as unknown as HTMLSelectElement, "nda");
    setValue(field(editor, "Title"), "Mutual NDA");
    click(button("Add a section", editor)!);
    setValue(field(editor, "Section 1 heading"), "Terms");
    setValue(field(editor, "Section 1 text (HTML)") as unknown as HTMLTextAreaElement, "<p>Both sides keep it private.</p>");
    click(button("Create draft", editor)!);
    await flush();
    expect(mocks.documents.create).toHaveBeenCalledWith(COMPANY, SITE, {
      customerId: CUSTOMER, kind: "nda", title: "Mutual NDA", summary: null, action: "none", confirmationText: null,
      signatoryEmail: null, body: { sections: [{ id: "section-1", title: "Terms", html: "<p>Both sides keep it private.</p>" }] },
    }, KEY);
    expect(container.querySelector('[data-testid="portal-document-editor"]')).toBeNull();
  });

  it("refuses section HTML the website would refuse, before sending", async () => {
    await render();
    click(button("New draft")!);
    await flush();
    const editor = container.querySelector<HTMLFormElement>('[data-testid="portal-document-editor"]')!;
    setValue(field(editor, "Client company") as unknown as HTMLSelectElement, CUSTOMER);
    setValue(field(editor, "Title"), "Pack");
    click(button("Add a section", editor)!);
    setValue(field(editor, "Section 1 heading"), "Intro");
    setValue(field(editor, "Section 1 text (HTML)") as unknown as HTMLTextAreaElement, "<script>x</script>");
    click(button("Create draft", editor)!);
    await flush();
    expect(editor.textContent).toContain("<script> is not allowed");
    expect(mocks.documents.create).not.toHaveBeenCalled();
  });

  it("edits a draft without sending sections it never read", async () => {
    await render();
    click(button("Edit", row(container, "Pack draft"))!);
    await flush();
    const editor = container.querySelector<HTMLFormElement>('[data-testid="portal-document-editor"]')!;
    expect(editor.textContent).toContain("kept on the website");
    setValue(field(editor, "Title"), "Pack, revised");
    click(button("Save draft", editor)!);
    await flush();
    expect(mocks.documents.edit).toHaveBeenCalledWith(COMPANY, SITE, DRAFT, {
      expectedRowVersion: 3, title: "Pack, revised", summary: null, action: "none", confirmationText: null, signatoryEmail: null,
    }, KEY);
  });

  it("submits a draft only after the confirm", async () => {
    await render();
    click(button("Submit", row(container, "Pack draft"))!);
    await flush();
    expect(mocks.documents.step).not.toHaveBeenCalled();
    click(button("Submit for approval")!);
    await flush();
    expect(mocks.documents.step).toHaveBeenCalledWith(COMPANY, SITE, DRAFT, "submit", { expectedRowVersion: 3 }, KEY);
  });

  it("approves and publishes with the frozen fingerprint", async () => {
    await render();
    click(button("Approve and publish", row(container, "Pack pending_approval"))!);
    await flush();
    click(button("Approve and publish", document.querySelector('[role="alertdialog"]')!)!);
    await flush();
    expect(mocks.documents.step).toHaveBeenCalledWith(COMPANY, SITE, PENDING, "approve-and-publish", { expectedContentSha256: SHA }, KEY);
  });

  it("withdraws a published document after the confirm", async () => {
    await render();
    click(button("Withdraw", row(container, "Pack published"))!);
    await flush();
    click(button("Withdraw", document.querySelector('[role="alertdialog"]')!)!);
    await flush();
    expect(mocks.documents.step).toHaveBeenCalledWith(COMPANY, SITE, PUBLISHED, "withdraw", { expectedRowVersion: 3 }, KEY);
  });

  it("hides Approve and publish and Withdraw from anyone who is not a person with Publish rights", async () => {
    mocks.boardAccess.mockRejectedValue(new ApiError("Board access required", 403, { error: "Board access required" }));
    await render();
    expect(button("Approve and publish")).toBeUndefined();
    expect(button("Withdraw")).toBeUndefined();
    expect(button("Submit", row(container, "Pack draft"))).toBeDefined();
    expect(button("Return to draft", row(container, "Pack pending_approval"))).toBeDefined();
    expect(container.textContent).toContain("Agents draft and submit");
  });

  it("hides Approve and publish from a person without Publish rights, and drafting from one without Edit rights", async () => {
    mocks.siteAccess.mockResolvedValue({ view: true, edit: false, publish: false });
    await render();
    expect(button("Approve and publish")).toBeUndefined();
    expect(button("New draft")).toBeUndefined();
    expect(button("Edit")).toBeUndefined();
    expect(button("Submit")).toBeUndefined();
  });

  it("says when the website does not link the person to a portal approver", async () => {
    mocks.documents.step.mockRejectedValue(new ApiError("The website refused this change", 403,
      { error: "The website refused this change", code: "website_bridge_denied" }));
    await render();
    click(button("Approve and publish", row(container, "Pack pending_approval"))!);
    await flush();
    click(button("Approve and publish", document.querySelector('[role="alertdialog"]')!)!);
    await flush();
    expect(container.querySelector('[data-testid="portal-documents-error"]')?.textContent).toContain("Not a portal approver");
  });

  it("reads a row defensively", () => {
    expect(portalDocumentRow({ id: DRAFT, status: "nonsense" })).toBeNull();
    expect(portalDocumentRow({ id: DRAFT, status: "draft", content_sha256: "short", row_version: "2" }))
      .toMatchObject({ contentSha256: null, rowVersion: 2, sections: null });
  });
});
