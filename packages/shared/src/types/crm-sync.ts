import type {
  CrmSyncBindingDirection,
  CrmSyncBindingStatus,
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
  createdAt: string;
  updatedAt: string;
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

export interface CrmSyncConflict {
  id: string;
  companyId: string;
  bindingId: string;
  entityKind: CrmSyncEntityKind;
  entityId: string;
  externalId: string;
  gsamField: string;
  externalField: string;
  /** Missing when the field was never synced. */
  lastSyncedValue?: CrmSyncFieldValue;
  crmValue: CrmSyncFieldValue;
  gsamValue: CrmSyncFieldValue;
  status: CrmSyncConflictStatus;
  resolution: CrmSyncConflictResolution | null;
  resolvedValue?: CrmSyncFieldValue;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedAt: string | null;
  detectedAt: string;
}

export interface CrmSyncPage<T> {
  items: T[];
  nextCursor: string | null;
}
