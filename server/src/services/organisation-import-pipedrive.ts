// Read-only Pipedrive import of organisations and persons (GRE-1479), then
// pipelines, stages and every deal (pipedrive-deal-import.ts).
// Reads every organisation and person through the Pipedrive client and writes
// them to `organisations` and `organisation_contacts` with source "pipedrive"
// and the Pipedrive id as external id, so a rerun updates instead of
// duplicating. Nothing is written back to Pipedrive.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { authUsers, companyMemberships, organisationContacts, organisations } from "@greatstone/db";
import type { CrmRecordField, OrganisationImportCounts, OrganisationImportResult, OrganisationStatus } from "@greatstone/shared";
import type {
  PipedriveClient,
  PipedriveContactValue,
  PipedriveDealField,
  PipedriveLink,
  PipedriveOrganization,
  PipedrivePerson,
} from "./crm-sync-pipedrive.js";
import type { OrganisationActor } from "./organisations.js";
import { pipedriveDealImportService } from "./pipedrive-deal-import.js";
import type { StorageService } from "../storage/types.js";
import { pipedriveFileImportService } from "./pipedrive-file-import.js";
import { pipedriveParticipantImportService } from "./pipedrive-participant-import.js";
import { pipedriveLeadImportService } from "./pipedrive-lead-import.js";
import { pipedriveProductImportService } from "./pipedrive-product-import.js";
import { pipedriveTimelineImportService } from "./pipedrive-timeline-import.js";
import {
  ORGANISATION_COLUMN_KEYS,
  PERSON_COLUMN_KEYS,
  pipedriveRecordFields,
  sameRecordFields,
} from "./pipedrive-record-fields.js";

const SOURCE = "pipedrive";

/** The CRM an import reads from; it is also the rows' `source`, so each CRM keeps its own ids. */
export type CrmImportSource = OrganisationImportResult["source"];
const MAX_ERROR_SAMPLES = 20;

export interface MappedPipedriveOrganisation {
  externalId: string;
  name: string;
  industry: string | null;
  country: string | null;
  countryOwner: string | null;
  /**
   * The Pipedrive owner's email, so the owner links to the GSAM member with
   * the same email. Undefined when the source does not say (export files).
   */
  ownerEmail?: string | null;
  /** Used only when the organisation is created; a rerun never changes the GSAM status. */
  status: OrganisationStatus;
  /** Website, when Pipedrive has one. Fills an empty website; never overwrites one typed in GSAM. */
  website?: string | null;
  /** Every other field, custom fields included. Undefined when the source has none (export files). */
  crmFields?: CrmRecordField[];
}

export interface MappedPipedriveContact {
  externalId: string;
  organisationExternalId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  /** Every other field, custom fields included. Undefined when the source has none (export files). */
  crmFields?: CrmRecordField[];
}

/** What the API import knows about the account's fields and users. */
export interface PipedriveFieldContext {
  fields: PipedriveDealField[];
  users: Map<string, string>;
  /** Pipedrive user emails by user id, for owners answered as a bare id. */
  userEmails?: Map<string, string>;
}

/** Trimmed text cut to the API limit, or null when blank. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** The email of a linked Pipedrive user, lower-cased, from the link itself or the users list. */
function ownerEmailOf(link: PipedriveLink | undefined, userEmails?: Map<string, string>): string | null {
  const own = link && typeof link === "object" ? text(link.email, 320) : null;
  const id = linkId(link);
  const email = own ?? (id ? userEmails?.get(id) ?? null : null);
  return email ? email.toLowerCase() : null;
}

function linkId(link: PipedriveLink | undefined): string | null {
  if (link === null || link === undefined) return null;
  if (typeof link === "number") return String(link);
  const id = link.value ?? link.id;
  return typeof id === "number" ? String(id) : null;
}

function linkName(link: PipedriveLink | undefined): string | null {
  return link && typeof link === "object" ? text(link.name, 200) : null;
}

/** The primary entry of a v1 email or phone list, else the first one with a value. */
function primaryValue(values: PipedriveContactValue[] | string | null | undefined, max: number): string | null {
  if (typeof values === "string") return text(values, max);
  if (!Array.isArray(values)) return null;
  const withValue = values.filter((entry) => text(entry?.value, max));
  const chosen = withValue.find((entry) => entry.primary) ?? withValue[0];
  return chosen ? text(chosen.value, max) : null;
}

/** Labels of the organisation `industry` choice field, by option id. */
export function industryLabels(fields: PipedriveDealField[]) {
  const field = fields.find((item) => item.key === "industry");
  return new Map((field?.options ?? []).map((option) => [String(option.id), option.label]));
}

/**
 * Pipedrive organisation -> GSAM organisation. Null when it has no name.
 * Status on create: won deal -> client, open deal -> prospect, otherwise target.
 */
export function mapPipedriveOrganization(
  org: PipedriveOrganization,
  industries: Map<string, string> = new Map(),
  context?: PipedriveFieldContext,
): MappedPipedriveOrganisation | null {
  const name = text(org.name, 300);
  if (!name) return null;
  const rawIndustry = text(org.industry, 200);
  const won = Number(org.won_deals_count ?? 0);
  const open = Number(org.open_deals_count ?? 0);
  return {
    externalId: String(org.id),
    name,
    industry: rawIndustry ? text(industries.get(rawIndustry) ?? rawIndustry, 200) : null,
    country: text(org.address_country, 120),
    countryOwner: linkName(org.owner_id),
    status: won > 0 ? "client" : open > 0 ? "prospect" : "target",
    ...(context
      ? {
        website: websiteOf(org.website),
        crmFields: pipedriveRecordFields(org, context.fields, { skip: ORGANISATION_COLUMN_KEYS, users: context.users }),
        ownerEmail: ownerEmailOf(org.owner_id, context.userEmails),
      }
      : {}),
  };
}

/** An http(s) address, adding https:// to a bare domain. Null otherwise. */
function websiteOf(value: unknown): string | null {
  const raw = text(value, 2_000);
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Pipedrive person -> GSAM contact. Null when it has no name. */
export function mapPipedrivePerson(person: PipedrivePerson, context?: PipedriveFieldContext): MappedPipedriveContact | null {
  const name = text(person.name, 300);
  if (!name) return null;
  return {
    externalId: String(person.id),
    organisationExternalId: linkId(person.org_id),
    name,
    role: text(person.job_title, 200),
    email: primaryValue(person.email, 320),
    phone: primaryValue(person.phone, 80),
    ...(context
      ? { crmFields: pipedriveRecordFields(person, context.fields, { skip: PERSON_COLUMN_KEYS, users: context.users }) }
      : {}),
  };
}

export const emptyImportCounts = (): OrganisationImportCounts => ({ created: 0, updated: 0, skipped: 0, errors: 0 });

type OrganisationRow = typeof organisations.$inferSelect;
type ContactRow = typeof organisationContacts.$inferSelect;

/**
 * Writes mapped Pipedrive records for one company, keyed by source "pipedrive"
 * and the Pipedrive id, so the API import and the export file import update
 * the same rows. Counts and error samples go into `result`.
 */
export function pipedriveRecordWriter(
  db: Db,
  companyId: string,
  actor: OrganisationActor,
  result: OrganisationImportResult,
  now: () => Date,
  source: CrmImportSource = SOURCE,
) {
  const orgByExternalId = new Map<string, OrganisationRow>();
  const contactByExternalId = new Map<string, ContactRow>();
  /** Active members by lower-cased email; filled by loadMembers for the API import only. */
  let memberIdByEmail: Map<string, string> | null = null;

  /**
   * The member a Pipedrive owner links to. Undefined leaves the link as it
   * is: the source gave no owner email, or the owner did not change and no
   * member matches. Null unlinks a member who no longer owns it in Pipedrive.
   */
  const ownerUserId = (mapped: MappedPipedriveOrganisation, existing?: OrganisationRow): string | null | undefined => {
    if (!memberIdByEmail || mapped.ownerEmail === undefined) return undefined;
    const match = mapped.ownerEmail ? memberIdByEmail.get(mapped.ownerEmail) : undefined;
    if (match) return match;
    if (!existing?.countryOwnerUserId) return undefined;
    return existing.countryOwner === mapped.countryOwner ? undefined : null;
  };

  const recordError = (kind: "organisation" | "contact", externalId: string, error: unknown) => {
    result[kind === "organisation" ? "organisations" : "contacts"].errors += 1;
    if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
      result.errorSamples.push({ kind, externalId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    orgByExternalId,
    contactByExternalId,
    recordError,

    async loadOrganisations() {
      const rows = await db
        .select()
        .from(organisations)
        .where(and(eq(organisations.companyId, companyId), eq(organisations.source, source), isNotNull(organisations.externalId)));
      for (const row of rows) orgByExternalId.set(row.externalId!, row);
    },

    async loadMembers() {
      const rows = await db
        .select({ userId: companyMemberships.principalId, email: authUsers.email })
        .from(companyMemberships)
        .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ));
      memberIdByEmail = new Map(rows.filter((row) => row.email).map((row) => [row.email!.trim().toLowerCase(), row.userId]));
    },

    async loadContacts() {
      const rows = await db
        .select()
        .from(organisationContacts)
        .where(
          and(
            eq(organisationContacts.companyId, companyId),
            eq(organisationContacts.source, source),
            isNotNull(organisationContacts.externalId),
          ),
        );
      for (const row of rows) contactByExternalId.set(row.externalId!, row);
    },

    async writeOrganisation(mapped: MappedPipedriveOrganisation) {
      try {
        const existing = orgByExternalId.get(mapped.externalId);
        if (!existing) {
          const [row] = await db
            .insert(organisations)
            .values({
              companyId,
              name: mapped.name,
              industry: mapped.industry,
              country: mapped.country,
              countryOwner: mapped.countryOwner,
              countryOwnerUserId: ownerUserId(mapped) ?? null,
              website: mapped.website ?? null,
              crmFields: mapped.crmFields ?? [],
              status: mapped.status,
              source,
              externalId: mapped.externalId,
              createdByUserId: actor.userId,
              createdByAgentId: actor.agentId,
            })
            .returning();
          orgByExternalId.set(mapped.externalId, row!);
          result.organisations.created += 1;
          return;
        }
        const fields: Partial<OrganisationRow> = {
          name: mapped.name,
          industry: mapped.industry,
          country: mapped.country,
          countryOwner: mapped.countryOwner,
        };
        const linkedUserId = ownerUserId(mapped, existing);
        if (linkedUserId !== undefined && linkedUserId !== existing.countryOwnerUserId) fields.countryOwnerUserId = linkedUserId;
        if (mapped.website && !existing.website) fields.website = mapped.website;
        if (mapped.crmFields && !sameRecordFields(mapped.crmFields, existing.crmFields)) fields.crmFields = mapped.crmFields;
        if (
          existing.name === fields.name &&
          existing.industry === fields.industry &&
          existing.country === fields.country &&
          existing.countryOwner === fields.countryOwner &&
          fields.website === undefined &&
          fields.crmFields === undefined &&
          fields.countryOwnerUserId === undefined
        ) {
          result.organisations.skipped += 1;
          return;
        }
        const [row] = await db
          .update(organisations)
          .set({ ...fields, updatedAt: now() })
          .where(and(eq(organisations.companyId, companyId), eq(organisations.id, existing.id)))
          .returning();
        orgByExternalId.set(mapped.externalId, row!);
        result.organisations.updated += 1;
      } catch (error) {
        recordError("organisation", mapped.externalId, error);
      }
    },

    /** `organisation` is null for a person Pipedrive holds with no organisation; they still come across. */
    async writeContact(mapped: MappedPipedriveContact, organisation: OrganisationRow | null) {
      try {
        const existing = contactByExternalId.get(mapped.externalId);
        const fields: Partial<ContactRow> & { organisationId: string | null; name: string } = {
          organisationId: organisation?.id ?? null,
          name: mapped.name,
          role: mapped.role,
          email: mapped.email,
          phone: mapped.phone,
          ...(mapped.crmFields ? { crmFields: mapped.crmFields } : {}),
        };
        if (!existing) {
          const [row] = await db
            .insert(organisationContacts)
            .values({
              companyId,
              ...fields,
              source,
              externalId: mapped.externalId,
              createdByUserId: actor.userId,
              createdByAgentId: actor.agentId,
            })
            .returning();
          contactByExternalId.set(mapped.externalId, row!);
          result.contacts.created += 1;
          return;
        }
        if (
          existing.organisationId === fields.organisationId &&
          existing.name === fields.name &&
          existing.role === fields.role &&
          existing.email === fields.email &&
          existing.phone === fields.phone &&
          (fields.crmFields === undefined || sameRecordFields(fields.crmFields, existing.crmFields))
        ) {
          result.contacts.skipped += 1;
          return;
        }
        const [row] = await db
          .update(organisationContacts)
          .set({ ...fields, updatedAt: now() })
          .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.id, existing.id)))
          .returning();
        contactByExternalId.set(mapped.externalId, row!);
        result.contacts.updated += 1;
      } catch (error) {
        recordError("contact", mapped.externalId, error);
      }
    },
  };
}

export function newImportResult(startedAt: Date, source: CrmImportSource = SOURCE): OrganisationImportResult {
  return {
    source,
    organisations: emptyImportCounts(),
    contacts: emptyImportCounts(),
    errorSamples: [],
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
  };
}

/**
 * Runs one full import for a company. The caller checks permissions and
 * builds the client from the company's own Pipedrive connection.
 */
export function pipedriveOrganisationImportService(db: Db, deps: { now?: () => Date; storage?: StorageService } = {}) {
  const now = deps.now ?? (() => new Date());

  return {
    async run(companyId: string, client: PipedriveClient, actor: OrganisationActor): Promise<OrganisationImportResult> {
      const result = newImportResult(now());
      const writer = pipedriveRecordWriter(db, companyId, actor, result, now);

      // Organisations first, so persons can link to them by Pipedrive id.
      const organizationFields = await client.listOrganizationFields();
      const industries = industryLabels(organizationFields);
      // Owner and user fields read as names. A token that may not list users still imports.
      const pdUsers = await client.listUsers().catch(() => []);
      const users = new Map(pdUsers.map((user) => [String(user.id), user.name?.trim() || user.email || String(user.id)]));
      const userEmails = new Map(pdUsers.filter((user) => user.email).map((user) => [String(user.id), user.email!]));
      const orgContext: PipedriveFieldContext = { fields: organizationFields, users, userEmails };
      await writer.loadOrganisations();
      // Owners link to the GSAM member with the same email.
      await writer.loadMembers();

      let start: number | null = 0;
      while (start !== null) {
        const page: Awaited<ReturnType<PipedriveClient["listOrganizationsPage"]>> = await client.listOrganizationsPage({ start });
        for (const org of page.items) {
          const mapped = mapPipedriveOrganization(org, industries, orgContext);
          if (!mapped) {
            result.organisations.skipped += 1;
            continue;
          }
          await writer.writeOrganisation(mapped);
        }
        start = page.nextStart;
      }

      await writer.loadContacts();
      const personContext: PipedriveFieldContext = { fields: await client.listPersonFields(), users };

      start = 0;
      while (start !== null) {
        const page: Awaited<ReturnType<PipedriveClient["listPersonsPage"]>> = await client.listPersonsPage({ start });
        for (const person of page.items) {
          const mapped = mapPipedrivePerson(person, personContext);
          if (!mapped) {
            result.contacts.skipped += 1;
            continue;
          }
          // A person with no organisation, or whose organisation was not imported, is kept on their own.
          const organisation = mapped.organisationExternalId ? writer.orgByExternalId.get(mapped.organisationExternalId) ?? null : null;
          await writer.writeContact(mapped, organisation);
        }
        start = page.nextStart;
      }

      // Pipelines, stages and every deal, linked to the organisations above.
      const organisationIdByExternalId = new Map([...writer.orgByExternalId].map(([externalId, row]) => [externalId, row.id]));
      const deals = await pipedriveDealImportService(db).run({
        companyId,
        client,
        actor,
        organisationIdByExternalId,
        result,
      });

      // The product catalogue and the products on each deal.
      await pipedriveProductImportService(db, { now }).run({
        companyId,
        client,
        result,
        users,
        caseIdByDealId: deals.caseIdByDealId,
        lineItemsByDealId: deals.lineItemsByDealId,
      });

      // The Leads inbox, as cases in its own pipeline.
      const leads = await pipedriveLeadImportService(db).run({
        companyId,
        client,
        actor,
        result,
        users,
        organisationIdByExternalId,
        peopleNames: new Map([...writer.contactByExternalId].map(([externalId, row]) => [externalId, row.name])),
        organisationNames: new Map([...writer.orgByExternalId].map(([externalId, row]) => [externalId, row.name])),
      });

      const contactIdByExternalId = new Map([...writer.contactByExternalId].map(([externalId, row]) => [externalId, row.id]));

      // The people on each deal, as the case's contacts.
      await pipedriveParticipantImportService(db, { now }).run({
        companyId,
        result,
        userId: actor.userId ?? null,
        caseIdByDealId: deals.caseIdByDealId,
        participantsByDealId: deals.participantsByDealId,
        people: new Map([...writer.contactByExternalId].map(([externalId, row]) => [
          externalId,
          { name: row.name, role: row.role, email: row.email, phone: row.phone },
        ])),
      });

      // Files on deals, leads, people and organisations, copied into GSAM storage.
      await pipedriveFileImportService(db, { storage: deps.storage, now }).run({
        companyId,
        client,
        result,
        userId: actor.userId ?? null,
        links: {
          organisationIdByExternalId,
          contactIdByExternalId,
          caseIdByDealId: deals.caseIdByDealId,
          caseIdByLeadId: leads.caseIdByLeadId,
          users,
        },
      });

      // Activities, notes and call logs, linked to the records above.
      await pipedriveTimelineImportService(db, { now }).run({
        companyId,
        client,
        result,
        links: {
          organisationIdByExternalId,
          contactIdByExternalId,
          caseIdByDealId: deals.caseIdByDealId,
          caseIdByLeadId: leads.caseIdByLeadId,
          users,
        },
      });

      result.finishedAt = now().toISOString();
      return result;
    },
  };
}
