// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmSyncCaseSource } from "@greatstone/shared";
import { crmSyncNotice, PipelineCaseCrmSync } from "./PipelineCaseCrmSync";

const mockPipelinesApi = vi.hoisted(() => ({ getCaseCrmSyncStatus: vi.fn() }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));

function source(overrides: Partial<CrmSyncCaseSource> = {}): CrmSyncCaseSource {
  return {
    bindingId: "binding-1",
    connectionId: "connection-1",
    providerKey: "pipedrive",
    externalContainerLabel: "Sales pipeline",
    externalId: "101",
    bindingStatus: "active",
    lastSyncedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastErrorMessage: null,
    nextSyncAt: null,
    rateLimitedUntil: null,
    lastEvent: null,
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("case CRM sync section", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <PipelineCaseCrmSync caseId="case-1" companyId={null} wrap={(children: ReactNode) => <section data-testid="crm">{children}</section>} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("shows nothing for a case with no CRM link", async () => {
    mockPipelinesApi.getCaseCrmSyncStatus.mockResolvedValue({ caseId: "case-1", sources: [] });
    await render();
    expect(container.querySelector("[data-testid=crm]")).toBeNull();
  });

  it("shows the source, the deal and when it last synced", async () => {
    mockPipelinesApi.getCaseCrmSyncStatus.mockResolvedValue({ caseId: "case-1", sources: [source()] });
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Pipedrive · Sales pipeline · deal 101");
    expect(text).toContain("Synced 3m ago");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("tells the user when Pipedrive is rate limiting and when sync retries", async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    mockPipelinesApi.getCaseCrmSyncStatus.mockResolvedValue({
      caseId: "case-1",
      sources: [source({ rateLimitedUntil: until, lastErrorMessage: "Pipedrive rate limit reached. Sync retries in 10 min." })],
    });
    await render();
    const notice = container.querySelector("[role=status]");
    expect(notice?.textContent).toMatch(/^Pipedrive is limiting requests\. Sync retries at \d{2}:\d{2}\.$/);
  });

  it("says when the sync could not be loaded", async () => {
    mockPipelinesApi.getCaseCrmSyncStatus.mockRejectedValue(new Error("boom"));
    await render();
    expect(container.textContent).toContain("Could not load the CRM sync status");
  });

  it("picks the most useful notice", () => {
    expect(crmSyncNotice(source({ bindingStatus: "error", lastErrorMessage: "Pipedrive refused the credential (401). Reconnect Pipedrive, then resume the binding." })))
      .toEqual({ tone: "danger", text: "Pipedrive refused the credential (401). Reconnect Pipedrive, then resume the binding." });
    expect(crmSyncNotice(source({ bindingStatus: "paused" }))).toEqual({ tone: "warning", text: "Sync with Pipedrive is paused." });
    expect(crmSyncNotice(source({
      lastEvent: {
        id: "e1", companyId: "co-1", bindingId: "binding-1", direction: "inbound", action: "failed", entityKind: "case",
        entityId: "case-1", externalId: "101", changedFields: [], conflictId: null, errorMessage: "Deal value must be a number", createdAt: "",
      },
    }))).toEqual({ tone: "danger", text: "Deal value must be a number" });
    expect(crmSyncNotice(source())).toBeNull();
  });
});
