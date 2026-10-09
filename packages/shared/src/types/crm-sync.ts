import type {
  CrmSyncBindingDirection,
  CrmSyncBindingStatus,
  CrmSyncChangeAuthor,
  CrmSyncConflictKind,
  CrmSyncConflictResolution,
  CrmSyncConflictStatus,
  CrmSyncContainerKind,
  CrmSyncEntityKind,
  CrmSyncEventAction,
  CrmSyncEventDirection,
  CrmSyncFieldOwner,
  CrmSyncFieldValue,
} from "../crm-sync.js";

/** API response shapes for two-way CRM sync (GRE-1074). Every record is scoped to one company. */

export interface CrmSyncStageMapping {
  externalStageId: string;
  stageKey: string;
}

/** Links one external container (CRM pipeline or Notion database) to one GSAM pipeline. */
export interface CrmSyncBinding {
  id: string;
  companyId: string;
  connectionId: string;
  providerKey: string;
  containerKind: CrmSyncContainerKind;
  externalContainerId: string;
  externalContainerLabel: string | null;
  pipelineId: string;
  direction: CrmSyncBindingDirection;
  status: CrmSyncBindingStatus;
  stageMap: CrmSyncStageMapping[];
  openConflictCount: number;
  lastSyncedAt: string | null;
  lastErrorMessage: string | null;
  /** When the next poll may run. Null when the binding is not scheduled. */
  nextSyncAt: string | null;
  /** Set while the CRM is refusing calls for too many requests (429). */
  rateLimitedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 202 answer to `POST .../sync`. */
export interface CrmSyncRunQueued {
  bindingId: string;
  nextSyncAt: string;
}

/** Sync state of one source a case is linked to. */
export interface CrmSyncCaseSource {
  bindingId: string;
  connectionId: string;
  providerKey: string;
  externalContainerLabel: string | null;
  externalId: string;
  bindingStatus: CrmSyncBindingStatus;
  lastSyncedAt: string | null;
  lastErrorMessage: string | null;
  nextSyncAt: string | null;
  rateLimitedUntil: string | null;
  /** Newest sync log line for this case, if any. */
  lastEvent: CrmSyncEvent | null;
}

export interface CrmSyncCaseStatus {
  caseId: string;
  sources: CrmSyncCaseSource[];
}

export interface CrmSyncFieldMapEntry {
  id: string;
  bindingId: string;
  externalField: string;
  externalFieldLabel: string | null;
  gsamField: string;
  owner: CrmSyncFieldOwner;
}

export interface CrmSyncFieldMap {
  bindingId: string;
  fields: CrmSyncFieldMapEntry[];
  updatedAt: string;
}

/** External id held by a GSAM case or contact. One per source (connection). */
export interface CrmSyncRecordLink {
  id: string;
  companyId: string;
  entityKind: CrmSyncEntityKind;
  entityId: string;
  connectionId: string;
  providerKey: string;
  externalId: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface CrmSyncChangedField {
  gsamField: string;
  from: CrmSyncFieldValue;
  to: CrmSyncFieldValue;
}

/** One line of the sync log. */
export interface CrmSyncEvent {
  id: string;
  companyId: string;
  bindingId: string;
  direction: CrmSyncEventDirection;
  action: CrmSyncEventAction;
  entityKind: CrmSyncEntityKind;
  entityId: string | null;
  externalId: string;
  changedFields: CrmSyncChangedField[];
  conflictId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** An agent's (or person's) proposed resolution. A person with Administer accepts it. */
export interface CrmSyncConflictProposal {
  resolution: CrmSyncConflictResolution;
  value: CrmSyncFieldValue;
  reason: string;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  proposedAt: string;
}

export interface CrmSyncConflict {
  id: string;
  companyId: string;
  bindingId: string;
  kind: CrmSyncConflictKind;
  entityKind: CrmSyncEntityKind;
  entityId: string;
  externalId: string;
  gsamField: string;
  externalField: string;
  /** Missing when the field was never synced. */
  lastSyncedValue?: CrmSyncFieldValue;
  crmValue: CrmSyncFieldValue;
  /** For a suggestion, the suggested value. */
  gsamValue: CrmSyncFieldValue;
  /** When the CRM record last changed, as the CRM reports it. */
  crmChangedAt: string | null;
  /** Who changed the GSAM side since the last sync (the suggester, for a suggestion). */
  gsamChangedBy: CrmSyncChangeAuthor[];
  gsamChangedAt: string | null;
  /** Why the suggestion was made. Null for a conflict. */
  reason: string | null;
  proposal: CrmSyncConflictProposal | null;
  status: CrmSyncConflictStatus;
  resolution: CrmSyncConflictResolution | null;
  resolvedValue?: CrmSyncFieldValue;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedAt: string | null;
  /** Why it was resolved or dismissed. */
  decisionReason: string | null;
  detectedAt: string;
}

export interface CrmSyncPage<T> {
  items: T[];
  nextCursor: string | null;
}
