// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrganisationListItem } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PipelineOrganisationsView } from "./PipelineOrganisationsView";

const state = vi.hoisted(() => ({ isPhone: false }));
const mockApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/organisations", () => ({ organisationsApi: mockApi }));
vi.mock("@/hooks/useIsPhone", () => ({ useIsPhone: () => state.isPhone }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function organisation(overrides: Partial<OrganisationListItem>): OrganisationListItem {
  return {
    id: "org-1",
    companyId: "company-1",
    name: "Acme Mining",
    website: null,
    industry: "Mining",
    country: "Ghana",
    countryOwner: null,
    status: "prospect",
    notes: null,
    source: "manual",
    externalId: null,
    archivedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    keyContacts: [{ id: "c1", name: "Kofi Mensah", role: "CEO", email: null, phone: null }],
    contactCount: 1,
    pipelines: [
      { caseId: "case-1", caseKey: "s-1", pipelineId: "pipe-sales", pipelineName: "Sales", stageId: "stage-proposal", stageName: "Proposal", stageKind: "working", terminalKind: null },
      { caseId: "case-2", caseKey: "d-1", pipelineId: "pipe-delivery", pipelineName: "Delivery", stageId: "stage-won", stageName: "Won", stageKind: "done", terminalKind: "done" },
    ],
    ...overrides,
  };
}

describe("PipelineOrganisationsView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.isPhone = false;
    mockApi.list.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/pipelines/pipe-sales?view=organisations"]}>
            <Routes>
              <Route path="/pipelines/:pipelineId" element={<PipelineOrganisationsView companyId="company-1" pipelineId="pipe-sales" />} />
              <Route path="/organisations/:organisationId" element={<p>Organisation page</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  it("lists the pipeline's organisations with their stage in this pipeline only", async () => {
    mockApi.list.mockResolvedValue([
      organisation({}),
      organisation({
        id: "org-2",
        name: "Blue Bank",
        status: "client",
        keyContacts: [],
        pipelines: [
          { caseId: "case-3", caseKey: "s-2", pipelineId: "pipe-sales", pipelineName: "Sales", stageId: "stage-lead", stageName: "Lead", stageKind: "working", terminalKind: null },
        ],
      }),
    ]);
    await render();

    expect(mockApi.list).toHaveBeenCalledWith("company-1", { pipelineId: "pipe-sales" });
    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["Acme Mining", "Proposal", "Prospect", "Ghana", "Kofi Mensah"],
      ["Blue Bank", "Lead", "Client", "Ghana", "No key contact"],
    ]);
  });

  it("opens the organisation page when a name is clicked", async () => {
    mockApi.list.mockResolvedValue([organisation({})]);
    await render();

    const link = container.querySelector<HTMLAnchorElement>("tbody tr a")!;
    expect(link.getAttribute("href")).toBe("/organisations/org-1");
    await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));
    expect(container.textContent).toBe("Organisation page");
  });

  it("shows one card per organisation on a phone", async () => {
    state.isPhone = true;
    mockApi.list.mockResolvedValue([organisation({})]);
    await render();
    expect(container.querySelector("table")).toBeNull();
    const card = container.querySelector('ul[aria-label="Organisations in this pipeline"] li a')!;
    expect(card.getAttribute("href")).toBe("/organisations/org-1");
    expect(card.textContent).toContain("Proposal");
    expect(card.textContent).not.toContain("Delivery");
  });

  it("shows the empty state and the load error", async () => {
    mockApi.list.mockResolvedValueOnce([]);
    await render();
    expect(container.textContent).toContain("No organisations in this pipeline yet.");

    act(() => root.unmount());
    root = createRoot(container);
    mockApi.list.mockRejectedValueOnce(new Error("Feature not enabled"));
    await render();
    expect(container.textContent).toContain("Could not load organisations. Feature not enabled");
  });
});
