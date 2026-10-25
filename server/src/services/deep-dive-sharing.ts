import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { cases, pipelineCases } from "@greatstone/db";
import { DEEP_DIVE_CASE_TYPES } from "@greatstone/shared";
import { notFound } from "../errors.js";

// Deep Dive sharing (GRE-2366). Every Deep Dive item is Internal unless a
// person sets Shared. The only way client-facing code reads items is
// listSharedDeepDiveItemsForClient, and the only way it writes them is
// withDeepDiveClientWrite: inside it the cases_guard_writes trigger (migration
// 0394) lets the client change only the unlocked fields of its own Shared items.

type DeepDiveClientTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DEEP_DIVE_TYPES = Object.values(DEEP_DIVE_CASE_TYPES);

export type DeepDiveClientScope = { companyId: string; clientCaseId: string };

/** What a client may see of a Shared item: no internal ids, authors or source rows. */
export interface SharedDeepDiveItem {
  id: string;
  caseType: string;
  key: string | null;
  title: string;
  summary: string | null;
  status: string;
  fields: Record<string, unknown>;
  parentCaseId: string | null;
  clientEditableFields: string[];
  updatedAt: string;
}

/** Shared Deep Dive items of one client in one company. Internal items never come back. */
export async function listSharedDeepDiveItemsForClient(
  db: Db,
  scope: DeepDiveClientScope,
): Promise<SharedDeepDiveItem[]> {
  const rows = await db
    .select({
      id: cases.id,
      caseType: cases.caseType,
      key: cases.key,
      title: cases.title,
      summary: cases.summary,
      status: cases.status,
      fields: cases.fields,
      parentCaseId: cases.parentCaseId,
      clientEditableFields: cases.clientEditableFields,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(and(
      eq(cases.companyId, scope.companyId),
      eq(cases.clientCaseId, scope.clientCaseId),
      eq(cases.visibility, "shared"),
      inArray(cases.caseType, DEEP_DIVE_TYPES),
    ))
    .orderBy(asc(cases.caseNumber));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

/**
 * Run `fn` as the client: a transaction in which the database refuses any
 * write to cases except the unlocked fields of this client's Shared items.
 * The setting is transaction-local, so it never leaks to a pooled connection.
 */
export async function withDeepDiveClientWrite<T>(
  db: Db,
  scope: DeepDiveClientScope,
  fn: (tx: DeepDiveClientTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const client = await tx
      .select({ id: pipelineCases.id })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.id, scope.clientCaseId), eq(pipelineCases.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!client) throw notFound("Client not found");
    await tx.execute(sql`select
      set_config('gsam.actor_role', 'client', true),
      set_config('gsam.client_case_id', ${scope.clientCaseId}, true)`);
    return fn(tx);
  });
}
