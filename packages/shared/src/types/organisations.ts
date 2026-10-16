import type { OrganisationSource, OrganisationStatus } from "../organisations.js";

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
  /** Imported fields with no column of their own (custom fields, labels, address), in the CRM's order. */
  crmFields?: CrmRecordField[];
  source: OrganisationSource;
  externalId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row on the Organisations list: the organisation and its key contacts. */
export interface OrganisationListItem extends Organisation {
  keyContacts: Pick<OrganisationContact, "id" | "name" | "role" | "email" | "phone">[];
  contactCount: number;
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
  /** Up to 20 errors, so a person can see what failed without reading the logs. */
  errorSamples: Array<{ kind: "organisation" | "contact" | "deal" | "activity" | "pipeline" | "note" | "call" | "email" | "product" | "lead" | "file"; externalId: string; message: string }>;
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
  /** Activities, notes and calls about it, its people or its cases, newest first. */
  timeline?: CrmTimelineEntry[];
  /** Files from a CRM on it, its people or its cases, newest first. */
  files?: CrmFile[];
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
  kind: "activity" | "note" | "call" | "email" | "stage_change";
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
