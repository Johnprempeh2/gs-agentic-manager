import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import { cases } from "@greatstone/db";
import { DEEP_DIVE_CASE_TYPES, type DeepDiveScope } from "@greatstone/shared";
import { badRequest, notFound } from "../errors.js";

// One Deep Dive per client engagement (GRE-4430). Every Deep Dive read and
// write runs in a scope: the company and one client's deep_dive record case.
// A list in one scope never returns another Deep Dive's rows.

export type { DeepDiveScope };

/** Rows of this Deep Dive only. */
export function inRecord(table: { companyId: AnyPgColumn; recordCaseId: AnyPgColumn }, scope: DeepDiveScope): SQL {
  return and(eq(table.companyId, scope.companyId), eq(table.recordCaseId, scope.recordCaseId))!;
}

/** The record case behind a scope, refused unless it is a Deep Dive of this company. */
export async function loadDeepDiveRecord(db: Db, companyId: string, recordCaseId: string) {
  const record = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, recordCaseId), eq(cases.companyId, companyId), eq(cases.caseType, DEEP_DIVE_CASE_TYPES.record)))
    .then((rows) => rows[0] ?? null);
  if (!record) throw notFound("Deep Dive not found");
  return record;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The scope a company-level request names with ?recordId=, checked against the company. */
export async function resolveDeepDiveScope(db: Db, companyId: string, recordId: unknown): Promise<DeepDiveScope> {
  if (typeof recordId !== "string" || !UUID_RE.test(recordId)) {
    throw badRequest("Name the Deep Dive: recordId is needed");
  }
  await loadDeepDiveRecord(db, companyId, recordId);
  return { companyId, recordCaseId: recordId };
}

/** Scope of a row read by id; rows older than per-client records have none and are out of every scope. */
export function scopeOfRow(row: { companyId: string; recordCaseId: string | null }, label: string): DeepDiveScope {
  if (!row.recordCaseId) throw notFound(`${label} not found`);
  return { companyId: row.companyId, recordCaseId: row.recordCaseId };
}
