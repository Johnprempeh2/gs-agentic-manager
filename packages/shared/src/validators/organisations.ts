import { z } from "zod";
import {
  ORGANISATION_MAX_TAGS,
  ORGANISATION_OWNERSHIP_TYPES,
  ORGANISATION_SIZE_BANDS,
  ORGANISATION_SOURCES,
  ORGANISATION_STATUSES,
  ORGANISATION_TAG_MAX_LENGTH,
} from "../organisations.js";

export const organisationStatusSchema = z.enum(ORGANISATION_STATUSES);
export const organisationSourceSchema = z.enum(ORGANISATION_SOURCES);
export const organisationSizeBandSchema = z.enum(ORGANISATION_SIZE_BANDS);
export const organisationOwnershipTypeSchema = z.enum(ORGANISATION_OWNERSHIP_TYPES);

/** Optional text: blank becomes null so the list shows "not set". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const externalIdSchema = z.string().trim().min(1).max(200).nullish();

const optionalEmail = () =>
  z
    .string()
    .trim()
    .max(320)
    .nullish()
    .transform((value) => (value ? value : null))
    .pipe(z.string().email("Enter a valid email").nullable());

/** A bare host name: "https://www.Acme.com/about" becomes "acme.com". */
const domainSchema = z
  .string()
  .trim()
  .max(253)
  .nullish()
  .transform((value) => {
    if (!value) return null;
    const host = value.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "");
    return host || null;
  })
  .pipe(
    z
      .string()
      .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, "Enter a domain such as example.com")
      .nullable(),
  );

/** A web address; "linkedin.com/company/x" gets "https://" in front. */
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((value) => (value ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null))
  .pipe(z.string().url("Enter a web address").nullable());

const employeeCountSchema = z.number().int("Use a whole number").min(0).max(10_000_000).nullish().transform((value) => value ?? null);
const annualRevenueSchema = z.number().finite().min(0).max(1e15).nullish().transform((value) => value ?? null);
const currencySchema = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value ? value.toUpperCase() : null))
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code such as GBP").nullable());

/** Tags: trimmed, blanks dropped, duplicates (any case) removed. */
const tagsSchema = z
  .array(z.string().trim().max(ORGANISATION_TAG_MAX_LENGTH))
  .max(ORGANISATION_MAX_TAGS)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

const nullableId = z.string().guid().nullish().transform((value) => value ?? null);
const nullableUserId = z.string().trim().min(1).max(200).nullish().transform((value) => value ?? null);

/** Global CRM fields (GRE-1539): the same on create and update, all optional. */
const crmFieldShape = {
  legalName: optionalText(300),
  domain: domainSchema,
  phone: optionalText(80),
  email: optionalEmail(),
  addressStreet: optionalText(300),
  addressCity: optionalText(120),
  addressRegion: optionalText(120),
  addressPostalCode: optionalText(40),
  employeeCount: employeeCountSchema,
  sizeBand: organisationSizeBandSchema.nullish().transform((value) => value ?? null),
  annualRevenue: annualRevenueSchema,
  annualRevenueCurrency: currencySchema,
  ownershipType: organisationOwnershipTypeSchema.nullish().transform((value) => value ?? null),
  parentOrganisationId: nullableId,
  linkedinUrl: urlSchema,
  accountOwnerUserId: nullableUserId,
  accountOwnerAgentId: nullableId,
  segment: optionalText(120),
  description: optionalText(20_000),
  registrationNumber: optionalText(120),
  taxId: optionalText(120),
};

const oneAccountOwner = (value: { accountOwnerUserId?: string | null; accountOwnerAgentId?: string | null }) =>
  !(value.accountOwnerUserId && value.accountOwnerAgentId);
const oneAccountOwnerMessage = { message: "Choose a person or an agent as account owner, not both", path: ["accountOwnerAgentId"] };

export const createOrganisationSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(300),
    website: optionalText(500),
    industry: optionalText(200),
    country: optionalText(120),
    countryOwner: optionalText(200),
    /** A company member who owns the country; their name fills countryOwner. */
    countryOwnerUserId: z.string().trim().min(1).max(200).nullish(),
    status: organisationStatusSchema.default("target"),
    notes: optionalText(20_000),
    ...crmFieldShape,
    tags: tagsSchema.default([]),
    source: organisationSourceSchema.default("manual"),
    externalId: externalIdSchema,
  })
  .strict()
  .refine(oneAccountOwner, oneAccountOwnerMessage);
export type CreateOrganisation = z.input<typeof createOrganisationSchema>;

export const updateOrganisationSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(300).optional(),
    website: optionalText(500).optional(),
    industry: optionalText(200).optional(),
    country: optionalText(120).optional(),
    countryOwner: optionalText(200).optional(),
    countryOwnerUserId: z.string().trim().min(1).max(200).nullish(),
    status: organisationStatusSchema.optional(),
    notes: optionalText(20_000).optional(),
    ...(Object.fromEntries(Object.entries(crmFieldShape).map(([key, schema]) => [key, schema.optional()])) as {
      [K in keyof typeof crmFieldShape]: z.ZodOptional<(typeof crmFieldShape)[K]>;
    }),
    tags: tagsSchema.optional(),
    /** false restores an archived organisation; archive itself is POST .../archive. */
    archived: z.literal(false).optional(),
  })
  .strict()
  .refine(oneAccountOwner, oneAccountOwnerMessage);
export type UpdateOrganisation = z.input<typeof updateOrganisationSchema>;

/**
 * PUT .../organisations/:organisationId/website-link (GRE-2682): a person links the organisation to a website
 * organisation (website customers.id) picked from the site's customers, or clears the link with null. Linking names
 * the site the id was picked from, so the server can check the id is there.
 */
export const setOrganisationWebsiteLinkSchema = z
  .object({
    websiteOrganisationId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,80}$/, "Not a website organisation id")
      .nullable(),
    siteId: z.string().uuid().optional(),
  })
  .strict()
  .refine((value) => value.websiteOrganisationId === null || value.siteId !== undefined, {
    message: "Say which website the organisation is on",
    path: ["siteId"],
  });
export type SetOrganisationWebsiteLink = z.input<typeof setOrganisationWebsiteLinkSchema>;

export const listOrganisationsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: organisationStatusSchema.optional(),
    /** Only organisations with a live case in this pipeline (GRE-1540). */
    pipelineId: z.string().guid().optional(),
    /** Only organisations with a live case in this stage. */
    stageId: z.string().guid().optional(),
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();
export type ListOrganisationsQuery = z.infer<typeof listOrganisationsQuerySchema>;

export const createOrganisationContactSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(300),
    role: optionalText(200),
    email: z
      .string()
      .trim()
      .max(320)
      .nullish()
      .transform((value) => (value ? value : null))
      .pipe(z.string().email("Enter a valid email").nullable()),
    phone: optionalText(80),
    isKeyContact: z.boolean().default(false),
    source: organisationSourceSchema.default("manual"),
    externalId: externalIdSchema,
  })
  .strict();
export type CreateOrganisationContact = z.input<typeof createOrganisationContactSchema>;

export const updateOrganisationContactSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(300).optional(),
    role: optionalText(200).optional(),
    email: z
      .string()
      .trim()
      .max(320)
      .nullish()
      .transform((value) => (value ? value : null))
      .pipe(z.string().email("Enter a valid email").nullable())
      .optional(),
    phone: optionalText(80).optional(),
    isKeyContact: z.boolean().optional(),
    archived: z.literal(false).optional(),
  })
  .strict();
export type UpdateOrganisationContact = z.input<typeof updateOrganisationContactSchema>;

/** Body of the read-only Pipedrive import (GRE-1479): which company connection to read from. */
export const importOrganisationsFromPipedriveSchema = z
  .object({
    connectionId: z.string().guid(),
  })
  .strict();
export type ImportOrganisationsFromPipedrive = z.infer<typeof importOrganisationsFromPipedriveSchema>;

/** Largest single export file accepted, in characters (the request body limit is 10 MB). */
export const PIPEDRIVE_EXPORT_FILE_MAX_CHARS = 3_000_000;

const exportFile = z.string().max(PIPEDRIVE_EXPORT_FILE_MAX_CHARS, "This file is too large. Export fewer columns or split it.");

/**
 * Body of the Pipedrive export import: the CSV text of each file Pipedrive
 * exports, any of them optional but at least one. Deals become client cases
 * only when a pipeline is chosen.
 */
export const importPipedriveExportSchema = z
  .object({
    organisations: exportFile.optional(),
    people: exportFile.optional(),
    deals: exportFile.optional(),
    activities: exportFile.optional(),
    pipelineId: z.string().guid().optional(),
  })
  .strict()
  .refine((body) => Boolean(body.organisations || body.people || body.deals || body.activities), {
    message: "Choose at least one Pipedrive export file",
  });
export type ImportPipedriveExport = z.infer<typeof importPipedriveExportSchema>;

/**
 * Body of POST .../organisations/import/hubspot-export: the CSV text of HubSpot's
 * companies, contacts and deals exports, any of them optional but at least one.
 * Open deals become client cases only when a pipeline is chosen.
 */
export const importHubspotExportSchema = z
  .object({
    companies: exportFile.optional(),
    contacts: exportFile.optional(),
    deals: exportFile.optional(),
    pipelineId: z.string().guid().optional(),
  })
  .strict()
  .refine((body) => Boolean(body.companies || body.contacts || body.deals), {
    message: "Choose at least one HubSpot export file",
  });
export type ImportHubspotExport = z.infer<typeof importHubspotExportSchema>;
