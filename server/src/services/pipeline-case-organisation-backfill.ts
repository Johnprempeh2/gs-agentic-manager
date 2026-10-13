// Backfill for GRE-1478: give every existing client case an organisation
// record, copy its contacts across, and switch the rule on for the pipeline.
// Runs on live only in John's release (scripts/backfill-pipeline-case-organisations.ts).
// Safe to run twice: linked cases are skipped, organisations are matched by
// name and contacts by name and email, so nothing is duplicated.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisationContacts, organisations, pipelineCaseContacts, pipelineCases, pipelines } from "@greatstone/db";

export const DEFAULT_ORGANISATION_PIPELINE_KEYS = ["client-journey"];

export type CaseOrganisationBackfillResult = {
  pipelines: number;
  casesLinked: number;
  organisationsCreated: number;
  contactsCopied: number;
  dryRun: boolean;
};

class DryRunRollback extends Error {}

const normalise = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

function readCountry(fields: Record<string, unknown> | null) {
  const value = fields?.country;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function backfillCaseOrganisations(
  db: Db,
  input: { companyId: string; pipelineKeys?: string[]; dryRun?: boolean },
): Promise<CaseOrganisationBackfillResult> {
  const pipelineKeys = input.pipelineKeys?.length ? input.pipelineKeys : DEFAULT_ORGANISATION_PIPELINE_KEYS;
  const result: CaseOrganisationBackfillResult = {
    pipelines: 0,
    casesLinked: 0,
    organisationsCreated: 0,
    contactsCopied: 0,
    dryRun: Boolean(input.dryRun),
  };

  try {
    await db.transaction(async (tx) => {
      const targets = await tx
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.companyId, input.companyId), inArray(pipelines.key, pipelineKeys)));
      result.pipelines = targets.length;
      if (targets.length === 0) return;

      const orgByName = new Map<string, string>();
      const existingOrgs = await tx
        .select({ id: organisations.id, name: organisations.name })
        .from(organisations)
        .where(and(eq(organisations.companyId, input.companyId), isNull(organisations.archivedAt)));
      for (const org of existingOrgs) {
        if (!orgByName.has(normalise(org.name))) orgByName.set(normalise(org.name), org.id);
      }

      const cases = await tx
        .select({ id: pipelineCases.id, title: pipelineCases.title, fields: pipelineCases.fields })
        .from(pipelineCases)
        .where(and(
          eq(pipelineCases.companyId, input.companyId),
          inArray(pipelineCases.pipelineId, targets.map((row) => row.id)),
          isNull(pipelineCases.organisationId),
          isNull(pipelineCases.retiredAt),
        ));

      for (const caseRow of cases) {
        const key = normalise(caseRow.title);
        let organisationId = orgByName.get(key) ?? null;
        if (!organisationId) {
          const [created] = await tx
            .insert(organisations)
            .values({
              companyId: input.companyId,
              name: caseRow.title.trim(),
              country: readCountry(caseRow.fields),
              status: "client",
              source: "manual",
            })
            .returning({ id: organisations.id });
          organisationId = created!.id;
          orgByName.set(key, organisationId);
          result.organisationsCreated += 1;
        }
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
        const seen = new Set(orgContacts.map((row) => `${normalise(row.name)}|${normalise(row.email)}`));
        for (const contact of caseContacts) {
          const contactKey = `${normalise(contact.name)}|${normalise(contact.email)}`;
          if (seen.has(contactKey)) continue;
          seen.add(contactKey);
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

      // Every case is linked now, so the rule can go on without blocking edits.
      await tx
        .update(pipelines)
        .set({ requiresOrganisation: true, updatedAt: new Date() })
        .where(inArray(pipelines.id, targets.map((row) => row.id)));

      if (input.dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return result;
}
