import { z } from "zod";
import { ORGANISATION_SOURCES, ORGANISATION_STATUSES } from "../organisations.js";

export const organisationStatusSchema = z.enum(ORGANISATION_STATUSES);
export const organisationSourceSchema = z.enum(ORGANISATION_SOURCES);

/** Optional text: blank becomes null so the list shows "not set". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const externalIdSchema = z.string().trim().min(1).max(200).nullish();

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
    source: organisationSourceSchema.default("manual"),
    externalId: externalIdSchema,
  })
  .strict();
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
    /** false restores an archived organisation; archive itself is POST .../archive. */
    archived: z.literal(false).optional(),
  })
  .strict();
export type UpdateOrganisation = z.input<typeof updateOrganisationSchema>;

export const listOrganisationsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: organisationStatusSchema.optional(),
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
