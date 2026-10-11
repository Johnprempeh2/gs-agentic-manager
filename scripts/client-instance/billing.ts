// Billing-record export and retention (B11, GRE-1372). Pure helpers, tested
// without a server; client-instance.ts reads the rows and runs the commands.
//
// Rule (D8, John, 11 Oct 2026, GRE-1354): billing records are kept for a
// number of years set by the operator, not in code. Deleting an instance
// must not delete them, so `billing-export` copies the instance's
// billing_accounts and billing_invoices rows to the operator's billing
// archive, outside every instance folder. Nothing deletes an export on a
// timer: past its retention end it is only listed as due for review.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BillingConfig {
  /** Absolute folder for billing exports, outside every instance folder. */
  archiveDir: string;
  /** Years an export is kept after it is written (D8). */
  retentionYears: number;
}

/** Parse a billing config file (KEY=VALUE lines). Both keys are required: the build never guesses a retention period. */
export function parseBillingConfig(text: string): BillingConfig | { error: string } {
  const values: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `line ${index + 1} is not KEY=VALUE` };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key !== "BILLING_ARCHIVE_DIR" && key !== "BILLING_RETENTION_YEARS") return { error: `${key} is not a billing setting` };
    values[key] = value;
  }
  const archiveDir = values.BILLING_ARCHIVE_DIR;
  const years = values.BILLING_RETENTION_YEARS;
  if (!archiveDir) return { error: "BILLING_ARCHIVE_DIR is missing" };
  if (!path.isAbsolute(archiveDir)) return { error: "BILLING_ARCHIVE_DIR must be an absolute path" };
  if (!years) return { error: "billing retention not set: BILLING_RETENTION_YEARS is missing" };
  if (!/^[1-9][0-9]?$/.test(years)) return { error: "BILLING_RETENTION_YEARS must be a whole number of years from 1 to 99" };
  return { archiveDir: path.resolve(archiveDir), retentionYears: Number(years) };
}

export function loadBillingConfig(file: string): BillingConfig | { error: string } {
  if (!existsSync(file)) return { error: `billing config ${file} not found` };
  return parseBillingConfig(readFileSync(file, "utf8"));
}

/** The archive must not be inside the instance folder: `delete` removes that folder. */
export function checkArchiveOutside(archiveDir: string, instanceRoot: string): string | null {
  const archive = path.resolve(archiveDir);
  const root = path.resolve(instanceRoot);
  if (archive === root || archive.startsWith(`${root}${path.sep}`)) {
    return `BILLING_ARCHIVE_DIR ${archive} is inside the instance folder ${root}; delete would remove it`;
  }
  return null;
}

type Row = Record<string, unknown>;

export interface BillingExport {
  kind: "gsam-billing-export";
  version: 1;
  code: string;
  /** Day of the newest export of these rows. */
  exportedOn: string;
  retentionYears: number;
  /** exportedOn + retentionYears. After this day the export is due for review, never removed on its own. */
  retentionEndsOn: string;
  counts: { accounts: number; invoices: number };
  accounts: Row[];
  invoices: Row[];
}

/** YYYY-MM-DD, `years` after the day `isoDay`. 29 Feb moves to 28 Feb in a non-leap year. */
export function addYears(isoDay: string, years: number): string {
  const [y, m, d] = isoDay.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** Plain JSON values: timestamps as ISO strings, so a read-back compares equal. */
function plain(rows: Row[]): Row[] {
  return JSON.parse(JSON.stringify(rows)) as Row[];
}

function sortRows(rows: Row[], key: string): Row[] {
  return [...rows].sort((a, b) => String(a[key] ?? a.id).localeCompare(String(b[key] ?? b.id)) || String(a.id).localeCompare(String(b.id)));
}

export function buildBillingExport(input: {
  code: string;
  accounts: Row[];
  invoices: Row[];
  retentionYears: number;
  now: Date;
}): BillingExport {
  const exportedOn = input.now.toISOString().slice(0, 10);
  const accounts = sortRows(plain(input.accounts), "singletonKey");
  const invoices = sortRows(plain(input.invoices), "reference");
  return {
    kind: "gsam-billing-export",
    version: 1,
    code: input.code,
    exportedOn,
    retentionYears: input.retentionYears,
    retentionEndsOn: addYears(exportedOn, input.retentionYears),
    counts: { accounts: accounts.length, invoices: invoices.length },
    accounts,
    invoices,
  };
}

/** Same rows, same file name: the name holds the code and a hash of the rows only. */
export function billingExportFileName(exp: BillingExport): string {
  const hash = createHash("sha256").update(JSON.stringify({ code: exp.code, accounts: exp.accounts, invoices: exp.invoices })).digest("hex");
  return `${exp.code}-billing-${hash.slice(0, 16)}.json`;
}

function serialize(exp: BillingExport): string {
  return `${JSON.stringify(exp, null, 2)}\n`;
}

/** Read an export and check it holds what it says: kind, code and row counts. */
export function readBillingExport(file: string): BillingExport | { error: string } {
  let exp: BillingExport;
  try {
    exp = JSON.parse(readFileSync(file, "utf8")) as BillingExport;
  } catch (err) {
    return { error: `${file} cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (exp?.kind !== "gsam-billing-export" || exp.version !== 1) return { error: `${file} is not a billing export` };
  if (!Array.isArray(exp.accounts) || !Array.isArray(exp.invoices)) return { error: `${file} has no rows` };
  if (exp.accounts.length !== exp.counts?.accounts || exp.invoices.length !== exp.counts?.invoices) {
    return { error: `${file} row counts do not match` };
  }
  return exp;
}

/**
 * Write an export to the archive. A crash leaves no half file (temp file,
 * then rename). Running it again with the same rows gives the same file; a
 * later day moves only exportedOn and retentionEndsOn forward, never back.
 * Different rows give a new file and the old one stays: nothing is lost.
 */
export function writeBillingExport(archiveDir: string, exp: BillingExport): { file: string; changed: boolean } {
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const file = path.join(archiveDir, billingExportFileName(exp));
  let next = exp;
  if (existsSync(file)) {
    const old = readBillingExport(file);
    if (!("error" in old) && old.retentionEndsOn > exp.retentionEndsOn) next = { ...exp, exportedOn: old.exportedOn, retentionEndsOn: old.retentionEndsOn, retentionYears: old.retentionYears };
  }
  const text = serialize(next);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return { file, changed: false };
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return { file, changed: true };
}

/** After writing: the file reads back with the counts the database gave. */
export function verifyBillingExport(file: string, expected: { accounts: number; invoices: number }): string | null {
  const exp = readBillingExport(file);
  if ("error" in exp) return exp.error;
  if (exp.counts.accounts !== expected.accounts || exp.counts.invoices !== expected.invoices) {
    return `${file} holds ${exp.counts.accounts} accounts and ${exp.counts.invoices} invoices; the database has ${expected.accounts} and ${expected.invoices}`;
  }
  return null;
}

/** Every export in the archive; past its retention end it is listed as due for review. Removes nothing. */
export function billingArchiveLines(archiveDir: string, now: Date): string[] {
  if (!existsSync(archiveDir)) return [`billing archive ${archiveDir}: no exports yet`];
  const today = now.toISOString().slice(0, 10);
  const lines: string[] = [];
  let due = 0;
  for (const name of readdirSync(archiveDir).filter((n) => n.endsWith(".json")).sort()) {
    const exp = readBillingExport(path.join(archiveDir, name));
    if ("error" in exp) {
      lines.push(`WARNING: ${exp.error}`);
      continue;
    }
    const past = exp.retentionEndsOn < today;
    if (past) due += 1;
    lines.push(
      `${name}: ${exp.code}, ${exp.counts.accounts} accounts, ${exp.counts.invoices} invoices, exported ${exp.exportedOn}, kept until ${exp.retentionEndsOn}${past ? " - DUE FOR REVIEW (not removed; removal needs an approval reference)" : ""}`,
    );
  }
  if (lines.length === 0) return [`billing archive ${archiveDir}: no exports yet`];
  lines.push(due > 0 ? `${due} export${due === 1 ? "" : "s"} past retention end: due for review` : "no export is past its retention end");
  return lines;
}
