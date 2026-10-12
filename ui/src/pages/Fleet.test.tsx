// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetInstanceView } from "@greatstone/shared/fleet";
import { ApiError } from "@/api/client";
import { Fleet, formatAgeMinutes } from "./Fleet";

const mockFleetApi = vi.hoisted(() => ({ listInstances: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));
vi.mock("@/api/fleet", () => ({ fleetApi: mockFleetApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    checkIn: { ...OK.latestCheckIn!.checkIn, health: { ...OK.latestCheckIn!.checkIn.health, app: "down" } },
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
    expect(row("c001")).toContain("ai-connections");
    expect(row("c001")).not.toContain("health");
    expect(row("c002")).toContain("Down");
    expect(row("c003")).toContain("Not registered");
    expect(row("c003")).toContain("Never");
  });

  it("puts failed health and failing alerts under the state", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect(attention("c001")).toBe("ai-connections");
    expect(attention("c002")).toContain("App down");
    expect(attention("c002")).toContain("ai-connections");
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

  it("is read-only: no button, link or form on the page", async () => {
    mockFleetApi.listInstances.mockResolvedValue([OK, DOWN, PENDING]);
    await render();
    expect(container.querySelectorAll("button, form, input, a")).toHaveLength(0);
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
