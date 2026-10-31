import { after, test } from "node:test";
import assert from "node:assert/strict";
import { GREATSTONE_COMPANY_ID, validateSourceContract, verifyReadOnlySource } from "./r1-source-contract.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R1_TABLE_COLUMNS } from "./r1-snapshot.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "r1-source-contract-"));
const destination = join(testRoot, "approved");
mkdirSync(destination);
mkdirSync(join(testRoot, "approved-other"));
after(() => rmSync(testRoot, { recursive: true, force: true }));

const contract = () => ({
  schema: "gsam.r1-source-contract/v1", route: "direct-live-read-only", companyId: GREATSTONE_COMPANY_ID,
  sourceRef: "approved-default-2026-10-30", instanceId: "default", dataDirectory: "/operator-confirmed/data",
  operator: "John", approvalRef: "GRE-3269-approved-source", destination,
  deletionOwner: "John", retentionUntil: "2099-01-01T00:00:00Z", role: "r1_reader",
  database: "paperclip", port: 5432,
  coverage: { kind: "source-inventory", checkedAt: "2026-10-30T00:00:00Z", checkedBy: "John",
    method: "source retention and oldest row inventory", allCurrentCompanyIssues: "inventory-issues-1",
    fullSevenDayActivity: "inventory-activity-1", olderRelevantRuns: "inventory-runs-1 without time cutoff",
    runRetentionPolicy: "retention-policy-runs-1", activityRetentionPolicy: "retention-policy-activity-1", complete: true },
});
const options = { companyId: GREATSTONE_COMPANY_ID, sourceRef: "approved-default-2026-10-30", databaseUrl: "postgres://r1_reader@127.0.0.1:5432/paperclip", out: join(destination, "r1-result.json") };

test("source contract fails closed on missing identity, transfer and each coverage proof", () => {
  assert.equal(validateSourceContract(contract(), options).route, "direct-live-read-only");
  for (const field of ["instanceId", "dataDirectory", "operator", "approvalRef", "destination", "deletionOwner", "role", "database", "retentionUntil", "port"]) {
    const broken = contract(); delete broken[field];
    assert.throws(() => validateSourceContract(broken, options), /R1 missing/);
  }
  for (const field of ["checkedAt", "checkedBy", "method", "allCurrentCompanyIssues", "fullSevenDayActivity", "olderRelevantRuns", "runRetentionPolicy", "activityRetentionPolicy", "complete"]) {
    const broken = contract(); delete broken.coverage[field];
    assert.throws(() => validateSourceContract(broken, options), /R1 (missing|source coverage)/);
  }
  assert.throws(() => validateSourceContract(contract(), { ...options, databaseUrl: "postgres://r1_reader@remote:5432/paperclip" }), /loopback/);
  assert.throws(() => validateSourceContract(contract(), { ...options, out: join(testRoot, "approved-other", "r1-result.json") }), /outside approved/);
  assert.throws(() => validateSourceContract(contract(), { ...options, companyId: "c2" }), /Greatstone company/);
  const wrongCompany = contract(); wrongCompany.companyId = "c2";
  assert.throws(() => validateSourceContract(wrongCompany, { ...options, companyId: "c2" }), /Greatstone company/);
});

test("source contract rejects a symlinked output parent outside the approved destination", () => {
  const outside = join(testRoot, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(destination, "link"), "dir");
  assert.throws(() => validateSourceContract(contract(), { ...options, out: join(destination, "link", "r1-result.json") }), /outside approved/);
});

test("source role probe rejects wrong identity, write grants and a writable transaction", async () => {
  const base = { role: "r1_reader", database: "paperclip", port: 5432, readOnly: "on", isolation: "repeatable read",
    defaultReadOnly: "on", roleReadOnlyDefault: true, superuser: false, createRole: false, createDb: false,
    replication: false, bypassRls: false, hasWriteGrant: false };
  const check = (row) => verifyReadOnlySource({ unsafe: async (query) => {
    assert.match(query, /current_user/);
    for (const probe of [/pg_db_role_setting/, /has_database_privilege/, /has_schema_privilege/, /has_table_privilege/, /has_sequence_privilege/, /has_function_privilege/])
      assert.match(query, probe);
    return [row];
  } }, contract());
  await check(base);
  for (const row of [{ ...base, port: 5433 }, { ...base, hasWriteGrant: true }, { ...base, readOnly: "off" },
    { ...base, defaultReadOnly: "off" }, { ...base, roleReadOnlyDefault: false }, { ...base, superuser: true }])
    await assert.rejects(check(row), /R1/);
});

test("operator preflight covers every manifest column and aborts for absent proof", () => {
  const sql = readFileSync(new URL("./r1-source-preflight.sql", import.meta.url), "utf8");
  const manifest = Object.entries(R1_TABLE_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`));
  const checkManifest = (source) => {
    const values = [...source.matchAll(/\('([a-z_]+)','([a-z_]+)'\)/g)].map((match) => `${match[1]}.${match[2]}`);
    assert.deepEqual(values.sort(), manifest.sort());
  };
  checkManifest(sql);
  assert.throws(() => checkManifest(sql.replace("('issues','identifier'),", "")), assert.AssertionError);
  for (const probe of [/has_column_privilege/, /RAISE EXCEPTION 'R1 missing readable manifest columns/, /default_transaction_read_only=on/,
    /has_database_privilege/, /has_schema_privilege/, /has_table_privilege/, /has_sequence_privilege/, /has_function_privilege/])
    assert.match(sql, probe);
});

test("operator SQL reads the reviewed public tables regardless of search_path", () => {
  const sources = ["r1-source-preflight.sql", "r1-snapshot.mjs"].map((file) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
  const tables = Object.keys(R1_TABLE_COLUMNS);
  const check = (source) => {
    for (const table of tables) {
      const reads = [...source.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+((?:\\w+\\.)?${table})\\b`, "gi"))];
      for (const read of reads) assert.equal(read[1].toLowerCase(), `public.${table}`);
    }
  };
  for (const source of sources) check(source);
  assert.throws(() => check(sources[0].replace("FROM public.issues", "FROM issues")), assert.AssertionError);
  assert.throws(() => check(sources[1].replace("from public.issues", "from other.issues")), assert.AssertionError);
});
