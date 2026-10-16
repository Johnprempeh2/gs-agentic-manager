// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseOrganisationLink, CaseOrganisationMissing } from "./CaseOrganisationLink";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockPipelinesApi = vi.hoisted(() => ({ setCaseOrganisation: vi.fn() }));
vi.mock("@/api/organisations", () => ({ organisationsApi: mockApi }));
vi.mock("@/api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));
vi.mock("@/components/OrganisationPicker", () => ({
  OrganisationPicker: ({ onChange, error }: { onChange: (id: string) => void; error?: string | null }) => (
    <div>
      <button type="button" onClick={() => onChange("org-2")}>Pick Beta</button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  ),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CaseOrganisationLink", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockApi.get.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function render(node = <CaseOrganisationLink companyId="company-1" organisationId="org-1" />) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("links a pipeline item to its organisation's company page", async () => {
    mockApi.get.mockResolvedValue({ id: "org-1", name: "Acme Mining" });
    await render();
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/organisations/org-1");
    expect(link.textContent).toBe("Acme Mining");
    expect(mockApi.get).toHaveBeenCalledWith("company-1", "org-1");
  });

  it("still links to the page when the name cannot be loaded", async () => {
    mockApi.get.mockRejectedValue(new Error("Organisation not found"));
    await render();
    expect(container.querySelector("a")?.textContent).toBe("Open company page");
  });

  it("lets a card with no organisation pick one, and saves it on the card (GRE-1538)", async () => {
    mockPipelinesApi.setCaseOrganisation.mockResolvedValue({ id: "case-1", organisationId: "org-2" });
    await render(<CaseOrganisationMissing companyId="company-1" caseId="case-1" />);
    expect(container.textContent).toContain("Every card needs one");

    await act(async () => {
      container.querySelector("button")!.click();
    });
    await flush();

    expect(mockPipelinesApi.setCaseOrganisation).toHaveBeenCalledWith("case-1", "org-2");
  });

  it("shows the server's refusal", async () => {
    mockPipelinesApi.setCaseOrganisation.mockRejectedValue(new Error("This organisation is archived"));
    await render(<CaseOrganisationMissing companyId="company-1" caseId="case-1" />);

    await act(async () => {
      container.querySelector("button")!.click();
    });
    await flush();

    expect(container.querySelector("[role=alert]")?.textContent).toBe("This organisation is archived");
  });
});
