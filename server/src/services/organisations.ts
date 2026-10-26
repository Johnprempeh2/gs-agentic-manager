import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  authUsers,
  companyMemberships,
  organisationContacts,
  organisations,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@greatstone/db";
import type {
  OrganisationPerson,
  ListOrganisationsQuery,
  Organisation,
  OrganisationContact,
  OrganisationDetail,
  OrganisationListItem,
  OrganisationOwnershipType,
  OrganisationPipelineStage,
  OrganisationSizeBand,
  OrganisationSource,
  OrganisationStatus,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../errors.js";

type OrganisationRow = typeof organisations.$inferSelect;
type ContactRow = typeof organisationContacts.$inferSelect;

export type OrganisationActor = { userId: string | null; agentId: string | null };

/** Global CRM fields (GRE-1539). Optional on create; the validator turns blanks into null. */
export type OrganisationCrmFields = {
  legalName: string | null;
  domain: string | null;
  phone: string | null;
  email: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  employeeCount: number | null;
  sizeBand: OrganisationSizeBand | null;
  annualRevenue: number | null;
  annualRevenueCurrency: string | null;
  ownershipType: OrganisationOwnershipType | null;
  parentOrganisationId: string | null;
  linkedinUrl: string | null;
  accountOwnerUserId: string | null;
  accountOwnerAgentId: string | null;
  segment: string | null;
  tags: string[];
  description: string | null;
  registrationNumber: string | null;
  taxId: string | null;
};

export type OrganisationInput = {
  name: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  countryOwner: string | null;
  countryOwnerUserId?: string | null;
  status: OrganisationStatus;
  notes: string | null;
  source: OrganisationSource;
  externalId?: string | null;
} & Partial<OrganisationCrmFields>;

export type OrganisationPatch = Partial<Omit<OrganisationInput, "source" | "externalId">> & { archived?: false };

/** How far up a parent chain we look for a loop; real group structures are far shallower. */
const MAX_PARENT_DEPTH = 50;

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
    countryOwnerUserId: row.countryOwnerUserId,
    status: row.status as OrganisationStatus,
    notes: row.notes,
    legalName: row.legalName,
    domain: row.domain,
    phone: row.phone,
    email: row.email,
    addressStreet: row.addressStreet,
    addressCity: row.addressCity,
    addressRegion: row.addressRegion,
    addressPostalCode: row.addressPostalCode,
    employeeCount: row.employeeCount,
    sizeBand: row.sizeBand as OrganisationSizeBand | null,
    annualRevenue: row.annualRevenue === null ? null : Number(row.annualRevenue),
    annualRevenueCurrency: row.annualRevenueCurrency,
    ownershipType: row.ownershipType as OrganisationOwnershipType | null,
    parentOrganisationId: row.parentOrganisationId,
    linkedinUrl: row.linkedinUrl,
    accountOwnerUserId: row.accountOwnerUserId,
    accountOwnerAgentId: row.accountOwnerAgentId,
    segment: row.segment,
    tags: row.tags,
    description: row.description,
    registrationNumber: row.registrationNumber,
    taxId: row.taxId,
    crmFields: row.crmFields ?? [],
    source: row.source as OrganisationSource,
    externalId: row.externalId,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** numeric columns take a string in Drizzle; keep null and undefined as they are. */
function toRowValues<T extends { annualRevenue?: number | null }>(fields: T) {
  const { annualRevenue, ...rest } = fields;
  return annualRevenue === undefined ? rest : { ...rest, annualRevenue: annualRevenue === null ? null : String(annualRevenue) };
}

function toContact(row: ContactRow): OrganisationContact {
  return {
    id: row.id,
    companyId: row.companyId,
    organisationId: row.organisationId,
    name: row.name,
    role: row.role,
    websiteUserId: row.websiteUserId,
    email: row.email,
    phone: row.phone,
    isKeyContact: row.isKeyContact,
    crmFields: row.crmFields ?? [],
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
  /**
   * A country owner picked from the company's members: they must be an active
   * member, and their name becomes countryOwner so search and lists still work.
   * undefined leaves both as they are; null unlinks and keeps the typed name.
   */
  async function ownerFields(companyId: string, userId: string | null | undefined) {
    if (userId === undefined) return {};
    if (userId === null) return { countryOwnerUserId: null };
    const member = await db
      .select({ name: authUsers.name, email: authUsers.email })
      .from(companyMemberships)
      .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!member) throw unprocessable("The country owner must be an active member of this company");
    return { countryOwnerUserId: userId, countryOwner: member.name?.trim() || member.email || userId };
  }

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

  /**
   * Checks the CRM links (GRE-1539) against the values the row will have:
   * parent and account owner must belong to this company, a parent may not
   * loop back to the organisation, and revenue needs a currency.
   */
  async function assertCrmFields(
    companyId: string,
    organisationId: string | null,
    next: Partial<OrganisationCrmFields>,
    current: OrganisationRow | null,
  ) {
    const value = <K extends keyof OrganisationCrmFields>(key: K) =>
      (next[key] !== undefined ? next[key] : (current?.[key] ?? null)) as OrganisationCrmFields[K] | string | null;

    if (value("annualRevenue") !== null && !value("annualRevenueCurrency")) {
      throw unprocessable("Add the currency of the annual revenue", { code: "revenue_currency_required" });
    }
    if (value("accountOwnerUserId") && value("accountOwnerAgentId")) {
      throw unprocessable("Choose a person or an agent as account owner, not both", { code: "one_account_owner" });
    }

    if (next.accountOwnerAgentId) {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, next.accountOwnerAgentId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw unprocessable("Account owner agent not found", { code: "account_owner_not_found" });
    }
    if (next.accountOwnerUserId) {
      const member = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, next.accountOwnerUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!member) throw unprocessable("Account owner is not a member of this company", { code: "account_owner_not_found" });
    }

    if (next.parentOrganisationId) {
      if (next.parentOrganisationId === organisationId) {
        throw unprocessable("An organisation cannot be its own parent", { code: "parent_loop" });
      }
      // Walk up from the new parent; meeting this organisation again would make a loop.
      let cursor: string | null = next.parentOrganisationId;
      for (let depth = 0; cursor && depth < MAX_PARENT_DEPTH; depth += 1) {
        const parent = await getRow(companyId, cursor);
        if (!parent) {
          if (depth === 0) throw unprocessable("Parent organisation not found", { code: "parent_not_found" });
          break;
        }
        if (organisationId && parent.parentOrganisationId === organisationId) {
          throw unprocessable("This parent would make a loop: it already sits under this organisation", { code: "parent_loop" });
        }
        cursor = parent.parentOrganisationId;
      }
    }
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
            ilike(organisations.legalName, pattern),
            ilike(organisations.domain, pattern),
            ilike(organisations.segment, pattern),
            sql`array_to_string(${organisations.tags}, ' ') ilike ${pattern}`,
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
        if (!contact.organisationId) continue;
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

    /** Live people across every organisation matching a search on name, role, email, phone or organisation, by name. */
    async searchContacts(companyId: string, q: string, limit = 100): Promise<OrganisationPerson[]> {
      const pattern = likePattern(q);
      const rows = await db
        .select({ contact: organisationContacts, organisationName: organisations.name })
        .from(organisationContacts)
        .leftJoin(organisations, and(
          eq(organisations.id, organisationContacts.organisationId),
          eq(organisations.companyId, organisationContacts.companyId),
        ))
        .where(and(
          eq(organisationContacts.companyId, companyId),
          isNull(organisationContacts.archivedAt),
          or(
            ilike(organisationContacts.name, pattern),
            ilike(organisationContacts.role, pattern),
            ilike(organisationContacts.email, pattern),
            ilike(organisationContacts.phone, pattern),
            ilike(organisations.name, pattern),
          )!,
        ))
        .orderBy(asc(organisationContacts.name))
        .limit(limit);
      return rows.map(({ contact, organisationName }) => ({ ...toContact(contact), organisationName }));
    },

    /** People with no organisation (imported from a CRM that held them on their own), by name. */
    async listUnassignedContacts(companyId: string): Promise<OrganisationContact[]> {
      const rows = await db
        .select()
        .from(organisationContacts)
        .where(and(
          eq(organisationContacts.companyId, companyId),
          isNull(organisationContacts.organisationId),
          isNull(organisationContacts.archivedAt),
        ))
        .orderBy(asc(organisationContacts.name));
      return rows.map(toContact);
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
      await assertCrmFields(companyId, null, input, null);
      input = { ...input, ...(await ownerFields(companyId, input.countryOwnerUserId)) };
      try {
        const [row] = await db
          .insert(organisations)
          .values({
            companyId,
            ...toRowValues(input),
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
      const current = await getRow(companyId, id);
      if (!current) return null;
      const { archived, ...rest } = patch;
      const fields = { ...rest, ...(await ownerFields(companyId, rest.countryOwnerUserId)) };
      // Picking a person as account owner clears the agent, and the other way round.
      if (fields.accountOwnerUserId && fields.accountOwnerAgentId === undefined) fields.accountOwnerAgentId = null;
      if (fields.accountOwnerAgentId && fields.accountOwnerUserId === undefined) fields.accountOwnerUserId = null;
      await assertCrmFields(companyId, id, fields, current);
      const [row] = await db
        .update(organisations)
        .set({ ...toRowValues(fields), ...(archived === false ? { archivedAt: null } : {}), updatedAt: new Date() })
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
