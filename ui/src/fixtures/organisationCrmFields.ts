import type { Organisation } from "@greatstone/shared";

/** Every global CRM field (GRE-1539) left empty, for organisation test rows. */
export const emptyOrganisationCrmFields = {
  legalName: null,
  domain: null,
  phone: null,
  email: null,
  addressStreet: null,
  addressCity: null,
  addressRegion: null,
  addressPostalCode: null,
  employeeCount: null,
  sizeBand: null,
  annualRevenue: null,
  annualRevenueCurrency: null,
  ownershipType: null,
  parentOrganisationId: null,
  linkedinUrl: null,
  accountOwnerUserId: null,
  accountOwnerAgentId: null,
  segment: null,
  tags: [],
  description: null,
  registrationNumber: null,
  taxId: null,
} satisfies Partial<Organisation>;
