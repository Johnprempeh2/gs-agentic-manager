// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetInstanceView } from "@greatstone/shared/fleet";
import { ApiError } from "@/api/client";
import { Fleet, formatAgeMinutes } from "./Fleet";

const mockFleetApi = vi.hoisted(() => ({
  listInstances: vi.fn(),
  createLicence: vi.fn(),
  issueEntitlement: vi.fn(),
  createOrder: vi.fn(),
  operatorLogin: vi.fn(),
  listCatalogue: vi.fn(),
  createCatalogueItem: vi.fn(),
  updateCatalogueItem: vi.fn(),
  archiveCatalogueItem: vi.fn(),
  linkBilling: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
vi.mock("@/api/fleet", () => ({ fleetApi: mockFleetApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const NOW = new Date().toISOString();

// Test values only: instance codes, never client names.
const OK: FleetInstanceView = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "c001",
  status: "active",
  state: "ok",
  lifecycle: "active",
  lifecycleChangedAt: null,
  registeredAt: NOW,
  lastCheckInAt: NOW,
  revokedAt: null,
  revokedBy: null,
  registrationCodeExpiresAt: null,
  createdAt: NOW,
  latestCheckIn: {
    receivedAt: NOW,
    checkIn: {
      schema: "gsam-fleet-check-in/v2",
      edition: "managed-plus",
      health: { app: "ok", backupAgeMinutes: 90, restoreCheck: { ok: true, ageMinutes: 600 }, offsiteBackup: null },
      version: { releaseTag: "stable-2026-10-01.1", appVersion: "0.3.1", lastUpgrade: null },
      usage: { companies: 1, activeAgents: 3, runsLast24h: 20, runsFailedLast24h: 2, spendCentsMonth: 1234, budgetCentsMonth: 15000, storageBytes: 2048 },
      alerts: [{ key: "health", ok: true }, { key: "ai-connections", ok: false }],
      lifecycle: "active",
      connections: { ai: { healthy: 2, needsAttention: 1 }, tools: { active: 4, disabled: 1 } },
    },
  },
};

const DOWN: FleetInstanceView = {
  ...OK,
  id: "22222222-2222-2222-2222-222222222222",
  code: "c002",
  state: "down",
  latestCheckIn: {
    ...OK.latestCheckIn!,
    checkIn: {
      ...OK.latestCheckIn!.checkIn,
      health: { ...OK.latestCheckIn!.checkIn.health, app: "down" },
      alerts: [{ key: "health", ok: false }, { key: "backup-age", ok: false }, { key: "new-check", ok: false }],
    },
  },
};
const PENDING: FleetInstanceView = {
  ...OK,
  id: "33333333-3333-3333-3333-333333333333",
  code: "c003",
  status: "pending",
  state: "pending",
  lifecycle: null,
  registeredAt: null,
  lastCheckInAt: null,
  latestCheckIn: null,
};

const IN_A_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** A GSAM for Mac install: a signed document, an operator log-in, orders and a tailnet name. */
const MAC: FleetInstanceView = {
  ...OK,
  id: "44444444-4444-4444-4444-444444444444",
  code: "mac-1a2b3c4d",
  state: "stopped",
  lifecycle: "stopped",
  lifecycleChangedAt: NOW,
  entitlementVersion: 2,
  operatorEmail: "operator+mac-1a2b3c4d@greatstone.invalid",
  entitlement: {
    version: 2,
    features: { enablePipelines: true, enableStrategy: true, enableCases: false },
    limits: { maxUsers: 5 },
    validUntil: IN_A_MONTH,
    grace: 0,
    issuedAt: NOW,
    issuedBy: "admin@hub.test",
    reason: "Monthly plan",
  },
  orders: [
    { id: "o2", seq: 2, kind: "stop", reason: "Contract ended", issuedBy: "admin@hub.test", createdAt: NOW, expiresAt: IN_A_MONTH, status: "done", resultCode: null, resultAt: NOW },
    { id: "o1", seq: 1, kind: "update", reason: "Security fix", issuedBy: "admin@hub.test", createdAt: NOW, expiresAt: NOW, status: "failed", resultCode: "update_unavailable", resultAt: NOW },
  ],
  latestCheckIn: {
    receivedAt: NOW,
    checkIn: {
      ...OK.latestCheckIn!.checkIn,
      schema: "gsam-fleet-check-in/v3",
      lifecycle: "stopped",
      orders: [],
      remote: { tailnetName: "gsam-mac-1a2b3c4d.tail1234.ts.net" },
    } as FleetInstanceView["latestCheckIn"] extends infer T ? (T extends { checkIn: infer C } ? C : never) : never,
  },
};

const ENDED: FleetInstanceView = {
  ...MAC,
  id: "55555555-5555-5555-5555-555555555555",
  code: "mac-ended",
  state: "ok",
  lifecycle: "active",
  orders: [],
  entitlement: { ...MAC.entitlement!, validUntil: new Date(Date.now() - 60_000).toISOString() },
  latestCheckIn: { ...OK.latestCheckIn! },
};

let container: HTMLDivElement;
let root: Root;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Fleet />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="fleet-page"], .gs-empty, [role="alert"]')).not.toBeNull();
  });
}

/** Dialogs render in a portal on document.body. */
function dialog() {
  return document.body.querySelector('[role="dialog"]') as HTMLElement | null;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function buttonByText(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
}

async function type(element: Element | null | undefined, value: string) {
  expect(element).toBeTruthy();
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function row(code: string) {
  return container.querySelector(`[data-testid="fleet-row-${code}"]`)?.textContent ?? "";
}

function card(code: string) {
  return container.querySelector(`[data-testid="fleet-card-${code}"]`)?.textContent ?? "";
}

function attention(code: string) {
  return container.querySelector(`[data-testid="fleet-row-${code}"] [data-testid="fleet-attention-${code}"]`)?.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: true, source: "session" });
  mockFleetApi.listCatalogue.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Fleet page", () => {
  it("lists each instance with its state and what its last check-in said", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect(row("c001")).toContain("OK");
    expect(row("c001")).toContain("Managed plus");
    expect(row("c001")).toContain("Backup 2h ago");
    expect(row("c001")).toContain("stable-2026-10-01.1");
    expect(row("c001")).toContain("$12.34");
    expect(row("c001")).toContain("2 failed");
    expect(row("c001")).toContain("1 need attention");
    expect(row("c001")).toContain("AI connection needs attention");
    expect(row("c001")).not.toContain("ai-connections");
    expect(row("c002")).toContain("Down");
    expect(row("c003")).toContain("Not registered");
    expect(row("c003")).toContain("Never");
  });

  it("puts failed health and failing alerts under the state", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect(attention("c001")).toBe("AI connection needs attention");
    expect(attention("c002")).toBe("App downBackup too oldNew check alert");
    expect(attention("c003")).toBe("");
  });

  it("labels usage and connections from a stale or down instance as last reported", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN]);
    await render();
    expect(row("c001")).not.toContain("Last reported");
    expect(row("c002").match(/Last reported/g)).toHaveLength(2);
  });

  it("has a phone card for each instance with code, state, check-in and alerts together", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect(card("c002")).toContain("c002");
    expect(card("c002")).toContain("Down");
    expect(card("c002")).toContain("Last check-in");
    expect(card("c002")).toContain("App down");
    expect(card("c003")).toContain("Never");
  });

  it("has no controls on a host-script instance: only the New licence and catalogue buttons", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect([...container.querySelectorAll("button, form, input, a")].map((el) => el.textContent?.trim())).toEqual(["New licence", "Add to catalogue"]);
  });

  it("lists the catalogue with prices, a deal's one customer, and what Stripe says about each install", async () => {
    const base = { description: null, limits: {}, moduleIds: [], features: [], currency: "gbp", stripeCustomerId: null, archivedAt: null, updatedAt: NOW, stripeProductId: "prod_1" };
    mockFleetApi.listCatalogue.mockResolvedValue([
      { ...base, id: "m1", kind: "module", name: "CRM", features: ["enablePipelines"], limits: { maxUsers: 5 }, monthlyAmount: 4900, annualAmount: null, prices: [{ stripePriceId: "price_1", interval: "month", amount: 4900, currency: "gbp", active: true }] },
      { ...base, id: "d1", kind: "deal", name: "Launch deal", moduleIds: ["m1"], stripeCustomerId: "cus_test1", monthlyAmount: 1000, annualAmount: 10000, stripeProductId: null, prices: [] },
    ]);
    mockFleetApi.listInstances.mockResolvedValue([{ ...MAC, billing: { stripeCustomerId: "cus_test1", stripeSubscriptionId: "sub_1", subscriptionStatus: "past_due", cancelAtPeriodEnd: false } }]);
    await render();
    await vi.waitFor(() => expect(container.querySelector('[data-testid="catalogue-table"]')).toBeTruthy());
    const crm = container.querySelector('[data-testid="catalogue-row-m1"]')!.textContent!;
    expect(crm).toContain("GBP 49 a month");
    expect(crm).toContain("Not annual");
    expect(crm).toContain("In Stripe");
    const deal = container.querySelector('[data-testid="catalogue-row-d1"]')!.textContent!;
    expect(deal).toContain("CRM");
    expect(deal).toContain("Only for cus_test1");
    expect(deal).toContain("Not in Stripe yet");
    expect(row("mac-1a2b3c4d")).toContain("Stripe: past due");
  });

  it("shows a Mac install's state, paid-until, features and limits, and an ended subscription", async () => {
    mockFleetApi.listInstances.mockResolvedValue([MAC, ENDED]);
    await render();
    expect(row("mac-1a2b3c4d")).toContain("Stopped");
    const subscription = container.querySelector('[data-testid="fleet-row-mac-1a2b3c4d"] [data-testid="fleet-subscription-mac-1a2b3c4d"]')!.textContent;
    expect(subscription).toContain("Paid until");
    expect(subscription).toContain("Pipelines, Strategy");
    expect(subscription).not.toContain("Cases");
    expect(subscription).toContain("Users 5");
    expect(row("mac-ended")).toContain("Ended");
  });

  it("shows each install's operating system from a v4 check-in, and not reported before", async () => {
    const WINDOWS: FleetInstanceView = {
      ...MAC,
      id: "66666666-6666-6666-6666-666666666666",
      code: "win-1a2b3c4d",
      latestCheckIn: {
        receivedAt: NOW,
        checkIn: {
          ...MAC.latestCheckIn!.checkIn,
          schema: "gsam-fleet-check-in/v4",
          platform: { os: "windows", arch: "x64" },
        } as FleetInstanceView["latestCheckIn"] extends infer T ? (T extends { checkIn: infer C } ? C : never) : never,
      },
    };
    mockFleetApi.listInstances.mockResolvedValue([MAC, WINDOWS]);
    await render();
    expect(container.querySelector('[data-testid="fleet-table"] thead')!.textContent).toContain("OS");
    expect(row("win-1a2b3c4d")).toContain("Windows x64");
    expect(row("mac-1a2b3c4d")).toContain("Not reported");
  });

  it("sends a signed order only with a reason, and stop needs a second click", async () => {
    mockFleetApi.listInstances.mockResolvedValue([MAC]);
    mockFleetApi.createOrder.mockResolvedValue(MAC.orders![0]);
    await render();
    await click(container.querySelector('[data-testid="fleet-row-mac-1a2b3c4d"] [data-testid="fleet-manage-mac-1a2b3c4d"]'));
    const modal = dialog()!;
    expect(modal.textContent).toContain("Contract ended");
    expect(modal.textContent).toContain("Failed (update unavailable)");
    expect(buttonByText(modal, "Pause")!.disabled).toBe(true);
    await type(modal.querySelector("textarea"), "Invoice overdue");
    await click(buttonByText(modal, "Pause"));
    expect(mockFleetApi.createOrder).toHaveBeenCalledWith(MAC.id, { kind: "pause", reason: "Invoice overdue" });

    await type(modal.querySelector("textarea"), "Contract ended");
    await click(buttonByText(modal, "Stop service"));
    expect(mockFleetApi.createOrder).toHaveBeenCalledTimes(1);
    expect(modal.textContent).toContain("Service stopped by Greatstone");
    await click(buttonByText(modal, "Confirm: stop the service"));
    expect(mockFleetApi.createOrder).toHaveBeenLastCalledWith(MAC.id, { kind: "stop", reason: "Contract ended" });
  });

  it("opens the install over the tailnet and reveals the operator log-in on request", async () => {
    mockFleetApi.listInstances.mockResolvedValue([MAC]);
    mockFleetApi.operatorLogin.mockResolvedValue({ email: MAC.operatorEmail, password: "test-password-value" });
    await render();
    await click(container.querySelector('[data-testid="fleet-row-mac-1a2b3c4d"] [data-testid="fleet-manage-mac-1a2b3c4d"]'));
    const modal = dialog()!;
    expect(modal.querySelector('[data-testid="fleet-open-remote"]')!.getAttribute("href")).toBe("http://gsam-mac-1a2b3c4d.tail1234.ts.net:3100");
    expect(mockFleetApi.operatorLogin).not.toHaveBeenCalled();
    await click(modal.querySelector('[data-testid="fleet-reveal-operator"]'));
    await vi.waitFor(() => expect(modal.querySelector('[data-testid="fleet-operator-password"]')?.textContent).toBe("test-password-value"));
    expect(buttonByText(modal, "Copy")).toBeTruthy();
  });

  it("signs a new document with the changed features, limits and paid-until", async () => {
    mockFleetApi.listInstances.mockResolvedValue([MAC]);
    mockFleetApi.issueEntitlement.mockResolvedValue({ ...MAC, entitlementVersion: 3 });
    await render();
    await click(container.querySelector('[data-testid="fleet-row-mac-1a2b3c4d"] [data-testid="fleet-manage-mac-1a2b3c4d"]'));
    const modal = dialog()!;
    await type(modal.querySelector("#limit-maxUsers"), "8");
    await type(modal.querySelector("#paid-until"), "2027-01-31");
    await click(buttonByText(modal, "Sign new version"));
    const [id, body] = mockFleetApi.issueEntitlement.mock.calls[0]!;
    expect(id).toBe(MAC.id);
    expect(body).toMatchObject({ limits: { maxUsers: 8 }, validUntil: "2027-01-31T23:59:59Z", features: { enablePipelines: true, enableStrategy: true, enableCases: false } });
    await vi.waitFor(() => expect(modal.textContent).toContain("Version 3 signed"));
  });

  it("makes a licence key and shows it once with a copy button", async () => {
    mockFleetApi.listInstances.mockResolvedValue([]);
    mockFleetApi.createLicence.mockResolvedValue({ instance: { ...PENDING, code: "mac-new" }, licenceKey: "gsamlk_test-key-value", licenceKeyExpiresAt: IN_A_MONTH });
    await render();
    await click(container.querySelector('[data-testid="fleet-new-licence"]'));
    const modal = dialog()!;
    await click(modal.querySelector('[role="checkbox"]'));
    await click(buttonByText(modal, "Make licence key"));
    expect(mockFleetApi.createLicence.mock.calls[0]![0]).toMatchObject({ features: { enableAgentChat: true, enablePipelines: false } });
    await vi.waitFor(() => expect(modal.querySelector('[data-testid="fleet-licence-key"]')?.textContent).toBe("gsamlk_test-key-value"));
    expect(modal.textContent).toContain("it is not shown again");
    expect(buttonByText(modal, "Copy")).toBeTruthy();
  });

  it("does not ask the hub when the user is not an instance admin", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ isInstanceAdmin: false, source: "session" });
    await render();
    expect(mockFleetApi.listInstances).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Fleet is not available here");
  });

  it("shows not available when the server refuses (403) or is not the hub (404)", async () => {
    for (const status of [403, 404]) {
      mockFleetApi.listInstances.mockRejectedValueOnce(new ApiError("no", status, null));
      await render();
      expect(container.textContent).toContain("Fleet is not available here");
    }
  });

  it("formats ages", () => {
    expect(formatAgeMinutes(45)).toBe("45m");
    expect(formatAgeMinutes(90)).toBe("2h");
    expect(formatAgeMinutes(3 * 24 * 60)).toBe("3d");
  });
});
