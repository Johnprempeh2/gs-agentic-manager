import { randomUUID } from "node:crypto";
import { cases, type createDb } from "@greatstone/db";

// One client's Deep Dive record case for tests (GRE-4430). Every Deep Dive
// list and write is scoped to a record, so tests seed one per company.

type Db = ReturnType<typeof createDb>;

const records = new Map<string, string>();

export async function seedDeepDiveRecord(db: Db, companyId: string, clientCaseId: string | null = null): Promise<string> {
  const [record] = await db.insert(cases).values({
    companyId,
    caseNumber: Math.floor(Math.random() * 1_000_000_000),
    identifier: `DDR-${randomUUID()}`,
    caseType: "deep_dive",
    key: `dd:${randomUUID()}`,
    title: "Deep Dive",
    clientCaseId,
    fields: { workstreams: [], status: "active" },
  }).returning();
  if (!records.has(companyId)) records.set(companyId, record!.id);
  return record!.id;
}

/** The first record seeded for a company. */
export function recordOf(companyId: string): string {
  const id = records.get(companyId);
  if (!id) throw new Error(`No Deep Dive record seeded for company ${companyId}`);
  return id;
}

/** `?recordId=` for a company-level Deep Dive URL. */
export function rq(companyId: string): string {
  return `recordId=${recordOf(companyId)}`;
}
