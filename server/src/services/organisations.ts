import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisationContacts, organisations, pipelineCases, pipelineStages, pipelines } from "@greatstone/db";
import type {
  ListOrganisationsQuery,
  Organisation,
  OrganisationContact,
  OrganisationDetail,
  OrganisationListItem,
  OrganisationPipelineStage,
  OrganisationSource,
  OrganisationStatus,
} from "@greatstone/shared";
import { conflict } from "../errors.js";

type OrganisationRow = typeof organisations.$inferSelect;
type ContactRow = typeof organisationContacts.$inferSelect;

export type OrganisationActor = { userId: string | null; agentId: string | null };

export type OrganisationInput = {
  name: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  countryOwner: string | null;
  status: OrganisationStatus;
  notes: string | null;
  source: OrganisationSource;
  externalId?: string | null;
};

export type OrganisationPatch = Partial<Omit<OrganisationInput, "source" | "externalId">> & { archived?: false };

export type OrganisationContactInput = {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isKeyContact: boolean;
  source: OrganisationSource;
  externalId?: string | null;
};

export type OrganisationContactPatch = Partial<Omit<OrganisationContactInput, "source" | "externalId">> & {
  archived?: false;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toOrganisation(row: OrganisationRow): Organisation {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    website: row.website,
    industry: row.industry,
    country: row.country,
    countryOwner: row.countryOwner,
    status: row.status as OrganisationStatus,
    notes: row.notes,
    source: row.source as OrganisationSource,
    externalId: row.externalId,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toContact(row: ContactRow): OrganisationContact {
  return {
    id: row.id,
    companyId: row.companyId,
    organisationId: row.organisationId,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    isKeyContact: row.isKeyContact,
    source: row.source as OrganisationSource,
    externalId: row.externalId,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Escapes LIKE wildcards so a search for "100%" matches the text. */
function likePattern(text: string) {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Drizzle wraps driver errors, so look at the cause too. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: string }).code === "23505") return true;
  return isUniqueViolation((error as { cause?: unknown }).cause);
}

/**
 * CRM organisations (GRE-1477). Every read and write takes the company id so
 * one company never sees another's records; routes check the caller first.
 */
export function organisationService(db: Db) {
  async function getRow(companyId: string, id: string) {
    return db
      .select()
      .from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.id, id)))
      .then((rows) => rows[0] ?? null);
  }

  async function getContactRow(companyId: string, organisationId: string, contactId: string) {
    return db
      .select()
      .from(organisationContacts)
      .where(
        and(
          eq(organisationContacts.companyId, companyId),
          eq(organisationContacts.organisationId, organisationId),
          eq(organisationContacts.id, contactId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /** Where each organisation is now: its live cases in pipelines that are not archived (GRE-1540). */
  async function pipelineStagesFor(companyId: string, organisationIds: string[]) {
    const rows = await db
      .select({
        organisationId: pipelineCases.organisationId,
        caseId: pipelineCases.id,
        caseKey: pipelineCases.caseKey,
        pipelineId: pipelineCases.pipelineId,
        pipelineName: pipelines.name,
        stageId: pipelineCases.stageId,
        stageName: pipelineStages.name,
        stageKind: pipelineStages.kind,
        terminalKind: pipelineCases.terminalKind,
      })
      .from(pipelineCases)
      .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .where(
        and(
          eq(pipelineCases.companyId, companyId),
          eq(pipelines.companyId, companyId),
          inArray(pipelineCases.organisationId, organisationIds),
          isNull(pipelineCases.retiredAt),
          isNull(pipelines.archivedAt),
        ),
      )
      .orderBy(asc(sql`lower(${pipelines.name})`), asc(pipelineStages.position), asc(pipelineCases.caseKey));
    const byOrganisation = new Map<string, OrganisationPipelineStage[]>();
    for (const { organisationId, terminalKind, ...stage } of rows) {
      if (!organisationId) continue;
      const list = byOrganisation.get(organisationId) ?? [];
      list.push({ ...stage, terminalKind: terminalKind as OrganisationPipelineStage["terminalKind"] });
      byOrganisation.set(organisationId, list);
    }
    return byOrganisation;
  }

  return {
    async list(companyId: string, query: ListOrganisationsQuery): Promise<OrganisationListItem[]> {
      const conditions: SQL[] = [eq(organisations.companyId, companyId)];
      if (!query.includeArchived) conditions.push(isNull(organisations.archivedAt));
      if (query.status) conditions.push(eq(organisations.status, query.status));
      if (query.pipelineId || query.stageId) {
        // A live case (not retired, pipeline not archived) in the chosen pipeline and stage.
        conditions.push(
          sql`exists (select 1 from ${pipelineCases}
            inner join ${pipelines} on ${pipelines.id} = ${pipelineCases.pipelineId}
            where ${pipelineCases.organisationId} = ${organisations.id}
              and ${pipelineCases.companyId} = ${companyId}
              and ${pipelineCases.retiredAt} is null
              and ${pipelines.archivedAt} is null
              ${query.pipelineId ? sql`and ${pipelineCases.pipelineId} = ${query.pipelineId}` : sql``}
              ${query.stageId ? sql`and ${pipelineCases.stageId} = ${query.stageId}` : sql``})`,
        );
      }
      if (query.q) {
        const pattern = likePattern(query.q);
        // Search the organisation's own fields and the names of its live contacts.
        conditions.push(
          or(
            ilike(organisations.name, pattern),
            ilike(organisations.industry, pattern),
            ilike(organisations.country, pattern),
            ilike(organisations.countryOwner, pattern),
            sql`exists (select 1 from ${organisationContacts}
              where ${organisationContacts.organisationId} = ${organisations.id}
                and ${organisationContacts.archivedAt} is null
                and ${organisationContacts.name} ilike ${pattern})`,
          )!,
        );
      }
      const rows = await db
        .select()
        .from(organisations)
        .where(and(...conditions))
        .orderBy(asc(sql`lower(${organisations.name})`), asc(organisations.id));
      if (rows.length === 0) return [];

      const contacts = await db
        .select()
        .from(organisationContacts)
        .where(
          and(
            eq(organisationContacts.companyId, companyId),
            inArray(organisationContacts.organisationId, rows.map((row) => row.id)),
            isNull(organisationContacts.archivedAt),
          ),
        )
        .orderBy(desc(organisationContacts.isKeyContact), asc(organisationContacts.name));
      const stages = await pipelineStagesFor(companyId, rows.map((row) => row.id));
      const byOrganisation = new Map<string, ContactRow[]>();
      for (const contact of contacts) {
        const list = byOrganisation.get(contact.organisationId) ?? [];
        list.push(contact);
        byOrganisation.set(contact.organisationId, list);
      }

      return rows.map((row) => {
        const own = byOrganisation.get(row.id) ?? [];
        return {
          ...toOrganisation(row),
          keyContacts: own
            .filter((contact) => contact.isKeyContact)
            .map(({ id, name, role, email, phone }) => ({ id, name, role, email, phone })),
          contactCount: own.length,
          pipelines: stages.get(row.id) ?? [],
        };
      });
    },

    async getDetail(companyId: string, id: string): Promise<OrganisationDetail | null> {
      const row = await getRow(companyId, id);
      if (!row) return null;
      const contacts = await db
        .select()
        .from(organisationContacts)
        .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.organisationId, id)))
        .orderBy(desc(organisationContacts.isKeyContact), asc(organisationContacts.name));
      return { ...toOrganisation(row), contacts: contacts.map(toContact) };
    },

    async create(companyId: string, input: OrganisationInput, actor: OrganisationActor): Promise<Organisation> {
      try {
        const [row] = await db
          .insert(organisations)
          .values({
            companyId,
            ...input,
            externalId: input.externalId ?? null,
            createdByUserId: actor.userId,
            createdByAgentId: actor.agentId,
          })
          .returning();
        return toOrganisation(row!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("An organisation with this source and external id already exists");
        }
        throw error;
      }
    },

    async update(companyId: string, id: string, patch: OrganisationPatch): Promise<Organisation | null> {
      const { archived, ...fields } = patch;
      const [row] = await db
        .update(organisations)
        .set({ ...fields, ...(archived === false ? { archivedAt: null } : {}), updatedAt: new Date() })
        .where(and(eq(organisations.companyId, companyId), eq(organisations.id, id)))
        .returning();
      return row ? toOrganisation(row) : null;
    },

    /** Archive hides the organisation from the list. Its contacts stay, so restore brings them back. */
    async archive(companyId: string, id: string): Promise<Organisation | null> {
      const now = new Date();
      const [row] = await db
        .update(organisations)
        .set({ archivedAt: sql`coalesce(${organisations.archivedAt}, now())`, updatedAt: now })
        .where(and(eq(organisations.companyId, companyId), eq(organisations.id, id)))
        .returning();
      return row ? toOrganisation(row) : null;
    },

    async createContact(
      companyId: string,
      organisationId: string,
      input: OrganisationContactInput,
      actor: OrganisationActor,
    ): Promise<OrganisationContact> {
      try {
        const [row] = await db
          .insert(organisationContacts)
          .values({
            companyId,
            organisationId,
            ...input,
            externalId: input.externalId ?? null,
            createdByUserId: actor.userId,
            createdByAgentId: actor.agentId,
          })
          .returning();
        return toContact(row!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("A contact with this source and external id already exists");
        }
        throw error;
      }
    },

    async updateContact(
      companyId: string,
      organisationId: string,
      contactId: string,
      patch: OrganisationContactPatch,
    ): Promise<OrganisationContact | null> {
      if (!(await getContactRow(companyId, organisationId, contactId))) return null;
      const { archived, ...fields } = patch;
      const [row] = await db
        .update(organisationContacts)
        .set({ ...fields, ...(archived === false ? { archivedAt: null } : {}), updatedAt: new Date() })
        .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.id, contactId)))
        .returning();
      return row ? toContact(row) : null;
    },

    async archiveContact(companyId: string, organisationId: string, contactId: string): Promise<OrganisationContact | null> {
      if (!(await getContactRow(companyId, organisationId, contactId))) return null;
      const now = new Date();
      const [row] = await db
        .update(organisationContacts)
        .set({ archivedAt: sql`coalesce(${organisationContacts.archivedAt}, now())`, updatedAt: now })
        .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.id, contactId)))
        .returning();
      return row ? toContact(row) : null;
    },
  };
}
