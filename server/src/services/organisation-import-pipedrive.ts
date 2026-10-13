// Read-only Pipedrive import of organisations and persons (GRE-1479).
// Reads every organisation and person through the Pipedrive client and writes
// them to `organisations` and `organisation_contacts` with source "pipedrive"
// and the Pipedrive id as external id, so a rerun updates instead of
// duplicating. Nothing is written back to Pipedrive.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisationContacts, organisations } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult, OrganisationStatus } from "@greatstone/shared";
import type {
  PipedriveClient,
  PipedriveContactValue,
  PipedriveDealField,
  PipedriveLink,
  PipedriveOrganization,
  PipedrivePerson,
} from "./crm-sync-pipedrive.js";
import type { OrganisationActor } from "./organisations.js";

const SOURCE = "pipedrive";
const MAX_ERROR_SAMPLES = 20;

export interface MappedPipedriveOrganisation {
  externalId: string;
  name: string;
  industry: string | null;
  country: string | null;
  countryOwner: string | null;
  /** Used only when the organisation is created; a rerun never changes the GSAM status. */
  status: OrganisationStatus;
  /**
   * Global CRM fields Pipedrive has (GRE-1539). Only the ones with a value are
   * here, so a rerun fills them in but never blanks what someone typed in GSAM.
   */
  crm: Partial<{
    website: string;
    linkedinUrl: string;
    addressStreet: string;
    addressCity: string;
    addressRegion: string;
    addressPostalCode: string;
    employeeCount: number;
    annualRevenue: number;
    annualRevenueCurrency: string;
  }>;
}

export interface MappedPipedriveContact {
  externalId: string;
  organisationExternalId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

/** Trimmed text cut to the API limit, or null when blank. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
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

/** A whole, non-negative number, or null. Pipedrive sends numbers as numbers or text. */
function count(value: unknown, max: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

function webAddress(value: unknown): string | null {
  const raw = text(value, 500);
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`.slice(0, 500);
}

/** Drops null entries so only fields Pipedrive filled in are written. */
function present<T extends Record<string, unknown>>(fields: T) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) as {
    [K in keyof T]?: NonNullable<T[K]>;
  };
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
): MappedPipedriveOrganisation | null {
  const name = text(org.name, 300);
  if (!name) return null;
  const rawIndustry = text(org.industry, 200);
  const won = Number(org.won_deals_count ?? 0);
  const open = Number(org.open_deals_count ?? 0);
  const employeeCount = count(org.employee_count, 10_000_000);
  const currency = text(org.annual_revenue_currency, 3)?.toUpperCase() ?? null;
  // Revenue without a currency cannot be read, so it is only taken with one.
  const revenue = currency && /^[A-Z]{3}$/.test(currency) ? count(org.annual_revenue, 1e15) : null;
  const street = [text(org.address_street_number, 40), text(org.address_route, 250)].filter(Boolean).join(" ");
  return {
    externalId: String(org.id),
    name,
    industry: rawIndustry ? text(industries.get(rawIndustry) ?? rawIndustry, 200) : null,
    country: text(org.address_country, 120),
    countryOwner: linkName(org.owner_id),
    status: won > 0 ? "client" : open > 0 ? "prospect" : "target",
    crm: present({
      website: text(org.website, 500),
      linkedinUrl: webAddress(org.linkedin),
      addressStreet: street || null,
      addressCity: text(org.address_locality, 120),
      addressRegion: text(org.address_admin_area_level_1, 120),
      addressPostalCode: text(org.address_postal_code, 40),
      employeeCount: employeeCount === null ? null : Math.round(employeeCount),
      annualRevenue: revenue,
      annualRevenueCurrency: revenue === null ? null : currency,
    }),
  };
}

/** True when every CRM field Pipedrive sent already has that value on the row. */
function crmUnchanged(existing: typeof organisations.$inferSelect, crm: MappedPipedriveOrganisation["crm"]) {
  return Object.entries(crm).every(([key, value]) => {
    const current = existing[key as keyof typeof existing];
    return key === "annualRevenue" ? current !== null && Number(current) === value : current === value;
  });
}

/** numeric columns take text in Drizzle. */
function crmRowValues(crm: MappedPipedriveOrganisation["crm"]) {
  const { annualRevenue, ...rest } = crm;
  return annualRevenue === undefined ? rest : { ...rest, annualRevenue: String(annualRevenue) };
}

/** Pipedrive person -> GSAM contact. Null when it has no name. */
export function mapPipedrivePerson(person: PipedrivePerson): MappedPipedriveContact | null {
  const name = text(person.name, 300);
  if (!name) return null;
  return {
    externalId: String(person.id),
    organisationExternalId: linkId(person.org_id),
    name,
    role: text(person.job_title, 200),
    email: primaryValue(person.email, 320),
    phone: primaryValue(person.phone, 80),
  };
}

const emptyCounts = (): OrganisationImportCounts => ({ created: 0, updated: 0, skipped: 0, errors: 0 });

/**
 * Runs one full import for a company. The caller checks permissions and
 * builds the client from the company's own Pipedrive connection.
 */
export function pipedriveOrganisationImportService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  return {
    async run(companyId: string, client: PipedriveClient, actor: OrganisationActor): Promise<OrganisationImportResult> {
      const startedAt = now();
      const result: OrganisationImportResult = {
        source: SOURCE,
        organisations: emptyCounts(),
        contacts: emptyCounts(),
        errorSamples: [],
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
      };
      const recordError = (kind: "organisation" | "contact", externalId: string, error: unknown) => {
        result[kind === "organisation" ? "organisations" : "contacts"].errors += 1;
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
          result.errorSamples.push({ kind, externalId, message: error instanceof Error ? error.message : String(error) });
        }
      };

      // Organisations first, so persons can link to them by Pipedrive id.
      const industries = industryLabels(await client.listOrganizationFields());
      const orgByExternalId = new Map(
        (
          await db
            .select()
            .from(organisations)
            .where(and(eq(organisations.companyId, companyId), eq(organisations.source, SOURCE), isNotNull(organisations.externalId)))
        ).map((row) => [row.externalId!, row]),
      );

      let start: number | null = 0;
      while (start !== null) {
        const page: Awaited<ReturnType<PipedriveClient["listOrganizationsPage"]>> = await client.listOrganizationsPage({ start });
        for (const org of page.items) {
          const mapped = mapPipedriveOrganization(org, industries);
          if (!mapped) {
            result.organisations.skipped += 1;
            continue;
          }
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
                  status: mapped.status,
                  ...crmRowValues(mapped.crm),
                  source: SOURCE,
                  externalId: mapped.externalId,
                  createdByUserId: actor.userId,
                  createdByAgentId: actor.agentId,
                })
                .returning();
              orgByExternalId.set(mapped.externalId, row!);
              result.organisations.created += 1;
              continue;
            }
            const fields = {
              name: mapped.name,
              industry: mapped.industry,
              country: mapped.country,
              countryOwner: mapped.countryOwner,
            };
            if (
              existing.name === fields.name &&
              existing.industry === fields.industry &&
              existing.country === fields.country &&
              existing.countryOwner === fields.countryOwner &&
              crmUnchanged(existing, mapped.crm)
            ) {
              result.organisations.skipped += 1;
              continue;
            }
            const [row] = await db
              .update(organisations)
              .set({ ...fields, ...crmRowValues(mapped.crm), updatedAt: now() })
              .where(and(eq(organisations.companyId, companyId), eq(organisations.id, existing.id)))
              .returning();
            orgByExternalId.set(mapped.externalId, row!);
            result.organisations.updated += 1;
          } catch (error) {
            recordError("organisation", mapped.externalId, error);
          }
        }
        start = page.nextStart;
      }

      const contactByExternalId = new Map(
        (
          await db
            .select()
            .from(organisationContacts)
            .where(
              and(
                eq(organisationContacts.companyId, companyId),
                eq(organisationContacts.source, SOURCE),
                isNotNull(organisationContacts.externalId),
              ),
            )
        ).map((row) => [row.externalId!, row]),
      );

      start = 0;
      while (start !== null) {
        const page: Awaited<ReturnType<PipedriveClient["listPersonsPage"]>> = await client.listPersonsPage({ start });
        for (const person of page.items) {
          const mapped = mapPipedrivePerson(person);
          // A person with no organisation, or one whose organisation was not imported, has nowhere to go.
          const organisation = mapped?.organisationExternalId ? orgByExternalId.get(mapped.organisationExternalId) : undefined;
          if (!mapped || !organisation) {
            result.contacts.skipped += 1;
            continue;
          }
          try {
            const existing = contactByExternalId.get(mapped.externalId);
            const fields = {
              organisationId: organisation.id,
              name: mapped.name,
              role: mapped.role,
              email: mapped.email,
              phone: mapped.phone,
            };
            if (!existing) {
              const [row] = await db
                .insert(organisationContacts)
                .values({
                  companyId,
                  ...fields,
                  source: SOURCE,
                  externalId: mapped.externalId,
                  createdByUserId: actor.userId,
                  createdByAgentId: actor.agentId,
                })
                .returning();
              contactByExternalId.set(mapped.externalId, row!);
              result.contacts.created += 1;
              continue;
            }
            if (
              existing.organisationId === fields.organisationId &&
              existing.name === fields.name &&
              existing.role === fields.role &&
              existing.email === fields.email &&
              existing.phone === fields.phone
            ) {
              result.contacts.skipped += 1;
              continue;
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
        }
        start = page.nextStart;
      }

      result.finishedAt = now().toISOString();
      return result;
    },
  };
}
