// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Integrations, connectionState, describeImport, mailboxState } from "./Integrations";

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listMailboxes: vi.fn(),
  listActivity: vi.fn(),
}));

vi.mock("@/api/tools", () => ({ toolsApi: { listConnections: mocks.listConnections } }));
vi.mock("@/api/activity", () => ({ activityApi: { list: mocks.listActivity } }));
vi.mock("@/api/mailboxes", () => ({ mailboxesApi: { list: mocks.listMailboxes } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (slug: string, values: Record<string, unknown> = {}) => ({
  id: `conn-${slug}`,
  name: slug,
  status: "active",
  enabled: true,
  healthStatus: "ok",
  config: { sourceTemplateKey: slug },
  transportConfig: { sourceTemplateKey: slug },
  ...values,
});

describe("Integrations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listConnections.mockReset();
    mocks.listMailboxes.mockReset();
    mocks.listActivity.mockReset();
    mocks.listActivity.mockResolvedValue([]);
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
          <MemoryRouter>
            <Integrations />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  function card(slug: string) {
    return container.querySelector(`[data-testid=integration-${slug}]`) as HTMLElement;
  }

  it("shows each integration's status and the right button", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [
        connection("pipedrive"),
        connection("notion", { status: "draft" }),
        connection("slack", { enabled: false }),
      ],
    });
    mocks.listMailboxes.mockResolvedValue([{ id: "m1", address: "ben@example.test", healthStatus: "ok" }]);
    mocks.listActivity.mockResolvedValue([
      {
        id: "a1",
        action: "organisation.import_completed",
        createdAt: new Date().toISOString(),
        details: { source: "pipedrive", organisations: { created: 3, updated: 0, errors: 0 }, contacts: { created: 1, updated: 0, errors: 0 } },
      },
    ]);
    await render();
    expect(mocks.listActivity).toHaveBeenCalledWith("company-1", { action: ["organisation.import_completed"], limit: 20 });
    expect(card("pipedrive").textContent).toContain("3 organisations and 1 person added");
    expect(card("hubspot").textContent).toContain("Not connected");
    expect(card("hubspot").querySelector("a[href='/organisations']")?.textContent).toBe("Upload export");

    expect(card("pipedrive").textContent).toContain("Connected");
    expect(card("pipedrive").querySelector("a[href='/apps/conn-pipedrive']")?.textContent).toBe("Manage");
    expect(card("pipedrive").textContent).toContain("No API key? Upload a Pipedrive export");

    expect(card("notion").textContent).toContain("Setup not finished");
    expect(card("notion").querySelector("a[href*='resume=conn-notion']")?.textContent).toBe("Finish setup");

    expect(card("slack").textContent).toContain("Turned off");

    expect(card("google-calendar").textContent).toContain("Not connected");
    expect(card("google-calendar").textContent).toContain("preview programme");
    expect(card("google-calendar").querySelector("a[href='/apps/connect?source=google-calendar']")?.textContent).toBe("Connect");

    expect(card("mailboxes").textContent).toContain("1 inbox: ben@example.test");
    expect(card("mailboxes").querySelector("a[href='/apps/mailboxes']")?.textContent).toBe("Manage");
  });

  it("shows a HubSpot file import as imported, with what came in", async () => {
    mocks.listConnections.mockResolvedValue({ connections: [] });
    mocks.listMailboxes.mockResolvedValue([]);
    mocks.listActivity.mockResolvedValue([
      { id: "a2", action: "organisation.import_completed", createdAt: new Date().toISOString(), details: { source: "hubspot", deals: { created: 2 } } },
    ]);
    await render();
    expect(card("hubspot").textContent).toContain("Imported from a file");
    expect(card("hubspot").textContent).toContain("2 deals added");
  });

  it("shows a connection's problem in words", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [connection("slack", { healthStatus: "failed", healthMessage: "Slack refused the token." })],
    });
    mocks.listMailboxes.mockResolvedValue([]);
    await render();
    expect(card("slack").textContent).toContain("Needs attention");
    expect(card("slack").textContent).toContain("Problem: Slack refused the token.");
  });

  it("describes an import in one sentence", () => {
    const event = {
      createdAt: new Date(),
      details: {
        organisations: { created: 2, updated: 1, errors: 0 },
        contacts: { created: 0, updated: 4, errors: 1 },
        deals: { created: 1, updated: 0, errors: 0 },
        activities: { created: 0, updated: 0, errors: 0 },
      },
    };
    expect(describeImport(event, "5 minutes ago")).toBe(
      "Last import 5 minutes ago: 2 organisations and 1 deal added; 1 organisation and 4 people updated. 1 row could not be imported.",
    );
    expect(describeImport({ createdAt: new Date(), details: {} }, "today")).toBe("Last import today: nothing new.");
  });

  it("works out states from connection and mailbox health", () => {
    expect(connectionState(null)).toBe("not_connected");
    expect(connectionState(connection("x", { healthStatus: "failed" }) as never)).toBe("attention");
    expect(mailboxState([])).toBe("not_connected");
    expect(mailboxState([{ healthStatus: "error" }] as never)).toBe("attention");
    expect(mailboxState([{ healthStatus: "error" }, { healthStatus: "ok" }] as never)).toBe("connected");
  });
});
