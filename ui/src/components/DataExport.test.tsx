// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataExportPanel, loadSheet } from "./DataExport";

const mocks = vi.hoisted(() => ({
  listOrganisations: vi.fn(),
  listAllIssues: vi.fn(),
  listAgents: vi.fn(),
  listProjects: vi.fn(),
  listUserDirectory: vi.fn(),
  weeklyReport: vi.fn(),
  downloadTextFile: vi.fn(),
  downloadBytes: vi.fn(),
}));

vi.mock("@/api/organisations", () => ({ organisationsApi: { list: mocks.listOrganisations } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listAll: mocks.listAllIssues } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: mocks.listProjects } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: mocks.listUserDirectory } }));
vi.mock("@/api/weeklyReport", () => ({ weeklyReportApi: { get: mocks.weeklyReport } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "GRE" } }) }));
vi.mock("@/lib/issues-csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issues-csv")>()),
  downloadTextFile: mocks.downloadTextFile,
}));
vi.mock("@/lib/spreadsheet-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spreadsheet-export")>()),
  downloadBytes: mocks.downloadBytes,
  localToday: () => "2026-10-16",
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUE = {
  id: "i1",
  identifier: "GRE-7",
  title: "Send the proposal",
  status: "in_progress",
  priority: "high",
  assigneeAgentId: "a1",
  assigneeUserId: null,
  projectId: "p1",
  dueDate: "2026-10-20",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  completedAt: null,
};

describe("DataExport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listAgents.mockResolvedValue([{ id: "a1", name: "Everest" }]);
    mocks.listProjects.mockResolvedValue([{ id: "p1", name: "Kente rollout" }]);
    mocks.listUserDirectory.mockResolvedValue({ users: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("builds the tasks sheet with agent and project names and a link", async () => {
    mocks.listAllIssues.mockResolvedValue([ISSUE]);
    const sheet = await loadSheet("company-1", "tasks", "GRE");
    expect(sheet.rows[0]).toEqual([
      "GRE-7",
      "Send the proposal",
      "In progress",
      "High",
      "Everest",
      "Kente rollout",
      "2026-10-20",
      "2026-10-01",
      "2026-10-02",
      "",
      `${window.location.origin}/GRE/issues/GRE-7`,
    ]);
  });

  it("downloads clients as CSV and everything as one Excel file, and shows a failure", async () => {
    mocks.listOrganisations.mockResolvedValue([]);
    mocks.listAllIssues.mockResolvedValue([ISSUE]);
    mocks.weeklyReport.mockResolvedValue({
      since: "2026-10-09T00:00:00.000Z",
      generatedAt: "2026-10-16T00:00:00.000Z",
      finished: { count: 1, agents: [] },
      stuck: { count: 0, items: [] },
      pipeline: { added: 0, moved: 0, won: 0, lost: 0, moves: [] },
      needsYou: { count: 0, items: [] },
      costs: { totalCents: 0, agents: [] },
    });
    await act(async () => root.render(<DataExportPanel companyId="company-1" />));

    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.getAttribute("aria-label") === label || item.textContent === label,
      )!;
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };

    await click("Download clients as CSV");
    expect(mocks.downloadTextFile).toHaveBeenCalledWith("gre-clients-2026-10-16.csv", expect.stringContaining("Name,Stage"));

    await click("Excel workbook");
    expect(mocks.downloadBytes).toHaveBeenCalledWith("gre-export-2026-10-16.xlsx", expect.any(Uint8Array));

    mocks.weeklyReport.mockRejectedValue(new Error("Board access required"));
    await click("Download this week numbers as Excel");
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Could not build the download. Board access required");
  });
});
