import { test } from "node:test";
import assert from "node:assert/strict";
import { GREATSTONE_COMPANY_ID, validateSourceContract, verifyReadOnlySource } from "./r1-source-contract.mjs";

const contract = () => ({
  schema: "gsam.r1-source-contract/v1", route: "direct-live-read-only", companyId: GREATSTONE_COMPANY_ID,
  sourceRef: "approved-default-2026-10-30", instanceId: "default", dataDirectory: "/operator-confirmed/data",
  operator: "John", approvalRef: "GRE-3269-approved-source", destination: "/approved/results",
  deletionOwner: "John", retentionUntil: "2099-01-01T00:00:00Z", role: "r1_reader",
  database: "paperclip", port: 5432,
  coverage: { kind: "source-inventory", checkedAt: "2026-10-30T00:00:00Z", checkedBy: "John",
    method: "source retention and oldest row inventory", allCurrentCompanyIssues: "inventory-issues-1",
    fullSevenDayActivity: "inventory-activity-1", olderRelevantRuns: "inventory-runs-1 without time cutoff",
    runRetentionPolicy: "retention-policy-runs-1", activityRetentionPolicy: "retention-policy-activity-1", complete: true },
});
const options = { companyId: GREATSTONE_COMPANY_ID, sourceRef: "approved-default-2026-10-30", databaseUrl: "postgres://r1_reader@127.0.0.1:5432/paperclip", out: "/approved/results/r1-result.json" };

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
  assert.throws(() => validateSourceContract(contract(), { ...options, out: "/approved/results-other/r1-result.json" }), /outside approved/);
  assert.throws(() => validateSourceContract(contract(), { ...options, companyId: "c2" }), /Greatstone company/);
  const wrongCompany = contract(); wrongCompany.companyId = "c2";
  assert.throws(() => validateSourceContract(wrongCompany, { ...options, companyId: "c2" }), /Greatstone company/);
});

test("source role probe rejects wrong identity, write grants and a writable transaction", async () => {
  const base = { role: "r1_reader", database: "paperclip", port: 5432, readOnly: "on", isolation: "repeatable read",
    superuser: false, createRole: false, createDb: false, replication: false, bypassRls: false, hasWriteGrant: false };
  const check = (row) => verifyReadOnlySource({ unsafe: async (query) => {
    assert.match(query, /current_user/);
    assert.match(query, /has_table_privilege/);
    return [row];
  } }, contract());
  await check(base);
  for (const row of [{ ...base, port: 5433 }, { ...base, hasWriteGrant: true }, { ...base, readOnly: "off" }, { ...base, superuser: true }])
    await assert.rejects(check(row), /R1/);
});
