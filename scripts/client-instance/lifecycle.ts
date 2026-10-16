// Pause, resume, archive and delete of one client instance (GRE-1367, B9 on
// GRE-1357). Pure helpers, tested without a server; client-instance.ts runs
// the commands. No retention value lives here: archive takes it as a flag
// (John's setting), and nothing is ever deleted on a timer.

import path from "node:path";
import type { FleetLifecycle } from "../../packages/shared/src/fleet.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows that show AI or job use, and any fee. Counted at pause and again at
 * resume, before the companies resume: AT-4.6 passes when none grew.
 */
export interface UsageCounts {
  heartbeatRuns: number;
  costEvents: number;
  financeEvents: number;
  billingInvoices: number;
}

export const USAGE_LABELS: Record<keyof UsageCounts, string> = {
  heartbeatRuns: "runs",
  costEvents: "cost events",
  financeEvents: "finance events",
  billingInvoices: "invoices",
};

export interface PauseRecord {
  at: string;
  operator: string;
  reason: string;
  backupFile: string;
  /** Companies this pause paused in the app; resume lifts only these. */
  companyIds: string[];
  counts: UsageCounts;
}

export interface ResumeRecord {
  at: string;
  operator: string;
  reason: string;
  pausedAt: string;
  /** Rows added while paused; all zero when AT-4.6 passes. */
  addedWhilePaused: UsageCounts;
  ok: boolean;
}

export interface ArchiveRecord {
  at: string;
  operator: string;
  backupFile: string;
  offsiteSnapshot: string | null;
  offsiteCheck: string;
  /** John's setting, given at archive time. */
  retentionDays: number;
  retentionEnd: string;
}

export interface LifecycleState {
  lifecycle?: FleetLifecycle;
  lastPause?: PauseRecord;
  lastResume?: ResumeRecord;
  lastArchive?: ArchiveRecord;
}

export function lifecycleOf(state: LifecycleState): FleetLifecycle {
  return state.lifecycle ?? "active";
}

/** A name or reference typed by the operator: one line, no control characters. */
function checkText(value: string | undefined, flag: string, max: number): string | null {
  const text = value?.trim() ?? "";
  if (!text) return `${flag} is required`;
  if (text.length > max) return `${flag} must be ${max} characters or fewer`;
  if (/[\u0000-\u001f\u007f]/.test(text)) return `${flag} must be one line of plain text`;
  return null;
}

/** --operator and --reason: pause, resume and archive are named acts. */
export function checkActor(opts: { operator?: string; reason?: string }, needReason: boolean): string | null {
  return checkText(opts.operator, "--operator", 200) ?? (needReason ? checkText(opts.reason, "--reason", 2000) : null);
}

/** --retention-days: a whole number of days, 1 or more. No default: John sets it. */
export function parseRetentionDays(raw: string | undefined): number | { error: string } {
  if (raw === undefined) return { error: "--retention-days N is required (John's retention setting; there is no default)" };
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < 1) return { error: "--retention-days must be a whole number of 1 or more" };
  return days;
}

export function retentionEnd(archivedAt: string, days: number): string {
  return new Date(Date.parse(archivedAt) + days * DAY_MS).toISOString();
}

/** An approval reference such as GRE-1234 or a ticket id: no spaces, 3 to 80 characters. */
const APPROVAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,79}$/;

/**
 * delete needs the instance code typed again, an approval reference and a
 * named operator, and the instance must be paused or archived (AT-4.8).
 */
export function checkDeleteRequest(input: {
  code: string;
  typedCode?: string;
  approval?: string;
  operator?: string;
  lifecycle: FleetLifecycle;
  running: boolean;
}): string | null {
  if (input.typedCode === undefined) return "--confirm-code <instance code> is required: type the code again";
  if (input.typedCode !== input.code) return `--confirm-code "${input.typedCode}" does not match this instance (${input.code}); nothing removed`;
  if (!input.approval || !APPROVAL_PATTERN.test(input.approval)) {
    return "--approval <reference> is required: the issue or ticket where John approved this deletion (for example GRE-1234)";
  }
  const operator = checkText(input.operator, "--operator", 200);
  if (operator) return operator;
  if (input.lifecycle === "active") return "the instance is active; pause (or archive) it first";
  if (input.running) return "the instance is running; it must be stopped";
  return null;
}

export function usageDelta(before: UsageCounts, after: UsageCounts): UsageCounts {
  return {
    heartbeatRuns: after.heartbeatRuns - before.heartbeatRuns,
    costEvents: after.costEvents - before.costEvents,
    financeEvents: after.financeEvents - before.financeEvents,
    billingInvoices: after.billingInvoices - before.billingInvoices,
  };
}

export function usageIsZero(delta: UsageCounts): boolean {
  return Object.values(delta).every((n) => n === 0);
}

export function describeUsage(counts: UsageCounts): string {
  return (Object.keys(USAGE_LABELS) as Array<keyof UsageCounts>).map((key) => `${counts[key]} ${USAGE_LABELS[key]}`).join(", ");
}

/** Lines for `status` (AT-4.3, AT-4.9). A WARNING does not change the exit code. */
export function lifecycleStatusLines(state: LifecycleState, now = Date.now()): string[] {
  const lifecycle = lifecycleOf(state);
  if (lifecycle === "paused") {
    const pause = state.lastPause;
    return [`lifecycle: paused${pause ? ` since ${pause.at} by ${pause.operator}: ${pause.reason}` : ""}; start is refused, use resume`];
  }
  if (lifecycle === "archived") {
    const archive = state.lastArchive;
    if (!archive) return ["lifecycle: archived (no archive record)"];
    const lines = [
      `lifecycle: archived on ${archive.at} by ${archive.operator}; retention ${archive.retentionDays} days, ends ${archive.retentionEnd}`,
      `archive copy: ${archive.offsiteCheck}`,
    ];
    if (Date.parse(archive.retentionEnd) <= now) {
      lines.push(
        `DUE FOR DELETION: the retention end ${archive.retentionEnd} has passed. Nothing is deleted automatically; delete needs the code typed again and an approval reference.`,
      );
    }
    return lines;
  }
  const resume = state.lastResume;
  if (!resume) return ["lifecycle: active"];
  return [
    `lifecycle: active; resumed ${resume.at} by ${resume.operator}`,
    resume.ok
      ? `while paused: no new use (${describeUsage(resume.addedWhilePaused)} added)`
      : `WARNING: rows were added while paused: ${describeUsage(resume.addedWhilePaused)}`,
  ];
}

/**
 * What `watch` reports for a paused or archived instance in place of the app,
 * backup, restore-check, off-host and AI signals: the app is stopped on
 * purpose and makes no new backups, so their age is not a failure.
 */
export function dormantHealthDetail(state: LifecycleState): string {
  const lifecycle = lifecycleOf(state);
  const since = lifecycle === "paused" ? state.lastPause?.at : state.lastArchive?.at;
  return `${lifecycle}${since ? ` since ${since}` : ""}: app stopped on purpose; app, backup and AI checks skipped`;
}

/**
 * The one record left after delete (AT-4.8). Codes, dates, names of Greatstone
 * operators and labels only: no client data.
 */
export interface DeletionRecord {
  code: string;
  deletedAt: string;
  operator: string;
  approval: string;
  lifecycleBefore: FleetLifecycle;
  archivedAt: string | null;
  billingExport: string;
  removed: string[];
  notRemoved: string[];
}

/** Beside the instance folders, so removing the instance folder keeps it. */
export function deletionRecordPath(root: string): string {
  return path.join(path.dirname(root), "deletions", `${path.basename(root)}.json`);
}
