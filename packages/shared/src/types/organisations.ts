import type {
  OrganisationOwnershipType,
  OrganisationSizeBand,
  OrganisationSource,
  OrganisationStatus,
} from "../organisations.js";

/** API response shapes for CRM organisations (GRE-1477). Every record is scoped to one company. */

/** A field imported from a CRM that has no column in GSAM, under the CRM's own name. */
export interface CrmRecordField {
  key: string;
  label: string;
  value: string | number | boolean | string[];
}

export interface OrganisationContact {
  id: string;
  companyId: string;
  /** Null for a person imported from a CRM with no organisation. */
  organisationId: string | null;
  name: string;
  role: string | null;
  /**
   * The person's account on the client website (GRE-2658). Set means the
   * website holds who they are and `email` is null; unset means a CRM entry
   * not yet linked to a website account.
   */
  websiteUserId?: string | null;
  email: string | null;
  phone: string | null;
  isKeyContact: boolean;
  /** Imported fields with no column of their own, in the CRM's order. */
  crmFields?: CrmRecordField[];
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
  /** Imported fields with no column of their own (custom fields, labels, address), in the CRM's order. */
  crmFields?: CrmRecordField[];
  source: OrganisationSource;
  externalId: string | null;
  /**
   * The website organisation (website customers.id) a person linked this organisation to (GRE-2682); null when it
   * is not linked. Never matched by name, domain or email.
   */
  websiteOrganisationId: string | null;
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

/** A person found by the people search, with the name of their organisation (null when they have none). */
export interface OrganisationPerson extends OrganisationContact {
  organisationName: string | null;
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
  /** Deals made into cases: in the chosen pipeline (export) or each deal's own pipeline (connection). */
  deals?: OrganisationImportCounts;
  /** Connection import only: Pipedrive pipelines made into GSAM pipelines with their stages. */
  pipelines?: OrganisationImportCounts;
  /** Activities: attached to the deals' cases (export), or on the timeline (connection). */
  activities?: OrganisationImportCounts;
  /** Connection import only: notes on the timeline. */
  notes?: OrganisationImportCounts;
  /** Connection import only: call logs on the timeline. */
  calls?: OrganisationImportCounts;
  /** Connection import only: emails from each deal's history. */
  emails?: OrganisationImportCounts;
  /** Connection import only: stage, pipeline and status changes from each deal's history. */
  stageChanges?: OrganisationImportCounts;
  /** Connection import only: the product catalogue. */
  products?: OrganisationImportCounts;
  /** Connection import only: the products on each deal, with quantity, price and discount. */
  dealProducts?: OrganisationImportCounts;
  /** Connection import only: the Leads inbox, as cases in the "Pipedrive leads" pipeline. */
  leads?: OrganisationImportCounts;
  /** Connection import only: files on deals, leads, people and organisations. */
  files?: OrganisationImportCounts;
  /** Connection import only: the people on each deal, kept as the case's contacts. */
  participants?: OrganisationImportCounts;
  /** Up to 20 errors, so a person can see what failed without reading the logs. */
  errorSamples: Array<{ kind: "organisation" | "contact" | "deal" | "activity" | "pipeline" | "note" | "call" | "email" | "product" | "lead" | "file" | "participant"; externalId: string; message: string }>;
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
  /** The case's filled-in fields under the pipeline's labels, such as a Pipedrive deal's value, owner and products. */
  details?: CrmRecordField[];
  /** The people on the case, main contact first. */
  people?: Array<{ name: string; role: string | null }>;
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
  /** Activities, notes and calls about it, its people or its cases, newest first. */
  timeline?: CrmTimelineEntry[];
  /** Files from a CRM on it, its people or its cases, newest first. */
  files?: CrmFile[];
}

/** Answer of GET /api/cases/:caseId/crm-history: what a CRM import filed on one client case. */
export interface PipelineCaseCrmHistory {
  caseId: string;
  /** Activities, notes, calls, emails and stage changes on the case, newest first. */
  timeline: CrmTimelineEntry[];
  /** Files that were on the deal or lead, newest first. */
  files: CrmFile[];
  /** True when the case has more entries than were returned. */
  truncated: boolean;
}

/** One file imported from a CRM. */
export interface CrmFile {
  id: string;
  source: string;
  name: string;
  contentType: string | null;
  byteSize: number | null;
  description: string | null;
  ownerName: string | null;
  addedAt: string | null;
  /** GSAM path that serves the copied file; null when the bytes were not copied. */
  contentPath: string | null;
  /** The CRM's own link, for a file linked from elsewhere or not copied. */
  remoteUrl: string | null;
  /** Why the bytes were not copied, such as a file linked from Google Drive. */
  notCopied: string | null;
  contactName: string | null;
  caseId: string | null;
  caseTitle: string | null;
}

/** One activity, note or call imported from a CRM. */
export interface CrmTimelineEntry {
  id: string;
  source: string;
  kind: "activity" | "note" | "call" | "email" | "stage_change" | "field_change";
  /** The CRM's activity type, such as call, meeting, task or email. */
  activityType: string | null;
  subject: string | null;
  body: string | null;
  occurredAt: string | null;
  durationMinutes: number | null;
  /** Activities only: done or still planned. */
  done: boolean | null;
  ownerName: string | null;
  contactId: string | null;
  contactName: string | null;
  caseId: string | null;
  caseTitle: string | null;
  /** Location, participants, outcome and anything else the CRM held. */
  details: Record<string, unknown>;
}

/** One price of a CRM product in one currency. */
export interface CrmProductPriceView {
  currency: string;
  price: number | null;
  cost: number | null;
  overheadCost: number | null;
}

/** A deal that includes a product, with what was sold on it. */
export interface CrmProductDeal {
  caseId: string;
  pipelineId: string;
  title: string;
  quantity: number | null;
  sum: number | null;
  currency: string | null;
}

/** A product from the CRM's catalogue, with the deals it is on (Pipedrive import). */
export interface CrmProduct {
  id: string;
  source: string;
  name: string;
  code: string | null;
  unit: string | null;
  description: string | null;
  tax: number | null;
  active: boolean;
  ownerName: string | null;
  prices: CrmProductPriceView[];
  fields: CrmRecordField[];
  deals: CrmProductDeal[];
}
