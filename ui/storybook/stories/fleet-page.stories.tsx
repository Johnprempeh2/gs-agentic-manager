import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { FleetInstanceView } from "@greatstone/shared/fleet";
import { Fleet } from "@/pages/Fleet";
import { queryKeys } from "@/lib/queryKeys";

// Sandbox values only: instance codes, never client names.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function instance(
  code: string,
  state: FleetInstanceView["state"],
  checkInMinutesAgo: number | null,
  overrides: Partial<NonNullable<FleetInstanceView["latestCheckIn"]>["checkIn"]> = {},
): FleetInstanceView {
  const at = checkInMinutesAgo === null ? null : minutesAgo(checkInMinutesAgo);
  return {
    id: `${code}-0000-0000-0000-000000000000`,
    code,
    status: state === "pending" ? "pending" : state === "revoked" ? "revoked" : "active",
    state,
    lifecycle: state === "paused" ? "paused" : state === "pending" ? null : "active",
    lifecycleChangedAt: state === "paused" ? minutesAgo(3 * 24 * 60) : null,
    registeredAt: state === "pending" ? null : minutesAgo(30 * 24 * 60),
    lastCheckInAt: at,
    revokedAt: state === "revoked" ? minutesAgo(2 * 24 * 60) : null,
    revokedBy: null,
    registrationCodeExpiresAt: null,
    createdAt: minutesAgo(30 * 24 * 60),
    latestCheckIn: at
      ? {
          receivedAt: at,
          checkIn: {
            schema: "gsam-fleet-check-in/v2",
            edition: "managed",
            health: { app: "ok", backupAgeMinutes: 90, restoreCheck: { ok: true, ageMinutes: 600 }, offsiteBackup: null },
            version: { releaseTag: "stable-2026-10-01.1", appVersion: "0.3.1", lastUpgrade: { ageMinutes: 6 * 24 * 60 } },
            usage: { companies: 1, activeAgents: 4, runsLast24h: 38, runsFailedLast24h: 1, spendCentsMonth: 6420, budgetCentsMonth: 15000, storageBytes: 512 * 1024 * 1024 },
            alerts: [{ key: "health", ok: true }, { key: "backup-age", ok: true }],
            lifecycle: "active",
            connections: { ai: { healthy: 2, needsAttention: 0 }, tools: { active: 5, disabled: 1 } },
            ...overrides,
          },
        }
      : null,
  } as FleetInstanceView;
}

const FLEET: FleetInstanceView[] = [
  instance("sbx01", "ok", 4, { edition: "managed-plus" }),
  instance("sbx02", "stale", 95, {
    alerts: [{ key: "health", ok: true }, { key: "ai-connections", ok: false }],
    connections: { ai: { healthy: 1, needsAttention: 1 }, tools: { active: 3, disabled: 0 } },
  }),
  instance("sbx03", "down", 26 * 60, {
    health: { app: "down", backupAgeMinutes: 30 * 60, restoreCheck: { ok: false, ageMinutes: 2 * 24 * 60 }, offsiteBackup: null },
    alerts: [{ key: "health", ok: false }, { key: "backup-age", ok: false }],
  }),
  instance("sbx04", "paused", 3 * 24 * 60),
  instance("sbx05", "pending", null),
];

function Seeded({ instances, children }: { instances: FleetInstanceView[]; children: ReactNode }) {
  const client = useQueryClient();
  useState(() => {
    client.setQueryData(queryKeys.access.currentBoardAccess, { isInstanceAdmin: true, source: "session" });
    client.setQueryData(queryKeys.instance.fleetInstances, instances);
    return null;
  });
  return <>{children}</>;
}

const meta: Meta = {
  title: "Pages/Fleet",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

/** The hub's read-only Fleet page: one instance in each common state. */
export const Overview: Story = {
  render: () => (
    <Seeded instances={FLEET}>
      <div className="p-4 md:p-6">
        <Fleet />
      </div>
    </Seeded>
  ),
};
