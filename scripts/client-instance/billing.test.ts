// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/billing.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  addYears,
  billingArchiveLines,
  buildBillingExport,
  checkArchiveOutside,
  loadBillingConfig,
  parseBillingConfig,
  readBillingExport,
  verifyBillingExport,
  writeBillingExport,
} from "./billing.js";

const base = mkdtempSync(path.join(process.env.GSAM_RUN_SCRATCH_DIR ?? tmpdir(), "billing-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const ACCOUNT = { id: "a1", singletonKey: "default", planKind: "office", currency: "GBP", serviceFeeCents: 100, updatedAt: new Date("2026-10-01T09:00:00Z") };
const INVOICES = [
  { id: "i2", reference: "INV-002", amountCents: 200, currency: "GBP", status: "paid", issuedOn: "2026-09-01" },
  { id: "i1", reference: "INV-001", amountCents: 100, currency: "GBP", status: "paid", issuedOn: "2026-08-01" },
];
const DAY = new Date("2026-10-11T18:00:00Z");

test("the retention period is a setting: missing or bad values are refused, never guessed", () => {
  assert.deepEqual(parseBillingConfig("BILLING_ARCHIVE_DIR=/srv/billing\nBILLING_RETENTION_YEARS=6\n"), { archiveDir: "/srv/billing", retentionYears: 6 });
  assert.deepEqual(parseBillingConfig("# D8\nBILLING_ARCHIVE_DIR='/srv/billing'\nBILLING_RETENTION_YEARS=\"10\"\n"), { archiveDir: "/srv/billing", retentionYears: 10 });
  assert.match((parseBillingConfig("BILLING_ARCHIVE_DIR=/srv/billing\n") as { error: string }).error, /billing retention not set/);
  assert.match((parseBillingConfig("BILLING_RETENTION_YEARS=6\n") as { error: string }).error, /BILLING_ARCHIVE_DIR is missing/);
  assert.match((parseBillingConfig("BILLING_ARCHIVE_DIR=billing\nBILLING_RETENTION_YEARS=6\n") as { error: string }).error, /absolute/);
  for (const bad of ["0", "-1", "6.5", "six", "100"]) {
    assert.match((parseBillingConfig(`BILLING_ARCHIVE_DIR=/srv/b\nBILLING_RETENTION_YEARS=${bad}\n`) as { error: string }).error, /whole number/);
  }
  assert.match((parseBillingConfig("BILLING_ARCHIVE_DIR=/srv/b\nBILLING_RETENTION_YEARS=6\nOTHER=1\n") as { error: string }).error, /not a billing setting/);
  assert.match((loadBillingConfig(path.join(base, "missing.env")) as { error: string }).error, /not found/);
});

test("no retention value is written in the code", () => {
  const source = readFileSync(new URL("./billing.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /retentionYears\s*[:=]\s*\d/);
  assert.doesNotMatch(source, /RETENTION_YEARS\s*=\s*\d/);
});

test("the archive must be outside the instance folder", () => {
  assert.equal(checkArchiveOutside("/srv/billing", "/srv/instances/c001"), null);
  assert.equal(checkArchiveOutside("/srv/instances/c001-billing", "/srv/instances/c001"), null);
  assert.match(checkArchiveOutside("/srv/instances/c001/billing", "/srv/instances/c001")!, /delete would remove it/);
  assert.match(checkArchiveOutside("/srv/instances/c001", "/srv/instances/c001")!, /inside the instance folder/);
});

test("retention end is the export day plus the set years", () => {
  assert.equal(addYears("2026-10-11", 6), "2032-10-11");
  assert.equal(addYears("2028-02-29", 1), "2029-02-28");
  const exp = buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: DAY });
  assert.equal(exp.exportedOn, "2026-10-11");
  assert.equal(exp.retentionEndsOn, "2032-10-11");
  assert.deepEqual(exp.counts, { accounts: 1, invoices: 2 });
  assert.deepEqual(exp.invoices.map((i) => i.reference), ["INV-001", "INV-002"]);
  assert.equal(exp.accounts[0]!.updatedAt, "2026-10-01T09:00:00.000Z");
});

test("export twice: the same file, unchanged; private to the owner", () => {
  const dir = path.join(base, "twice");
  const first = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: DAY }));
  const bytes = readFileSync(first.file, "utf8");
  // Rows come back in another order: still the same export.
  const second = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: [...INVOICES].reverse(), retentionYears: 6, now: DAY }));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.file, first.file);
  assert.equal(readFileSync(second.file, "utf8"), bytes);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [path.basename(first.file)]);
  assert.equal(verifyBillingExport(first.file, { accounts: 1, invoices: 2 }), null);
  assert.match(verifyBillingExport(first.file, { accounts: 1, invoices: 3 })!, /database has 1 and 3/);
});

test("a later export of the same rows moves the retention end forward, never back", () => {
  const dir = path.join(base, "later");
  const first = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: DAY }));
  const later = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: new Date("2027-01-05T00:00:00Z") }));
  assert.equal(later.file, first.file);
  assert.equal((readBillingExport(later.file) as { retentionEndsOn: string }).retentionEndsOn, "2033-01-05");
  // A shorter setting later never cuts an end already written.
  const shorter = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 1, now: new Date("2027-02-01T00:00:00Z") }));
  assert.equal(shorter.changed, false);
  assert.equal((readBillingExport(shorter.file) as { retentionEndsOn: string }).retentionEndsOn, "2033-01-05");
});

test("new rows give a new file and the old export stays", () => {
  const dir = path.join(base, "grow");
  const first = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES.slice(0, 1), retentionYears: 6, now: DAY }));
  const second = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: DAY }));
  assert.notEqual(second.file, first.file);
  assert.equal(readdirSync(dir).length, 2);
});

test("a damaged export fails verify", () => {
  const file = path.join(base, "damaged.json");
  const exp = buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: DAY });
  writeFileSync(file, JSON.stringify({ ...exp, invoices: exp.invoices.slice(1) }));
  assert.match(verifyBillingExport(file, { accounts: 1, invoices: 2 })!, /row counts do not match/);
  writeFileSync(file, "{not json");
  assert.match(verifyBillingExport(file, { accounts: 1, invoices: 2 })!, /cannot be read/);
});

test("past retention end: listed as due for review, not removed", () => {
  const dir = path.join(base, "review");
  const old = writeBillingExport(dir, buildBillingExport({ code: "c001", accounts: [ACCOUNT], invoices: INVOICES, retentionYears: 6, now: new Date("2019-01-01T00:00:00Z") }));
  writeBillingExport(dir, buildBillingExport({ code: "c002", accounts: [ACCOUNT], invoices: [], retentionYears: 6, now: DAY }));
  const lines = billingArchiveLines(dir, DAY);
  const c001 = lines.find((l) => l.includes("c001,"))!;
  const c002 = lines.find((l) => l.includes("c002,"))!;
  assert.match(c001, /kept until 2025-01-01 - DUE FOR REVIEW \(not removed/);
  assert.doesNotMatch(c002, /DUE FOR REVIEW/);
  assert.equal(lines.at(-1), "1 export past retention end: due for review");
  assert.equal(readdirSync(dir).length, 2);
  assert.ok(statSync(old.file).isFile());
  assert.deepEqual(billingArchiveLines(path.join(base, "none"), DAY), [`billing archive ${path.join(base, "none")}: no exports yet`]);
});
