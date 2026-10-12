// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

const SELECTED_COMPANY = {
  id: "company-1",
  name: "Acme Robotics",
  description: null,
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// The settings tab bar asks the sidebar whether it is on a phone.
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// Both panels below the name field own their own queries and are not part of
// what this test covers.
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FOCUS_RING = "focus-visible:ring-field-halo";

// jsdom has no Tab key, so walk the page's tab order by hand.
function tabbableIn(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
}

describe("CompanySettings keyboard focus (GRE-906)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("draws the shared focus ring on every text field a person tabs to", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: null });
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    const fields = tabbableIn(container).filter((element) => element instanceof HTMLInputElement);
    expect(fields.length).toBeGreaterThanOrEqual(4);

    const nameField = fields.find((field) => field.value === "Acme Robotics");
    expect(nameField).toBeDefined();
    nameField!.focus();
    expect(document.activeElement).toBe(nameField);
    expect(nameField!.dataset.slot).toBe("input");

    for (const field of fields) {
      expect(field.className).toContain(FOCUS_RING);
    }

    flushSync(() => root.unmount());
  });
});
