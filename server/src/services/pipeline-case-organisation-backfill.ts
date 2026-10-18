// Backfill for GRE-1478, widened to every pipeline by GRE-1538: give every
// existing case an organisation record and copy its contacts across.
// Runs on live only in John's release (scripts/backfill-pipeline-case-organisations.ts).
// Safe to run twice: linked cases are skipped, organisations are matched by
// normalised name and contacts by name and email, so nothing is duplicated.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisationContacts, pipelineCaseContacts, pipelineCases, pipelines } from "@greatstone/db";
import { findOrCreateOrganisation, loadOrganisationNameIndex, normaliseOrganisationName } from "./organisation-match.js";

/** A case whose title matched no record that existed before the run, so the backfill made one (or could not). */
export type UnmatchedCase = {
  caseId: string;
  caseKey: string;
  pipelineKey: string;
  title: string;
  /** The record made for it, or null when the title is blank and the case stays unlinked. */
  createdOrganisationId: string | null;
};

export type CaseOrganisationBackfillResult = {
  pipelines: number;
  casesLinked: number;
  organisationsCreated: number;
  contactsCopied: number;
  unmatched: UnmatchedCase[];
  dryRun: boolean;
};

class DryRunRollback extends Error {}

function readCountry(fields: Record<string, unknown> | null) {
  const value = fields?.country;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function backfillCaseOrganisations(
  db: Db,
  input: { companyId: string; pipelineKeys?: string[]; dryRun?: boolean },
): Promise<CaseOrganisationBackfillResult> {
  const result: CaseOrganisationBackfillResult = {
    pipelines: 0,
    casesLinked: 0,
    organisationsCreated: 0,
    contactsCopied: 0,
    unmatched: [],
    dryRun: Boolean(input.dryRun),
  };

  try {
    await db.transaction(async (tx) => {
      const targets = await tx
        .select({ id: pipelines.id, key: pipelines.key })
        .from(pipelines)
        .where(and(
          eq(pipelines.companyId, input.companyId),
          input.pipelineKeys?.length ? inArray(pipelines.key, input.pipelineKeys) : undefined,
        ));
      result.pipelines = targets.length;
      if (targets.length === 0) return;
      const pipelineKeyById = new Map(targets.map((row) => [row.id, row.key]));

      const nameIndex = await loadOrganisationNameIndex(tx, input.companyId);
      const cases = await tx
        .select({
          id: pipelineCases.id,
          caseKey: pipelineCases.caseKey,
          pipelineId: pipelineCases.pipelineId,
          title: pipelineCases.title,
          fields: pipelineCases.fields,
        })
        .from(pipelineCases)
        .where(and(
          eq(pipelineCases.companyId, input.companyId),
          inArray(pipelineCases.pipelineId, targets.map((row) => row.id)),
          isNull(pipelineCases.organisationId),
          isNull(pipelineCases.retiredAt),
        ))
        .orderBy(pipelineCases.createdAt);

      // Cards linked to a record this run made did not match an existing one.
      const createdIds = new Set<string>();
      for (const caseRow of cases) {
        const organisation = await findOrCreateOrganisation(
          tx,
          { companyId: input.companyId, name: caseRow.title, country: readCountry(caseRow.fields), status: "prospect" },
          nameIndex,
        );
        if (organisation?.created) createdIds.add(organisation.id);
        if (!organisation || createdIds.has(organisation.id)) {
          result.unmatched.push({
            caseId: caseRow.id,
            caseKey: caseRow.caseKey,
            pipelineKey: pipelineKeyById.get(caseRow.pipelineId) ?? "",
            title: caseRow.title,
            createdOrganisationId: organisation?.id ?? null,
          });
        }
        if (!organisation) continue;
        if (organisation.created) result.organisationsCreated += 1;
        const organisationId = organisation.id;
        await tx
          .update(pipelineCases)
          .set({ organisationId })
          .where(and(eq(pipelineCases.id, caseRow.id), isNull(pipelineCases.organisationId)));
        result.casesLinked += 1;

        const caseContacts = await tx
          .select()
          .from(pipelineCaseContacts)
          .where(and(eq(pipelineCaseContacts.companyId, input.companyId), eq(pipelineCaseContacts.caseId, caseRow.id)));
        if (caseContacts.length === 0) continue;
        const orgContacts = await tx
          .select({ name: organisationContacts.name, email: organisationContacts.email })
          .from(organisationContacts)
          .where(eq(organisationContacts.organisationId, organisationId));
        const contactKey = (name: string | null, email: string | null) =>
          `${normaliseOrganisationName(name)}|${normaliseOrganisationName(email)}`;
        const seen = new Set(orgContacts.map((row) => contactKey(row.name, row.email)));
        for (const contact of caseContacts) {
          const key = contactKey(contact.name, contact.email);
          if (seen.has(key)) continue;
          seen.add(key);
          await tx.insert(organisationContacts).values({
            companyId: input.companyId,
            organisationId,
            name: contact.name,
            role: contact.role,
            email: contact.email,
            phone: contact.phone,
            source: "manual",
            createdByUserId: contact.createdByUserId,
            createdByAgentId: contact.createdByAgentId,
          });
          result.contactsCopied += 1;
        }
      }

      if (input.dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return result;
}
