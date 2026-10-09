// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmSyncConflict } from "@greatstone/shared";
import { CrmSyncConflictQueue, CrmSyncSuggestChange, crmSyncFieldLabel, formatCrmSyncValue } from "./CrmSyncConflictQueue";

const mockPipelinesApi = vi.hoisted(() => ({
  listCrmSyncConflicts: vi.fn(),
  listCrmSyncBindings: vi.fn(),
  resolveCrmSyncConflict: vi.fn(),
  acceptCrmSyncProposal: vi.fn(),
  dismissCrmSyncConflict: vi.fn(),
  getCrmSyncFieldMap: vi.fn(),
  suggestCrmSyncChange: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../api/pipelines", () => ({ pipelinesApi: mockPipelinesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

function conflict(overrides: Partial<CrmSyncConflict> = {}): CrmSyncConflict {
  return {
    id: "conflict-1",
    companyId: "company-1",
    bindingId: "binding-1",
    kind: "conflict",
    entityKind: "case",
    entityId: "case-1",
    externalId: "101",
    gsamField: "fields.notes",
    externalField: "notes_key",
    lastSyncedValue: "Wants a two-year term",
    crmValue: "Signed for two years",
    gsamValue: "Asked for three years",
    crmChangedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    gsamChangedBy: [{ actorType: "user", userId: "someone-else" }],
    gsamChangedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    reason: null,
    proposal: null,
    status: "open",
    resolution: null,
    resolvedByUserId: null,
    resolvedByAgentId: null,
    resolvedAt: null,
    decisionReason: null,
    detectedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function buttonNamed(container: HTMLElement, name: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) ?? null;
}

describe("Sync conflicts queue", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "me" }, session: { userId: "me" } });
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Sales Scout" }]);
    mockPipelinesApi.listCrmSyncBindings.mockResolvedValue([]);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("labels fields and values for people", () => {
    expect(crmSyncFieldLabel("fields.dealValue")).toBe("Deal value");
    expect(crmSyncFieldLabel("title")).toBe("Title");
    expect(formatCrmSyncValue(null)).toBe("Empty");
    expect(formatCrmSyncValue(["a", "b"])).toBe("a, b");
  });

  it("shows nothing when nothing is held", async () => {
    mockPipelinesApi.listCrmSyncConflicts.mockResolvedValue({ items: [], nextCursor: null });
    await render(<CrmSyncConflictQueue companyId="company-1" caseId="case-1" />);
    expect(container.textContent).toBe("");
  });

  it("shows both values and who changed each, and keeps the CRM value with a reason", async () => {
    mockPipelinesApi.listCrmSyncConflicts.mockResolvedValue({ items: [conflict()], nextCursor: null });
    mockPipelinesApi.resolveCrmSyncConflict.mockResolvedValue(conflict({ status: "resolved" }));
    await render(<CrmSyncConflictQueue companyId="company-1" caseId="case-1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Sync conflicts");
    expect(text).toContain("Notes");
    expect(text).toContain("Signed for two years");
    expect(text).toContain("Asked for three years");
    expect(text).toContain("by A teammate");
    expect(text).toContain("changed 10m ago");
    expect(mockPipelinesApi.listCrmSyncConflicts).toHaveBeenCalledWith("company-1", { entityId: "case-1" });

    const reason = container.querySelector<HTMLInputElement>("input[aria-label='Reason for your decision']")!;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(reason, "Signed contract wins");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => buttonNamed(container, "Keep CRM")!.click());
    await flushReact();
    expect(mockPipelinesApi.resolveCrmSyncConflict).toHaveBeenCalledWith("conflict-1", {
      resolution: "keep_crm",
      reason: "Signed contract wins",
    });
  });

  it("hides the decision when the conflict holds only my change", async () => {
    mockPipelinesApi.listCrmSyncConflicts.mockResolvedValue({
      items: [conflict({ gsamChangedBy: [{ actorType: "user", userId: "me" }] })],
      nextCursor: null,
    });
    await render(<CrmSyncConflictQueue companyId="company-1" caseId="case-1" />);
    expect(container.textContent).toContain("This holds only your change. Someone else decides.");
    expect(buttonNamed(container, "Keep CRM")).toBeNull();
  });

  it("shows an agent's proposal with its reason and accepts it", async () => {
    mockPipelinesApi.listCrmSyncConflicts.mockResolvedValue({
      items: [conflict({
        proposal: {
          resolution: "keep_crm",
          value: null,
          reason: "Pipedrive holds the signed contract",
          proposedByAgentId: "agent-1",
          proposedByUserId: null,
          proposedAt: new Date().toISOString(),
        },
      })],
      nextCursor: null,
    });
    mockPipelinesApi.acceptCrmSyncProposal.mockResolvedValue(conflict({ status: "resolved" }));
    await render(<CrmSyncConflictQueue companyId="company-1" caseId="case-1" />);
    expect(container.textContent).toContain("Sales Scout proposes: Keep the CRM value");
    expect(container.textContent).toContain("Pipedrive holds the signed contract");
    flushSync(() => buttonNamed(container, "Accept proposal")!.click());
    await flushReact();
    expect(mockPipelinesApi.acceptCrmSyncProposal).toHaveBeenCalledWith("conflict-1");
  });

  it("shows a suggested change with Accept and Reject, and the server's refusal", async () => {
    mockPipelinesApi.listCrmSyncConflicts.mockResolvedValue({
      items: [conflict({
        kind: "suggestion",
        gsamField: "fields.dealValue",
        crmValue: 12000,
        gsamValue: 20000,
        reason: "Scope grew to three sites",
        gsamChangedBy: [{ actorType: "agent", agentId: "agent-1" }],
      })],
      nextCursor: null,
    });
    mockPipelinesApi.resolveCrmSyncConflict.mockRejectedValue(new Error("This holds only your own change. Ask someone else to decide."));
    await render(<CrmSyncConflictQueue companyId="company-1" caseId="case-1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Suggested change");
    expect(text).toContain("Suggested · by Sales Scout");
    expect(text).toContain("Why: Scope grew to three sites");
    expect(buttonNamed(container, "Reject")).not.toBeNull();
    flushSync(() => buttonNamed(container, "Accept and write to the CRM")!.click());
    await flushReact();
    expect(mockPipelinesApi.resolveCrmSyncConflict).toHaveBeenCalledWith("conflict-1", { resolution: "keep_gsam" });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Ask someone else to decide");
  });

  it("suggests a change to a CRM-owned field with a reason", async () => {
    mockPipelinesApi.getCrmSyncFieldMap.mockResolvedValue({
      bindingId: "binding-1",
      updatedAt: new Date().toISOString(),
      fields: [
        { id: "f1", bindingId: "binding-1", externalField: "value", externalFieldLabel: "Value", gsamField: "fields.dealValue", owner: "crm" },
        { id: "f2", bindingId: "binding-1", externalField: "notes_key", externalFieldLabel: "Notes", gsamField: "fields.notes", owner: "shared" },
      ],
    });
    mockPipelinesApi.suggestCrmSyncChange.mockResolvedValue(conflict({ kind: "suggestion" }));
    await render(<CrmSyncSuggestChange caseId="case-1" bindingIds={["binding-1"]} />);
    flushSync(() => buttonNamed(container, "Suggest a change to a CRM field")!.click());
    await flushReact();
    const options = [...container.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["Value"]); // shared fields are edited on the case, not suggested

    const [value, reason] = [...container.querySelectorAll<HTMLInputElement>("form input")];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setter.call(value, "20000");
      value!.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(reason, "Scope grew");
      reason!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => buttonNamed(container, "Send for review")!.click());
    await flushReact();
    expect(mockPipelinesApi.suggestCrmSyncChange).toHaveBeenCalledWith("case-1", {
      gsamField: "fields.dealValue",
      value: "20000",
      reason: "Scope grew",
    });
    expect(container.textContent).toContain("Sent for review.");
  });
});
