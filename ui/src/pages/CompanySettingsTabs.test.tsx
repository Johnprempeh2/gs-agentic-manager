// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";

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

const sidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("../api/companies", () => ({ companiesApi: { update: vi.fn(), archive: vi.fn() } }));
vi.mock("../api/assets", () => ({ assetsApi: { uploadCompanyLogo: vi.fn() } }));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => sidebarState }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: vi.fn(),
  }),
}));

// Stand-ins that say which sections each tab asked for.
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => <div data-testid="governance">Interaction governance</div>,
  applyGovernanceChange: (governance: unknown) => governance,
}));
vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: ({ sections }: { sections?: string[] }) => (
    <div data-testid="instance-sections">{sections?.join(",") ?? "all"}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let observedSearch = "";

function LocationProbe() {
  observedSearch = useLocation().search;
  return null;
}

describe("CompanySettings tabs", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    sidebarState.isMobile = false;
    observedSearch = "";
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(path = "/ACM/company/settings", hiddenSettings: string[] = []) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: null, hiddenSettings });
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter initialEntries={[path]}>
              <LocationProbe />
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  const tabNames = () =>
    Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent);
  const sections = () =>
    Array.from(container.querySelectorAll('[data-testid="instance-sections"]')).map((el) => el.textContent);

  function chooseTab(name: string) {
    const tab = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find((element) => element.textContent === name);
    expect(tab).toBeDefined();
    // Radix tabs activate on a primary-button mousedown.
    flushSync(() => tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  }

  it("opens on General with the organisation, hiring, sign-out and archive controls only", () => {
    render();

    expect(tabNames()).toEqual(["General", "Agents and runs", "Security", "Backups and data"]);
    expect(container.textContent).toContain("Organization name");
    expect(container.textContent).toContain("Require board approval for new hires");
    expect(container.textContent).toContain("Archive organization");
    expect(sections()).toEqual(["aiAccessRoute,signOut"]);
    expect(container.querySelector('[data-testid="governance"]')).toBeNull();
  });

  it("opens the tab named in the URL", () => {
    render("/ACM/company/settings?tab=agents");

    expect(sections()).toEqual(["runAdmission"]);
    expect(container.querySelector('[data-testid="governance"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Organization name");
  });

  it("remembers the chosen tab in the URL, and General clears it", async () => {
    render();

    chooseTab("Security");
    await vi.waitFor(() => expect(observedSearch).toBe("?tab=security"));
    // Radix keeps the old panel mounted for a tick while it leaves.
    await vi.waitFor(() => expect(sections()).toEqual(["deploymentStatus,censorUsernameInLogs"]));

    chooseTab("Backups and data");
    await vi.waitFor(() => expect(observedSearch).toBe("?tab=backups"));
    await vi.waitFor(() => expect(sections()).toEqual(["backupRetention,feedbackDataSharingPreference"]));

    chooseTab("General");
    await vi.waitFor(() => expect(observedSearch).toBe(""));
    expect(container.textContent).toContain("Organization name");
  });

  it("drops a tab the operator has emptied and falls back to General", () => {
    render("/ACM/company/settings?tab=security", [
      "instance.general.deploymentStatus",
      "instance.general.censorUsernameInLogs",
    ]);

    expect(tabNames()).toEqual(["General", "Agents and runs", "Backups and data"]);
    expect(container.textContent).toContain("Organization name");
  });

  it("falls back to General for an unknown tab", () => {
    render("/ACM/company/settings?tab=nonsense");
    expect(container.textContent).toContain("Organization name");
  });

  it("shows a named select on a phone", () => {
    sidebarState.isMobile = true;
    render("/ACM/company/settings?tab=backups");

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Settings section"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("backups");
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual([
      "General",
      "Agents and runs",
      "Security",
      "Backups and data",
    ]);
  });
});
