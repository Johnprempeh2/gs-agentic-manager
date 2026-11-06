// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

// People and access (GRE-4086): the lists, the person-only controls, each change on its route with an
// Idempotency-Key, and the site's answers in words.

const COMPANY = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const SITE = "51e00000-0000-4000-8000-000000000001";
const OWNER = "5af00000-0000-4000-8000-000000000001";
const EDITOR = "5af00000-0000-4000-8000-000000000002";
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const MEMBERSHIP = "3e300000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  access: { staff: vi.fn(), portalApprovers: vi.fn(), clientMembers: vi.fn(), change: vi.fn() },
  bridge: { list: vi.fn() },
  boardAccess: vi.fn(),
  siteAccess: vi.fn(),
}));
vi.mock("@/api/website-access", () => ({ websiteAccessApi: mocks.access }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mocks.bridge }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.boardAccess } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { issuePrefix: "GRE" } }) }));
vi.mock("../../api/website", () => ({ websiteModuleApi: { access: mocks.siteAccess, sites: vi.fn() } }));

import { WebsitePeople } from "./WebsitePeople";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const staff = [
  { id: OWNER, email: "john@greatstone.example", name: "John", role: "owner", isActive: true, canSignIn: true, portalApprover: true,
    lastLoginAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z" },
  { id: EDITOR, email: "ama@greatstone.example", name: "Ama", role: "editor", isActive: true, canSignIn: true, portalApprover: false,
    lastLoginAt: null, updatedAt: "2026-11-05T09:00:00Z" },
];
const approvers = [{ staffId: OWNER, email: "john@greatstone.example", name: "John", label: "Director", staffActive: true, addedAt: "2026-11-01T00:00:00Z" }];
const members = [{ membershipId: MEMBERSHIP, organisationId: CUSTOMER, userId: "u-1", email: "kofi@acme.example", name: "Kofi",
  role: "member", isPrimary: true, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }];

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const click = (element: Element) => act(() => { (element as HTMLElement).click(); });
const button = (name: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === name);

describe("WebsitePeople", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.access.staff.mockResolvedValue({ items: staff, nextCursor: null });
    mocks.access.portalApprovers.mockResolvedValue({ items: approvers, nextCursor: null });
    mocks.access.clientMembers.mockResolvedValue({ items: members, nextCursor: null });
    mocks.access.change.mockResolvedValue({ item: {} });
    mocks.bridge.list.mockResolvedValue({ items: [{ id: CUSTOMER, name: "Acme Ltd" }], nextCursor: null });
    mocks.boardAccess.mockResolvedValue({ source: "session", userId: "user-1" });
    mocks.siteAccess.mockResolvedValue({ publish: true });
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
          <MemoryRouter><WebsitePeople companyId={COMPANY} siteId={SITE} /></MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("changes a staff role only after the person confirms it", async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Role for Ama"]')!;
    expect(select.value).toBe("editor");
    setValue(select, "admin");
    await flush();
    expect(mocks.access.change).not.toHaveBeenCalled();
    click(button("Change role")!);
    await flush();
    expect(mocks.access.change).toHaveBeenCalledWith(COMPANY, SITE, { kind: "staff_role", staffId: EDITOR, role: "admin" },
      expect.stringMatching(/^[A-Za-z0-9_-]{22}$/));
  });

  it("explains the site's refusal to move the last owner", async () => {
    mocks.access.change.mockRejectedValue(new ApiError("The website refused", 409, { error: "The website refused", code: "website_bridge_conflict" }));
    await render();
    setValue(container.querySelector<HTMLSelectElement>('select[aria-label="Role for John"]')!, "viewer");
    await flush();
    click(button("Change role")!);
    await flush();
    expect(container.querySelector('[data-testid="website-access-error"]')?.textContent).toContain("at least one active owner");
  });

  it("adds a portal approver from the staff not yet listed", async () => {
    await render();
    const form = container.querySelector<HTMLFormElement>('[data-testid="website-access-approver-add"]')!;
    const options = Array.from(form.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toEqual(["Pick a staff member", "Ama"]);
    setValue(form.querySelector("select")!, EDITOR);
    setValue(form.querySelector("input")!, "Finance");
    click(button("Add approver", form)!);
    await flush();
    expect(mocks.access.change).toHaveBeenCalledWith(COMPANY, SITE, { kind: "approver_set", staffId: EDITOR, label: "Finance" }, expect.any(String));
  });

  it("lists a client company's members and adds one", async () => {
    await render();
    const clients = container.querySelector('[data-testid="website-access-clients"]')!;
    setValue(clients.querySelector("select")!, CUSTOMER);
    await flush();
    expect(mocks.access.clientMembers).toHaveBeenCalledWith(COMPANY, SITE, CUSTOMER);
    expect(container.querySelector('[data-testid="website-access-member-row"]')?.textContent).toContain("Kofi");
    const form = container.querySelector<HTMLFormElement>('[data-testid="website-access-member-add"]')!;
    const [name, email] = Array.from(form.querySelectorAll("input"));
    setValue(name, "Efua");
    setValue(email, "not an email");
    click(button("Add person", form)!);
    await flush();
    expect(form.textContent).toContain("Enter an email");
    expect(mocks.access.change).not.toHaveBeenCalled();
    setValue(email, "Efua@Acme.example");
    click(button("Add person", form)!);
    await flush();
    expect(mocks.access.change).toHaveBeenCalledWith(COMPANY, SITE,
      { kind: "member_add", customerId: CUSTOMER, name: "Efua", email: "efua@acme.example", role: "member" }, expect.any(String));
  });

  it("shows the lists without change controls to anyone who is not a person with Publish rights", async () => {
    mocks.boardAccess.mockRejectedValue(new ApiError("Board access required", 403, { error: "Board access required" }));
    await render();
    expect(container.querySelectorAll('[data-testid="website-access-staff-row"]')).toHaveLength(2);
    expect(container.querySelector('select[aria-label^="Role for"]')).toBeNull();
    expect(container.querySelector('[data-testid="website-access-approver-add"]')).toBeNull();
    expect(button("Remove")).toBeUndefined();
    expect(container.textContent).toContain("An agent asks with a card");
  });

  it("says when no write key is set up", async () => {
    mocks.access.change.mockRejectedValue(new ApiError("Access changes are off", 409,
      { error: "Access changes are off", code: "capability_not_configured", details: { code: "capability_not_configured" } }));
    await render();
    click(button("Remove", container.querySelector('[data-testid="website-access-approvers"]')!)!);
    await flush();
    click(button("Remove approver")!);
    await flush();
    expect(mocks.access.change).toHaveBeenCalledWith(COMPANY, SITE, { kind: "approver_remove", staffId: OWNER }, expect.any(String));
    expect(container.textContent).toContain("No write key yet");
  });
});
