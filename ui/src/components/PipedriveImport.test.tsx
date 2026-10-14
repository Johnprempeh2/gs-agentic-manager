// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PipedriveImport, activePipedriveConnection } from "./PipedriveImport";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  listConnections: vi.fn(),
  importFromPipedrive: vi.fn(),
}));

vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: mocks.listConnections } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null, selectedCompanyId: "company-1" }) }));
vi.mock("@/api/organisations", () => ({ organisationsApi: { importFromPipedrive: mocks.importFromPipedrive } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const owner = {
  user: null, userId: "u1", isInstanceAdmin: false, companyIds: ["company-1"], source: "session", keyId: null,
  memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
};
const pipedrive = {
  id: "conn-1", name: "Pipedrive", status: "active", enabled: true,
  transportConfig: { sourceTemplateKey: "pipedrive" }, config: { sourceTemplateKey: "pipedrive" },
};

describe("PipedriveImport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.access.mockResolvedValue(owner);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <PipedriveImport companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  function button(label: string) {
    return [...document.body.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
  }

  async function openDialog() {
    await act(async () => { button("Import from Pipedrive")!.click(); });
    await flush();
  }

  it("is hidden from anyone who is not a company owner", async () => {
    mocks.access.mockResolvedValue({ ...owner, memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }] });
    await render();
    expect(button("Import from Pipedrive")).toBeUndefined();
  });

  it("points to the Pipedrive setup in Apps when there is no working connection", async () => {
    mocks.listConnections.mockResolvedValue({ connections: [{ ...pipedrive, status: "draft" }] });
    await render();
    await openDialog();
    expect(document.body.textContent).toContain("Settings > Personal preferences > API");
    const link = [...document.body.querySelectorAll("a")].find((element) => element.textContent === "Connect Pipedrive");
    expect(link?.getAttribute("href")).toBe("/apps/connect?source=pipedrive");
    expect(button("Start import")).toBeUndefined();
    expect(mocks.importFromPipedrive).not.toHaveBeenCalled();
  });

  it("runs the read-only import with the connection and shows the counts", async () => {
    mocks.listConnections.mockResolvedValue({ connections: [pipedrive] });
    mocks.importFromPipedrive.mockResolvedValue({
      source: "pipedrive",
      organisations: { created: 12, updated: 3, skipped: 0, errors: 1 },
      contacts: { created: 40, updated: 5, skipped: 2, errors: 0 },
      errorSamples: [{ kind: "organisation", externalId: "77", message: "Name is missing" }],
      startedAt: "2026-10-14T00:00:00Z",
      finishedAt: "2026-10-14T00:01:00Z",
    });
    await render();
    await openDialog();
    expect(document.body.textContent).toContain("Nothing is written to Pipedrive");
    await act(async () => { button("Start import")!.click(); });
    await flush();
    expect(mocks.importFromPipedrive).toHaveBeenCalledWith("company-1", "conn-1");
    expect(document.body.textContent).toContain("Organisations: 12 added, 3 updated, 0 skipped, 1 failed");
    expect(document.body.textContent).toContain("People: 40 added, 5 updated, 2 skipped, 0 failed");
    expect(document.body.textContent).toContain("Organisation 77: Name is missing");
  });

  it.each([
    "Pipedrive refused the credential. Reconnect Pipedrive in Connections.",
    "Pipedrive rate limit reached. Run the import again later; rows already imported are updated, not duplicated.",
    "A Pipedrive import is already running for this company",
  ])("shows the server's message when the import fails: %s", async (message) => {
    mocks.listConnections.mockResolvedValue({ connections: [pipedrive] });
    mocks.importFromPipedrive.mockRejectedValue(new Error(message));
    await render();
    await openDialog();
    await act(async () => { button("Start import")!.click(); });
    await flush();
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe(message);
    expect(button("Import again")).toBeDefined();
  });

  it("only treats an active, enabled Apps connection as usable", () => {
    expect(activePipedriveConnection([{ ...pipedrive, enabled: false }] as never)).toBeNull();
    expect(activePipedriveConnection([{ ...pipedrive, config: undefined, transportConfig: { sourceTemplateKey: "gmail" } }] as never)).toBeNull();
    expect(activePipedriveConnection([pipedrive] as never)?.id).toBe("conn-1");
  });
});
