// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { OrganisationDetail, OrganisationHistory } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/api/organisations", () => ({ organisationsApi: mockApi }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/hooks/useIsPhone", () => ({ useIsPhone: () => false }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function detail(overrides: Partial<OrganisationDetail> = {}): OrganisationDetail {
  return {
    id: "org-1",
    companyId: "company-1",
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

describe("Organisation company page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mockApi)) fn.mockReset();
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
          <MemoryRouter initialEntries={["/organisations/org-1"]}>
            <Routes>
              <Route path="/organisations/:organisationId" element={<OrganisationPage />} />
            </Routes>
          </MemoryRouter>
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
    expect(engagement.querySelector("[data-testid='organisation-case-agreements']")?.textContent).toBe(
      "NDA: accepted · Engagement pack: sent",
    );
    expect(engagement.textContent).toContain("Proposal → Won by Sales Agent");
    expect(engagement.querySelector('a[href="/projects/proj-1"]')?.textContent).toBe("Acme onboarding");
    expect(engagement.querySelector('a[href="/issues/GRE-9"]')?.textContent).toBe("GRE-9 Send the proposal");
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
      ],
    }));
    await render();
    const section = container.querySelector('section[aria-label="Activities and notes"]')!;
    const rows = section.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("DevTools demo");
    expect(rows[0]!.textContent).toContain("Done");
    expect(rows[0]!.textContent).toContain("45 min");
    expect(rows[0]!.textContent).toContain("with Kofi Mensah");
    expect(rows[1]!.textContent).toContain("Note");
    expect(rows[1]!.textContent).toContain("Acme DevTools");
    expect(rows[1]!.textContent).toContain("Wants a trial licence.");
  });

  it("shows empty states when there are no contacts and no history", async () => {
    mockApi.get.mockResolvedValue(detail({ contacts: [] }));
    mockApi.history.mockResolvedValue(history({ lastContactAt: null, cases: [] }));
    await render();
    expect(container.textContent).toContain("No contacts yet. Use Edit to add one.");
    expect(container.textContent).toContain("No pipeline items for this organisation yet.");
    expect(container.textContent).toContain("Last contactNo contact yet");
    expect(container.querySelector('section[aria-label="Activities and notes"]')).toBeNull();
  });

  it("shows an error for the history without hiding the rest of the page", async () => {
    mockApi.get.mockResolvedValue(detail());
    mockApi.history.mockRejectedValue(new Error("Server unavailable"));
    await render();
    expect(container.textContent).toContain("Acme Mining");
    expect(container.textContent).toContain("Could not load the history. Server unavailable");
  });
});
