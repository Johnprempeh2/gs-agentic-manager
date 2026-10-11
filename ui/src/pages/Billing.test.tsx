// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccountView, BillingUsage, ClientBillingAccount } from "@greatstone/shared/billing-account";
import { Billing, formatBillingDay, formatMoney } from "./Billing";

const mockBillingApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/billing", () => ({ billingApi: mockBillingApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Test values only: the page shows whatever the operator set.
const ACCOUNT: ClientBillingAccount = {
  id: "acct-1",
  planKind: "modules",
  planName: "Growth",
  catalogueVersion: "packaging-v2-d2-2026-10-11",
  currency: "GBP",
  serviceFeeCents: 123_400,
  modules: [
    { key: "crm", feeCents: 25_000 },
    { key: "strategy", feeCents: null },
  ],
  estimateMonthlyCents: null,
  termKind: "monthly",
  termStartsOn: "2026-10-01",
  autoRenew: true,
  endAction: null,
  accessEndsOn: null,
  cancelRequestedAt: null,
  cancelRequestedByUserId: null,
  cancelReason: null,
  updatedByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const USAGE: BillingUsage = {
  windowStart: "2026-10-01",
  windowEnd: "2026-10-31",
  daysElapsed: 10,
  daysInWindow: 31,
  usedPercent: 30,
  forecastPercent: 93,
  warnPercent: 80,
  warning: false,
  extraUsage: { state: "none", amountCents: 0, currency: "GBP" },
  estimateCents: 40_000,
  pausedSince: null,
};

function view(overrides: Partial<BillingAccountView> = {}): BillingAccountView {
  return {
    audience: "client",
    account: ACCOUNT,
    status: {
      today: "2026-10-11",
      state: "active",
      hasAccess: true,
      currentPeriodStart: "2026-10-01",
      currentPeriodEnd: "2026-10-31",
      renewsOn: "2026-11-01",
      accessEndsOn: null,
      endAction: null,
    },
    invoices: [],
    usage: USAGE,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(data: BillingAccountView) {
  mockBillingApi.get.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Billing />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="billing-page"], .gs-empty, [role="alert"]')).not.toBeNull();
  });
}

function text(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Billing page", () => {
  it("AT-1.1: shows each fee exactly as set and the allowance with no money, with no edit control", async () => {
    await render(view());
    const rows = Array.from(container.querySelectorAll('[data-testid="billing-fee-row"]')).map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Service fee");
    expect(rows[0]).toContain(formatMoney(123_400, "GBP"));
    expect(rows[1]).toContain("CRM");
    expect(rows[1]).toContain(formatMoney(25_000, "GBP"));
    expect(rows[2]).toContain("Strategy");
    expect(rows[2]).toContain("Included");
    expect(text("billing-fee-total")).toBe(formatMoney(148_400, "GBP"));
    expect(text("billing-allowance")).toContain("AI allowance is included");
    expect(text("billing-allowance")).not.toMatch(/[£$]/);
    expect(container.textContent).toContain(`Renews on ${formatBillingDay("2026-11-01")}`);
    expect(container.querySelectorAll("input, textarea, select, button")).toHaveLength(0);
  });

  it("AT-1.2: shows used and left as a percent of the allowance, with no money for it (GRE-1395)", async () => {
    await render(view());
    expect(container.textContent).toContain("30% used");
    expect(container.textContent).toContain("70% left");
    expect(text("billing-actual")).toContain("30%");
    expect(text("billing-actual")).not.toMatch(/[£$]/);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("30");
  });

  it("AT-1.3: labels the forecast and the estimate", async () => {
    await render(view());
    expect(text("billing-estimate")).toContain("Estimate");
    expect(text("billing-estimate")).toContain(formatMoney(40_000, "GBP"));
    expect(text("billing-forecast")).toContain("Forecast to month end");
    expect(text("billing-forecast")).toContain("93%");
    expect(text("billing-forecast")).not.toMatch(/[£$]/);
  });

  it("shows extra usage in the account currency, 'None' within the allowance, and the invoice note when the rate is missing", async () => {
    await render(view());
    expect(text("billing-extra")).toContain("None");

    act(() => root.unmount());
    root = createRoot(container);
    await render(view({ usage: { ...USAGE, usedPercent: 120, extraUsage: { state: "priced", amountCents: 7_900, currency: "GBP" } } }));
    expect(text("billing-extra")).toContain(formatMoney(7_900, "GBP"));

    act(() => root.unmount());
    root = createRoot(container);
    await render(view({ usage: { ...USAGE, usedPercent: 120, extraUsage: { state: "rate_missing", amountCents: null, currency: "GBP" } } }));
    expect(text("billing-extra")).toContain("Shown on your invoice");
    expect(text("billing-extra")).not.toMatch(/[£$]/);
  });

  it("AT-1.3: shows 'Not set' when no estimate was set", async () => {
    await render(view({ usage: { ...USAGE, estimateCents: null } }));
    expect(text("billing-estimate")).toContain("Not set");
  });

  it("AT-1.4: shows a warning once usage crosses the warn level, and none below it", async () => {
    await render(view());
    expect(container.querySelector('[role="note"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await render(view({ usage: { ...USAGE, usedPercent: 82, warning: true } }));
    const note = container.querySelector('[role="note"]');
    expect(note?.textContent).toContain("82% of this month's AI allowance");
    expect(note?.textContent).toContain("warning level is 80%");
  });

  it("AT-1.10: shows paused since the pause date", async () => {
    await render(view({ usage: { ...USAGE, pausedSince: "2026-10-05T09:30:00.000Z" } }));
    expect(container.textContent).toContain(`Paused since ${formatBillingDay("2026-10-05")}`);
    expect(container.textContent).toContain("No AI usage is added");
  });

  it("shows the end date after a cancel, not a renewal", async () => {
    await render(
      view({
        status: {
          today: "2026-10-11",
          state: "cancel_pending",
          hasAccess: true,
          currentPeriodStart: "2026-10-01",
          currentPeriodEnd: "2026-10-31",
          renewsOn: null,
          accessEndsOn: "2026-10-31",
          endAction: "pause",
        },
      }),
    );
    expect(container.textContent).toContain(`Ends on ${formatBillingDay("2026-10-31")}`);
    expect(container.textContent).toContain("Cancelled");
    expect(container.textContent).not.toContain("Renews on");
  });

  it("still shows fees when the server sends no usage yet", async () => {
    await render(view({ usage: null }));
    expect(text("billing-usage")).toContain("not available yet");
    expect(text("billing-fee-total")).toBe(formatMoney(148_400, "GBP"));
  });

  it("shows an empty state when the instance has no billing account", async () => {
    await render({ audience: "client", account: null, status: null, invoices: [], usage: null });
    expect(container.textContent).toContain("No billing account");
  });
});
