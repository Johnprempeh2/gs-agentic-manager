// Find or create the organisation record a card is about (GRE-1538). Used by
// the backfill and the Pipedrive deal import, so every card in every pipeline
// ends linked to one record and names that differ only in case or spacing
// share it.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisations } from "@greatstone/db";
import type { OrganisationStatus } from "@greatstone/shared";

type OrganisationDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** "  ACME   Ltd " and "acme ltd" are the same organisation. */
export function normaliseOrganisationName(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Live organisations of a company by normalised name; the oldest wins a tie. */
export async function loadOrganisationNameIndex(db: OrganisationDb, companyId: string) {
  const rows = await db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(and(eq(organisations.companyId, companyId), isNull(organisations.archivedAt)))
    .orderBy(organisations.createdAt);
  const index = new Map<string, string>();
  for (const row of rows) {
    const key = normaliseOrganisationName(row.name);
    if (key && !index.has(key)) index.set(key, row.id);
  }
  return index;
}

export type FindOrCreateOrganisationInput = {
  companyId: string;
  name: string;
  country?: string | null;
  status?: OrganisationStatus;
  /** A Pipedrive organisation id: matched first, and stored on a new record. */
  pipedriveId?: string | null;
};

export async function findOrCreateOrganisation(
  db: OrganisationDb,
  input: FindOrCreateOrganisationInput,
  nameIndex?: Map<string, string>,
): Promise<{ id: string; created: boolean } | null> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const key = normaliseOrganisationName(name);
  if (!key) return null;

  if (input.pipedriveId) {
    const linked = await db
      .select({ id: organisations.id })
      .from(organisations)
      .where(and(
        eq(organisations.companyId, input.companyId),
        eq(organisations.source, "pipedrive"),
        eq(organisations.externalId, input.pipedriveId),
        isNull(organisations.archivedAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (linked) return { id: linked.id, created: false };
  }

  const index = nameIndex ?? (await loadOrganisationNameIndex(db, input.companyId));
  const existing = index.get(key);
  if (existing) return { id: existing, created: false };

  const [created] = await db
    .insert(organisations)
    .values({
      companyId: input.companyId,
      name,
      country: input.country ?? null,
      status: input.status ?? "prospect",
      source: input.pipedriveId ? "pipedrive" : "manual",
      externalId: input.pipedriveId ?? null,
    })
    // An archived record can hold the same Pipedrive id; then fall back to a manual record.
    .onConflictDoNothing()
    .returning({ id: organisations.id });
  if (!created) {
    return findOrCreateOrganisation(db, { ...input, pipedriveId: null }, index);
  }
  index.set(key, created.id);
  return { id: created.id, created: true };
}
