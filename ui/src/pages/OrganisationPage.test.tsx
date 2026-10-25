// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { OrganisationDetail, OrganisationHistory } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/context/ToastContext";
import { emptyOrganisationCrmFields } from "@/fixtures/organisationCrmFields";
import { OrganisationPage } from "./OrganisationPage";

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  history: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  archiveContact: vi.fn(),
}));

const mockPeople = vi.hoisted(() => ({
  users: [{ principalId: "user-1", status: "active", user: { name: "Ama Owusu", email: "ama@example.test" } }] as unknown[],
  agents: [{ id: "agent-1", name: "Sales Agent", status: "idle" }] as unknown[],
}));
vi.mock("@/api/organisations", () => ({ organisationsApi: mockApi }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: () => Promise.resolve({ users: mockPeople.users }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: () => Promise.resolve(mockPeople.agents) } }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
  useOptionalCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/hooks/useIsPhone", () => ({ useIsPhone: () => false }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

const mockPipelines = vi.hoisted(() => ({
  get: vi.fn(),
  getCase: vi.fn(),
  getCaseJourney: vi.fn(),
  getCaseFiles: vi.fn(),
  getCaseEvents: vi.fn(),
  listCaseEvidenceCandidates: vi.fn(),
}));
const mockSites = vi.hoisted(() => ({ sites: vi.fn() }));
const mockBridge = vi.hoisted(() => ({ previewDeepDiveSync: vi.fn(), list: vi.fn() }));
vi.mock("@/api/pipelines", () => ({ pipelinesApi: mockPipelines }));
vi.mock("@/api/website", () => ({ websiteModuleApi: mockSites }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mockBridge }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: () => Promise.resolve({}) } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function detail(overrides: Partial<OrganisationDetail> = {}): OrganisationDetail {
  return {
    id: "org-1",
    companyId: "company-1",
    ...emptyOrganisationCrmFields,
    name: "Acme Mining",
    website: "acme.example",
    industry: "Mining",
    country: "Ghana",
    countryOwner: "Ama",
    status: "client",
    notes: null,
    source: "manual",
    externalId: null,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    contacts: [
      {
        id: "c1",
        companyId: "company-1",
        organisationId: "org-1",
        name: "Kofi Mensah",
        role: "CEO",
        email: "kofi@acme.example",
        phone: "+233 20 000 0000",
        isKeyContact: true,
        source: "manual",
        externalId: null,
        archivedAt: null,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

function history(overrides: Partial<OrganisationHistory> = {}): OrganisationHistory {
  return {
    organisationId: "org-1",
    lastContactAt: "2026-10-07T09:00:00Z",
    cases: [
      {
        id: "case-1",
        caseKey: "deal-1",
        title: "Acme drill rig",
        pipelineId: "pipe-1",
        pipelineName: "Sales",
        stageName: "Won",
        stageKind: "done",
        terminalKind: "done",
        ndaStatus: "accepted",
        engagementStatus: "sent",
        details: [
          { key: "dealValue", label: "Value", value: 45000 },
          { key: "dealOwner", label: "Owner", value: "Ama Owusu" },
        ],
        people: [{ name: "Esi Boateng", role: "Main contact" }, { name: "Tunde Bakare", role: null }],
        createdAt: "2026-09-30T09:00:00Z",
        updatedAt: "2026-10-05T09:00:00Z",
        stageChanges: [
          {
            id: "e1",
            at: "2026-10-05T09:00:00Z",
            fromStageName: "Proposal",
            toStageName: "Won",
            forced: false,
            actorType: "agent",
            actorAgentName: "Sales Agent",
          },
        ],
        projects: [{ id: "proj-1", name: "Acme onboarding", status: "in_progress" }],
        tasks: [{ id: "iss-1", identifier: "GRE-9", title: "Send the proposal", status: "done", updatedAt: "2026-10-03T09:00:00Z" }],
      },
    ],
    ...overrides,
  };
}

const STAGES = [
  { id: "s1", key: "executive-discovery", name: "Executive Discovery", kind: "open", position: 0 },
  { id: "s2", key: "deep-dive", name: "Deep Dive", kind: "working", position: 1 },
];

/** The item read as the server sends it: its pipeline carries no stages. */
function caseDetail(caseId: string, caseType: string) {
  return {
    case: { id: caseId, companyId: "company-1", pipelineId: "pipe-1", stageId: "s1", title: "Acme drill rig", fields: { owner: "Ama Owusu" }, organisationId: "org-1" },
    caseType,
    stageEnteredAt: "2026-10-05T09:00:00Z",
    stage: STAGES[0],
    pipeline: { id: "pipe-1", name: "Client journey" },
  };
}

describe("Organisation company page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mockApi)) fn.mockReset();
    for (const fn of [...Object.values(mockPipelines), ...Object.values(mockSites), ...Object.values(mockBridge)]) fn.mockReset();
    // A sales deal by default: no client journey, portal or website hub.
    mockPipelines.getCase.mockImplementation((caseId: string) => Promise.resolve(caseDetail(caseId, "sales")));
    mockPipelines.get.mockImplementation(() => Promise.resolve({ id: "pipe-1", name: "Client journey", stages: STAGES }));
    mockPipelines.getCaseEvents.mockResolvedValue({ items: [], pagination: { limit: 50, offset: 0, nextOffset: null } });
    mockPipelines.getCaseFiles.mockResolvedValue({ clients: [], evidence: [], deliverables: [] });
    mockPipelines.listCaseEvidenceCandidates.mockResolvedValue({ attachments: [], documents: [] });
    mockSites.sites.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(path = "/organisations/org-1") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
          <MemoryRouter key={path} initialEntries={[path]}>
            <Routes>
              <Route path="/organisations/:organisationId" element={<OrganisationPage />} />
            </Routes>
          </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("shows a loading state while the organisation loads", async () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    mockApi.history.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.textContent).toContain("Loading organisation…");
  });

  it("shows an error when the organisation cannot be loaded", async () => {
    mockApi.get.mockRejectedValue(new Error("Organisation not found"));
    mockApi.history.mockRejectedValue(new Error("Organisation not found"));
    await render();
    expect(container.textContent).toContain("Could not load this organisation. Organisation not found");
    expect(container.querySelector('a[href="/organisations"]')?.textContent).toBe("Back to Organisations");
  });

  it("shows company info, country owner, contacts and the engagement history", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockResolvedValue(history());
    await render();

    expect(mockApi.history).toHaveBeenCalledWith("company-1", "org-1");
    const info = container.querySelector('section[aria-label="Company info"]')!;
    expect(info.textContent).toContain("Country ownerAma");
    expect(info.textContent).toContain("CountryGhana");
    expect(info.textContent).toContain("Last contact7 Oct 2026");

    const contacts = container.querySelector('section[aria-label="Contacts"]')!;
    expect(contacts.textContent).toContain("Kofi Mensah");
    expect(contacts.querySelector('a[href="mailto:kofi@acme.example"]')).not.toBeNull();
    expect(contacts.querySelector('a[href="tel:+233 20 000 0000"]')).not.toBeNull();

    const engagement = container.querySelector('section[aria-label="Engagement history"]')!;
    expect(engagement.querySelector('a[href="/pipelines/pipe-1/items/case-1"]')?.textContent).toBe("Acme drill rig");
    expect(engagement.textContent).toContain("Sales · Stage: Won");
    expect(engagement.querySelector("[data-testid='organisation-case-people']")?.textContent).toBe(
      "People: Esi Boateng (Main contact), Tunde Bakare",
    );
    expect(engagement.querySelector("details summary")?.textContent).toBe("Details (2)");
    expect(engagement.textContent).toContain("Ama Owusu");
    expect(engagement.querySelector("[data-testid='organisation-case-agreements']")?.textContent).toBe(
      "NDA: accepted · Engagement pack: sent",
    );
    expect(engagement.textContent).toContain("Proposal → Won by Sales Agent");
    expect(engagement.querySelector('a[href="/projects/proj-1"]')?.textContent).toBe("Acme onboarding");
    expect(engagement.querySelector('a[href="/issues/GRE-9"]')?.textContent).toBe("GRE-9 Send the proposal");
  });

  it("shows the global CRM fields that are set and hides the rest (GRE-1539)", async () => {
    mockApi.get.mockImplementation((_companyId: string, id: string) =>
      Promise.resolve(id === "org-group" ? detail({ id: "org-group", name: "Acme Group" }) : detail({
        legalName: "Acme Mining Ltd",
        accountOwnerUserId: "user-1",
        parentOrganisationId: "org-group",
        segment: "Tier 1",
        ownershipType: "subsidiary",
        employeeCount: 1200,
        annualRevenue: 2500000,
        annualRevenueCurrency: "USD",
        domain: "acme.example",
        email: "info@acme.example",
        addressCity: "Accra",
        addressRegion: "Greater Accra",
        tags: ["gold", "bauxite"],
        description: "Gold producer.",
        taxId: "TAX-1",
      })),
    );
    mockApi.history.mockResolvedValue(history());
    await render();

    const crm = container.querySelector('[data-testid="organisation-crm-info"]')!;
    expect(crm.textContent).toContain("Account ownerAma Owusu");
    expect(crm.textContent).toContain("Legal nameAcme Mining Ltd");
    expect(crm.textContent).toContain("Segment or tierTier 1");
    expect(crm.textContent).toContain("OwnershipSubsidiary");
    expect(crm.textContent).toContain("Size1,200 employees");
    expect(crm.textContent).toMatch(/Annual revenue(US)?\$2,500,000/);
    expect(crm.textContent).toContain("AddressAccra, Greater Accra");
    expect(crm.textContent).toContain("Tax IDTAX-1");
    expect(crm.textContent).toContain("Gold producer.");
    expect(crm.querySelector('a[href="/organisations/org-group"]')?.textContent).toBe("Acme Group");
    expect(crm.querySelector('a[href="mailto:info@acme.example"]')).not.toBeNull();
    expect([...crm.querySelectorAll('[aria-label="Tags"] > *')].map((tag) => tag.textContent)).toEqual(["gold", "bauxite"]);
    expect(crm.textContent).not.toContain("Registration number");
  });

  it("shows no CRM block when none of the fields is set (GRE-1539)", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockResolvedValue(history());
    await render();
    expect(container.querySelector('[data-testid="organisation-crm-info"]')).toBeNull();
  });

  it("opens Ask Everest with the organisation, its people and its deals", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockResolvedValue(history());
    const opened: Array<{ question?: string; context?: { label: string; summary: string } }> = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("gsam:open-ask-everest", listener);
    await render();

    await act(async () => {
      (container.querySelector('[data-testid="organisation-ask"]') as HTMLButtonElement).click();
    });
    window.removeEventListener("gsam:open-ask-everest", listener);

    expect(opened).toHaveLength(1);
    expect(opened[0]?.context?.label).toBe(detail().name);
    expect(opened[0]?.context?.summary).toContain("Kofi Mensah");
    expect(opened[0]?.context?.summary).toContain("Acme drill rig: Won in Sales");
  });

  it("shows every field imported from Pipedrive under Pipedrive's names", async () => {
    const base = detail();
    mockApi.get.mockResolvedValue(detail({
      source: "pipedrive",
      crmFields: [
        { key: "label_ids", label: "Labels", value: ["DevTools", "Partner"] },
        { key: "employee_count", label: "Number of employees", value: 120 },
      ],
      contacts: [{ ...base.contacts[0]!, source: "pipedrive", crmFields: [{ key: "gh", label: "GitHub handle", value: "kofi-m" }] }],
    }));
    mockApi.history.mockResolvedValue(history());
    await render();

    const info = container.querySelector('section[aria-label="Company info"]')!;
    expect(info.textContent).toContain("From Pipedrive");
    expect(info.textContent).toContain("LabelsDevTools, Partner");
    expect(info.textContent).toContain("Number of employees120");
    const contacts = container.querySelector('section[aria-label="Contacts"]')!;
    expect(contacts.querySelector("summary")?.textContent).toBe("From Pipedrive (1)");
    expect(contacts.textContent).toContain("GitHub handlekofi-m");
  });

  it("lists imported activities, notes and calls", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockResolvedValue(history({
      timeline: [
        {
          id: "t1", source: "pipedrive", kind: "activity", activityType: "meeting", subject: "DevTools demo",
          body: "Showed the CLI.", occurredAt: "2026-10-01T10:00:00Z", durationMinutes: 45, done: true,
          ownerName: "Ama Owusu", contactId: "c1", contactName: "Kofi Mensah", caseId: null, caseTitle: null, details: {},
        },
        {
          id: "t2", source: "pipedrive", kind: "note", activityType: null, subject: null, body: "Wants a trial licence.",
          occurredAt: "2026-09-30T08:00:00Z", durationMinutes: null, done: null, ownerName: null,
          contactId: null, contactName: null, caseId: "case-1", caseTitle: "Acme DevTools", details: {},
        },
        {
          id: "t3", source: "pipedrive", kind: "email", activityType: "email", subject: "Re: pricing", body: "Sounds good.",
          occurredAt: "2026-09-29T08:00:00Z", durationMinutes: null, done: null, ownerName: null,
          contactId: null, contactName: null, caseId: null, caseTitle: null,
          details: { from: ["Kofi <kofi@acme.example>"], to: ["Ama <ama@greatstone.example>"] },
        },
        {
          id: "t4", source: "pipedrive", kind: "field_change", activityType: "value", subject: "Value: 10000 → 12000", body: null,
          occurredAt: "2026-09-28T08:00:00Z", durationMinutes: null, done: null, ownerName: "Ama Owusu",
          contactId: null, contactName: null, caseId: "case-1", caseTitle: "Acme DevTools", details: { field: "value" },
        },
      ],
    }));
    await render("/organisations/org-1?tab=activity");
    const section = container.querySelector('section[aria-label="Activities and notes"]')!;
    const rows = section.querySelectorAll("li");
    expect(rows).toHaveLength(4);
    expect(rows[3]!.textContent).toContain("Value: 10000 → 12000");
    expect(rows[3]!.textContent).toContain("Ama Owusu");
    expect(rows[0]!.textContent).toContain("DevTools demo");
    expect(rows[0]!.textContent).toContain("Done");
    expect(rows[0]!.textContent).toContain("45 min");
    expect(rows[0]!.textContent).toContain("with Kofi Mensah");
    expect(rows[1]!.textContent).toContain("Note");
    expect(rows[1]!.textContent).toContain("Acme DevTools");
    expect(rows[1]!.textContent).toContain("Wants a trial licence.");
    expect(rows[2]!.textContent).toContain("Re: pricing");
    expect(rows[2]!.textContent).toContain("from Kofi <kofi@acme.example>");
    expect(rows[2]!.textContent).toContain("to Ama <ama@greatstone.example>");
  });

  it("lists imported files, linking copies and Pipedrive links", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockResolvedValue(history({
      files: [
        {
          id: "f1", source: "pipedrive", name: "Order form.pdf", contentType: "application/pdf", byteSize: 2048,
          description: "Signed copy", ownerName: "Ama Owusu", addedAt: "2026-09-25T09:00:00Z",
          contentPath: "/api/companies/company-1/crm-files/f1/content", remoteUrl: null, notCopied: null,
          contactName: "Kofi Mensah", caseId: "case-1", caseTitle: "Acme DevTools",
        },
        {
          id: "f2", source: "pipedrive", name: "Proposal deck", contentType: null, byteSize: null, description: null,
          ownerName: null, addedAt: null, contentPath: null, remoteUrl: "https://docs.google.com/presentation/d/1AbC",
          notCopied: "Linked from googledrive", contactName: null, caseId: null, caseTitle: null,
        },
      ],
    }));
    await render("/organisations/org-1?tab=documents");
    const section = container.querySelector('section[aria-label="Files"]')!;
    const rows = section.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe("/api/companies/company-1/crm-files/f1/content");
    expect(rows[0]!.textContent).toContain("2 KB");
    expect(rows[0]!.textContent).toContain("on Kofi Mensah");
    expect(rows[0]!.textContent).toContain("Acme DevTools");
    expect(rows[0]!.textContent).toContain("Signed copy");
    expect(rows[1]!.querySelector("a")?.getAttribute("href")).toBe("https://docs.google.com/presentation/d/1AbC");
    expect(rows[1]!.textContent).toContain("Not copied into GSAM: Linked from googledrive");
  });

  it("shows empty states when there are no contacts and no history", async () => {
    mockApi.get.mockResolvedValue(detail({ contacts: [] }));
    mockApi.history.mockResolvedValue(history({ lastContactAt: null, cases: [] }));
    await render();
    expect(container.textContent).toContain("No contacts yet. Use Edit to add one.");
    expect(container.textContent).toContain("No pipeline items for this organisation yet.");
    expect(container.textContent).toContain("Last contactNo contact yet");
    expect(container.querySelector('section[aria-label="Activities and notes"]')).toBeNull();
    expect(container.querySelector('section[aria-label="Files"]')).toBeNull();
  });

  it("shows an error for the history without hiding the rest of the page", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockRejectedValue(new Error("Server unavailable"));
    await render();
    expect(container.textContent).toContain("Acme Mining");
    expect(container.textContent).toContain("Could not load the history. Server unavailable");
  });

  describe("client hub (GRE-2614)", () => {
    it("shows every hub tab and keeps the chosen tab in the address", async () => {
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history());
      await render();
      const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
      expect(tabs).toEqual([
        "Overview", "Executive Discovery", "Interviews", "Deep Dive", "Documents",
        "Deliverables", "Commerce", "Billing", "Activity", "Client view",
      ]);
      expect(container.querySelector('[data-testid="organisation-tab-overview"]')).not.toBeNull();
      const engagement = container.querySelector('[data-testid="organisation-engagement"]')!;
      expect(engagement.textContent).toContain("Ama Owusu");
      expect(engagement.textContent).toContain("Executive Discovery");
      expect(mockPipelines.get).toHaveBeenCalledWith("pipe-1");
    });

    it("links the placeholder tabs to the tasks that build them", async () => {
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history());
      await render("/organisations/org-1?tab=interviews");
      expect(container.querySelector('a[href="/issues/GRE-2611"]')).not.toBeNull();
      await render("/organisations/org-1?tab=billing");
      expect(container.querySelector('a[href="/issues/GRE-2629"]')).not.toBeNull();
    });

    it("shows the open engagement when the organisation has several, and the one asked for", async () => {
      const base = history().cases[0]!;
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history({
        cases: [
          { ...base, id: "case-old", title: "Old deal", terminalKind: "done", createdAt: "2026-10-09T00:00:00Z" },
          { ...base, id: "case-open", title: "Acme engagement", terminalKind: null, createdAt: "2026-09-01T00:00:00Z" },
        ],
      }));
      await render();
      expect(mockPipelines.getCase).toHaveBeenCalledWith("case-open");
      expect((container.querySelector('select[aria-label="Engagement shown"]') as HTMLSelectElement).value).toBe("case-open");
      await render("/organisations/org-1?case=case-old");
      expect(mockPipelines.getCase).toHaveBeenCalledWith("case-old");
    });

    it("lists document requests as received, answered or missing, and marks those the client sees", async () => {
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history());
      mockPipelines.getCase.mockImplementation((caseId: string) => Promise.resolve(caseDetail(caseId, "client")));
      mockPipelines.getCaseJourney.mockResolvedValue({
        caseId: "case-1",
        stages: [{
          id: "s2", name: "Deep Dive", requests: [
            { id: "r1", stageId: "s2", title: "Org chart", note: null, createdAt: "2026-10-01T00:00:00Z",
              received: { evidenceId: "e1", title: "Org chart.pdf", contentPath: "/api/files/e1", receivedAt: "2026-10-04T00:00:00Z" } },
            { id: "r2", stageId: "s2", title: "Price list", note: null, createdAt: "2026-10-02T00:00:00Z", received: null },
            { id: "r3", stageId: "s2", title: "Board minutes", note: null, createdAt: "2026-10-03T00:00:00Z", received: null,
              websiteAnswer: { answeredAt: "2026-10-06T00:00:00Z", answeredBy: { customerId: "cu1", name: "Kofi Mensah", email: null }, note: null, fileName: "minutes.pdf" } },
          ],
        }],
      });
      mockSites.sites.mockResolvedValue([{ id: "site-1" }]);
      mockBridge.previewDeepDiveSync.mockResolvedValue({
        items: [], files: [], deliverables: [],
        documentRequests: [{ id: "r2", title: "Price list", note: null, itemIds: ["i1"], status: "open", receivedAt: null, createdAt: "2026-10-02T00:00:00Z" }],
      });
      await render("/organisations/org-1?tab=documents");

      expect(mockBridge.previewDeepDiveSync).toHaveBeenCalledWith("company-1", "site-1", "case-1");
      const section = container.querySelector('section[aria-label="Document requests"]')!;
      expect(section.querySelector("h2")?.textContent).toBe("Requested (1 missing)");
      const rows = [...section.querySelectorAll("li")];
      expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Price list", "Board minutes", "Org chart"]);
      expect(rows[0]!.textContent).toContain("Missing");
      expect(rows[0]!.querySelector('[data-testid="shared-with-client"]')).not.toBeNull();
      expect(rows[1]!.textContent).toContain("Answered on the website");
      expect(rows[1]!.textContent).toContain("by Kofi Mensah");
      expect(rows[1]!.querySelector('[data-testid="shared-with-client"]')).toBeNull();
      expect(rows[2]!.textContent).toContain("Deep Dive · asked 1 Oct 2026 · received 4 Oct 2026");
      expect(rows[2]!.querySelector('a[href="/api/files/e1"]')).not.toBeNull();
    });

    it("waits for the engagement before a tab says there is none", async () => {
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history());
      mockPipelines.getCase.mockReturnValue(new Promise(() => {}));
      await render("/organisations/org-1?tab=documents");
      expect(container.textContent).toContain("Loading the engagement…");
      expect(container.textContent).not.toContain("no client engagement yet");
    });

    it("asks for no client journey data when the engagement is a sales deal", async () => {
      mockApi.get.mockResolvedValue(detail());
      mockApi.history.mockResolvedValue(history());
      await render("/organisations/org-1?tab=deliverables");
      expect(container.textContent).toContain("This organisation has no client engagement yet.");
      expect(mockBridge.previewDeepDiveSync).not.toHaveBeenCalled();
    });
  });
});
