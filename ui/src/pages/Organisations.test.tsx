// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrganisationListItem } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Organisations } from "./Organisations";

const state = vi.hoisted(() => ({ isPhone: false }));
const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  archiveContact: vi.fn(),
}));

const accessMock = vi.hoisted(() => ({ listMembers: vi.fn() }));

vi.mock("@/api/organisations", () => ({ organisationsApi: mockApi }));
vi.mock("@/api/access", () => ({ accessApi: accessMock }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/hooks/useIsPhone", () => ({ useIsPhone: () => state.isPhone }));
// The Pipedrive import has its own tests (PipedriveImport.test.tsx).
vi.mock("@/components/PipedriveImport", () => ({ PipedriveImport: () => null }));
vi.mock("@/components/HubspotImport", () => ({ HubspotImport: () => null }));
vi.mock("@/components/NotionImport", () => ({ NotionImport: () => null }));
vi.mock("@/components/DataExport", () => ({ ClientsExportButton: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The contact form's Radix checkbox measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function organisation(overrides: Partial<OrganisationListItem>): OrganisationListItem {
  return {
    id: "org-1",
    companyId: "company-1",
    name: "Acme Mining",
    website: null,
    industry: "Mining",
    country: "Ghana",
    countryOwner: "Ama",
    status: "prospect",
    notes: null,
    source: "manual",
    externalId: null,
    archivedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    keyContacts: [{ id: "c1", name: "Kofi Mensah", role: "CEO", email: null, phone: null }],
    contactCount: 2,
    ...overrides,
  };
}

describe("Organisations page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.isPhone = false;
    for (const fn of Object.values(mockApi)) fn.mockReset();
    accessMock.listMembers.mockReset();
    accessMock.listMembers.mockResolvedValue({
      members: [
        { principalId: "user-ama", status: "active", user: { name: "Ama Owusu", email: "ama@example.com" } },
        { principalId: "user-gone", status: "suspended", user: { name: "Former Member", email: null } },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }
  }

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Organisations />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  }

  it("lists organisations with industry, country, owner, status and key contacts", async () => {
    mockApi.list.mockResolvedValue([
      organisation({}),
      organisation({ id: "org-2", name: "Blue Bank", status: "client", industry: null, keyContacts: [] }),
    ]);
    await render();

    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["Acme Mining", "Mining", "Ghana", "Ama", "Prospect", "Kofi Mensah (CEO)", "Edit"],
      ["Blue Bank", "Not set", "Ghana", "Ama", "Client", "No key contact", "Edit"],
    ]);
    // Each name opens the company page (GRE-1480).
    expect(container.querySelector("tbody tr a")?.getAttribute("href")).toBe("/organisations/org-1");
  });

  it("sends the search and status filter to the server", async () => {
    mockApi.list.mockResolvedValue([]);
    await render();
    expect(mockApi.list).toHaveBeenLastCalledWith("company-1", { q: "", status: "" });

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search organisations"]')!;
    const status = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    await act(async () => setValue(search, "kofi"));
    await act(async () => setValue(status, "client"));
    await settle();

    expect(mockApi.list).toHaveBeenLastCalledWith("company-1", { q: "kofi", status: "client" });
    expect(container.textContent).toContain("No organisations match this search.");
  });

  it("shows the empty state and the load error", async () => {
    mockApi.list.mockResolvedValueOnce([]);
    await render();
    expect(container.textContent).toContain("No organisations yet.");

    act(() => root.unmount());
    root = createRoot(container);
    mockApi.list.mockRejectedValueOnce(new Error("Feature not enabled"));
    await render();
    expect(container.textContent).toContain("Could not load organisations. Feature not enabled");
  });

  it("shows one card per organisation on a phone", async () => {
    state.isPhone = true;
    mockApi.list.mockResolvedValue([organisation({})]);
    await render();
    expect(container.querySelector("table")).toBeNull();
    const card = container.querySelector('ul[aria-label="Organisations"] li')!;
    expect(card.textContent).toContain("Acme Mining");
    expect(card.textContent).toContain("Mining · Ghana · Ama");
    expect(card.textContent).toContain("Kofi Mensah (CEO)");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/organisations/org-1");
  });

  it("creates an organisation from the dialog", async () => {
    mockApi.list.mockResolvedValue([]);
    mockApi.create.mockResolvedValue(organisation({}));
    await render();

    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add organisation")!;
    await act(async () => add.click());
    await settle();
    const name = document.querySelector<HTMLInputElement>("#organisation-name")!;
    const country = document.querySelector<HTMLInputElement>("#organisation-country")!;
    await act(async () => setValue(name, "Acme Mining"));
    await act(async () => setValue(country, "Ghana"));
    const submit = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (button) => button.textContent === "Add organisation",
    )!;
    await act(async () => submit.click());
    await settle();

    expect(mockApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "Acme Mining",
      country: "Ghana",
      status: "target",
    }));
  });

  it("shows the server's refusal when saving an edit fails", async () => {
    mockApi.list.mockResolvedValue([organisation({})]);
    mockApi.get.mockResolvedValue({ ...organisation({}), contacts: [] });
    mockApi.update.mockRejectedValue(new Error("You may view organisations but not change them"));
    await render();

    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Acme Mining"]')!;
    await act(async () => open.click());
    await settle();
    const save = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => save.click());
    await settle();

    expect(mockApi.update).toHaveBeenCalledWith("company-1", "org-1", expect.objectContaining({ name: "Acme Mining" }));
    expect(document.body.textContent).toContain("You may view organisations but not change them");
  });

  it("picks the country owner from the team, or takes a typed name", async () => {
    mockApi.list.mockResolvedValue([]);
    mockApi.create.mockResolvedValue(organisation({}));
    await render();

    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add organisation")!;
    await act(async () => add.click());
    await settle();
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#organisation-name")!, "Acme Mining"));
    const owner = document.querySelector<HTMLSelectElement>("#organisation-countryOwnerUserId")!;
    const options = [...owner.options].map((option) => option.textContent);
    expect(options).toEqual(["Nobody yet", "Ama Owusu", "Someone else (type a name)"]);

    await act(async () => setValue(owner, "user-ama"));
    const submit = () => [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (button) => button.textContent === "Add organisation",
    )!;
    await act(async () => submit().click());
    await settle();
    expect(mockApi.create).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      countryOwnerUserId: "user-ama",
      countryOwner: "Ama Owusu",
    }));

    // Saving closes the dialog; a second organisation takes a typed owner.
    await act(async () => add.click());
    await settle();
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#organisation-name")!, "Blue Bank"));
    await act(async () => setValue(document.querySelector<HTMLSelectElement>("#organisation-countryOwnerUserId")!, "__other"));
    await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Country owner name"]')!, "Kwame"));
    await act(async () => submit().click());
    await settle();
    expect(mockApi.create).toHaveBeenLastCalledWith("company-1", expect.objectContaining({
      countryOwnerUserId: null,
      countryOwner: "Kwame",
    }));
  });
});
