import type { OrganisationSource, OrganisationStatus } from "../organisations.js";

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
  status: OrganisationStatus;
  notes: string | null;
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
  source: "pipedrive";
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
