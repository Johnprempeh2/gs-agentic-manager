// Spoke side of the fleet channel (GRE-1082). Pure helpers, tested without a
// server; client-instance.ts reads the inputs and calls the hub.
//
// The instance makes its own Ed25519 key pair. The private key stays in
// <root>/fleet/key.json (mode 600) and is never sent; the hub gets the public
// key once, with the one-time code. Each message is a compact JWS the hub
// checks with that key. The check-in is built only from facts already on the
// host (client-instance.json, the watch signals, usage totals) and passes the
// closed schema in packages/shared/src/fleet.ts before it is signed.

import type { FleetCheckIn, FleetConnections } from "../../packages/shared/src/fleet.js";
import { aiConnectionNeedsAttention, type AiConnectionView } from "./watch.js";

// The key, signing and check-in helpers moved to packages/shared/src/fleet-spoke.ts
// so the GSAM server can be a spoke too (the Mac app). Re-exported here.
export {
  buildCheckIn,
  fleetHubUrl,
  generateFleetKey,
  instanceAlerts,
  nextSeq,
  registrationSubject,
  signFleetMessage,
  type CheckInInput,
  type FleetKey,
} from "../../packages/shared/src/fleet-spoke.js";

/** Kept in <root>/fleet/hub.json. No secret in it. */
export interface FleetRegistration {
  hubUrl: string;
  instanceId: string;
  code: string;
  registeredAt: string;
  /** The last `seq` sent; the next message must be higher. */
  lastSeq: number;
  lastCheckIn?: { at: string; ok: boolean; detail: string };
  /** GRE-1084: the hub's `at` from the last support answer the app kept; the next sync asks for changes since then. */
  supportSince?: string | null;
  lastSupportSync?: { at: string; ok: boolean; detail: string };
}

/** A tool connection as GET /api/companies/:id/tools/connections lists it. Only these fields are read. */
export interface ToolConnectionView {
  connectionPurpose?: string;
  status: string;
  enabled: boolean;
}

/**
 * Connection health as counts over every company (AT-3.3). Only the numbers
 * leave this function: no name, id, provider or company. AI log-ins listed
 * among the tool connections are counted once, as AI. A tool connection is
 * active when it is switched on; disabled when it is off or turned off.
 * Drafts and archived ones are not counted.
 */
export function connectionTotals(
  companies: Array<{ ai: AiConnectionView[]; tools: ToolConnectionView[] }>,
  now = Date.now(),
): FleetConnections {
  const totals: FleetConnections = { ai: { healthy: 0, needsAttention: 0 }, tools: { active: 0, disabled: 0 } };
  for (const company of companies) {
    for (const connection of company.ai) {
      if (aiConnectionNeedsAttention(connection, now)) totals.ai.needsAttention += 1;
      else totals.ai.healthy += 1;
    }
    for (const connection of company.tools) {
      if (connection.connectionPurpose === "ai") continue;
      if (connection.status === "active" && connection.enabled) totals.tools.active += 1;
      else if (connection.status === "active" || connection.status === "disabled") totals.tools.disabled += 1;
    }
  }
  return totals;
}

export interface UsageCompany {
  agents: Array<{ status: string }>;
  runsLast24h: number;
  runsFailedLast24h: number;
  spendCents: number;
  budgetCents: number;
}

/** Run statuses counted as failed: the same rule as the failure rate (server/src/services/run-failure-rate.ts). */
export const FAILED_RUN_STATUSES = ["failed", "timed_out", "interrupted"] as const;

/** The run list API returns at most this many rows per call. */
export const RUN_PAGE_LIMIT = 1000;

/**
 * Count every run created at or after `since`. The list API caps a page at
 * 1000 rows, newest first, with `before` exclusive. Each next page asks for
 * `before` = oldest `createdAt` + 1 ms, so rows that share the oldest
 * timestamp come back again; the id set counts each run once. When a full
 * page is all one millisecond, the next page starts below it so the count
 * still moves on (only runs past 1000 in that one millisecond are lost).
 */
export async function countRunsSince(
  fetchPage: (since: Date, before: Date | null) => Promise<Array<{ id: string; createdAt: string }>>,
  since: Date,
): Promise<number> {
  const seen = new Set<string>();
  let before: Date | null = null;
  for (;;) {
    const page = await fetchPage(since, before);
    let added = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const run of page) {
      if (!seen.has(run.id)) {
        seen.add(run.id);
        added += 1;
      }
      oldest = Math.min(oldest, Date.parse(run.createdAt));
    }
    if (page.length < RUN_PAGE_LIMIT || !Number.isFinite(oldest)) return seen.size;
    // Every row is older than `before`, so `oldest` always moves the window back.
    const stuck: boolean = added === 0 || (before !== null && oldest + 1 >= before.getTime());
    before = new Date(stuck ? oldest : oldest + 1);
  }
}

/** Totals over every company. Never per company, agent or person. */
export function usageTotals(companies: UsageCompany[], storageBytes: number): FleetCheckIn["usage"] {
  let activeAgents = 0;
  let runsLast24h = 0;
  let runsFailedLast24h = 0;
  let spendCentsMonth = 0;
  let budgetCentsMonth = 0;
  for (const company of companies) {
    activeAgents += company.agents.filter((a) => a.status !== "terminated" && a.status !== "paused" && a.status !== "pending_approval").length;
    runsLast24h += Math.max(0, Math.round(company.runsLast24h));
    runsFailedLast24h += Math.max(0, Math.round(company.runsFailedLast24h));
    spendCentsMonth += Math.max(0, Math.round(company.spendCents));
    budgetCentsMonth += Math.max(0, Math.round(company.budgetCents));
  }
  return { companies: companies.length, activeAgents, runsLast24h, runsFailedLast24h, spendCentsMonth, budgetCentsMonth, storageBytes: Math.max(0, Math.round(storageBytes)) };
}

/** What the hub's answer means for the operator. */
export function hubAnswer(status: number, body: unknown): { ok: boolean; detail: string } {
  if (status >= 200 && status < 300) return { ok: true, detail: `hub answered ${status}` };
  const code = (body as { error?: unknown } | null)?.error;
  const reason = typeof code === "string" ? code : `HTTP ${status}`;
  if (reason === "fleet_key_revoked") return { ok: false, detail: "the hub revoked this instance; ask for a new code and run fleet-register again" };
  return { ok: false, detail: `hub refused: ${reason}` };
}
