import type {
  OrganisationOwnershipType,
  OrganisationSizeBand,
  OrganisationSource,
  OrganisationStatus,
} from "../organisations.js";

/** API response shapes for CRM organisations (GRE-1477). Every record is scoped to one company. */

export interface OrganisationContact {
  id: string;
  companyId: string;
  organisationId: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isKeyContact: boolean;
  source: OrganisationSource;
  externalId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Organisation {
  id: string;
  companyId: string;
  name: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  countryOwner: string | null;
  /** The member who owns the country, when the owner is a GSAM user. */
  countryOwnerUserId?: string | null;
  status: OrganisationStatus;
  notes: string | null;
  // Global CRM fields (GRE-1539). All optional; `country` above is the address country.
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
  /** ISO 4217 code such as "GBP"; set together with annualRevenue. */
  annualRevenueCurrency: string | null;
  ownershipType: OrganisationOwnershipType | null;
  /** Another organisation of the same company. */
  parentOrganisationId: string | null;
  linkedinUrl: string | null;
  /** Account owner: one person or one agent of the company, never both. */
  accountOwnerUserId: string | null;
  accountOwnerAgentId: string | null;
  segment: string | null;
  tags: string[];
  description: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  source: OrganisationSource;
  externalId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One live pipeline case about an organisation, and the stage it is in now (GRE-1540). */
export interface OrganisationPipelineStage {
  caseId: string;
  caseKey: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  stageKind: string;
  terminalKind: "done" | "cancelled" | null;
}

/** One row on the Organisations list: the organisation, its key contacts and where it is in the pipelines. */
export interface OrganisationListItem extends Organisation {
  keyContacts: Pick<OrganisationContact, "id" | "name" | "role" | "email" | "phone">[];
  contactCount: number;
  /** Live cases in pipelines that are not archived, by pipeline name then stage order. */
  pipelines: OrganisationPipelineStage[];
}

export interface OrganisationDetail extends Organisation {
  contacts: OrganisationContact[];
}

/** Counts for one record kind in an import run (GRE-1479). Unchanged rows count as skipped. */
export interface OrganisationImportCounts {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Answer of POST .../organisations/import/pipedrive and .../import/pipedrive-export.
 * Nothing is written to Pipedrive.
 */
export interface OrganisationImportResult {
  source: "pipedrive" | "hubspot";
  organisations: OrganisationImportCounts;
  contacts: OrganisationImportCounts;
  /** Export import only: deals added as client cases in the chosen pipeline. */
  deals?: OrganisationImportCounts;
  /** Export import only: activities attached to the imported deals' cases. */
  activities?: OrganisationImportCounts;
  /** Up to 20 errors, so a person can see what failed without reading the logs. */
  errorSamples: Array<{ kind: "organisation" | "contact" | "deal" | "activity"; externalId: string; message: string }>;
  startedAt: string;
  finishedAt: string;
}

/** One stage change on a case: a transition, or a forced move. */
export interface OrganisationHistoryStageChange {
  id: string;
  at: string;
  fromStageName: string | null;
  toStageName: string | null;
  forced: boolean;
  actorType: "user" | "agent" | "system";
  /** Agent name when an agent made the change; null for people and the system. */
  actorAgentName: string | null;
}

/** One pipeline case about the organisation, with what is linked to it. */
export interface OrganisationHistoryCase {
  id: string;
  caseKey: string;
  title: string;
  pipelineId: string;
  pipelineName: string;
  stageName: string;
  stageKind: string;
  terminalKind: "done" | "cancelled" | null;
  /** The client's NDA and engagement pack, as on the journey (Ben, 12 Oct). */
  ndaStatus?: "required" | "accepted" | "suspended";
  engagementStatus?: "not_sent" | "sent" | "accepted";
  createdAt: string;
  updatedAt: string;
  /** Oldest first. */
  stageChanges: OrganisationHistoryStageChange[];
  projects: Array<{ id: string; name: string; status: string }>;
  tasks: Array<{ id: string; identifier: string | null; title: string; status: string; updatedAt: string }>;
}

/**
 * Answer of GET .../organisations/:organisationId/history (GRE-1480): every
 * live pipeline case for the organisation, newest activity first.
 */
export interface OrganisationHistory {
  organisationId: string;
  /** Latest activity on any of its cases or linked tasks; null when there is none. */
  lastContactAt: string | null;
  cases: OrganisationHistoryCase[];
}
