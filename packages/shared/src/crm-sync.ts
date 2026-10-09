// Two-way CRM sync contract (GRE-1074). Constants and the three-value field
// rule shared by server and UI. No sync job or external call lives here; see
// doc/CRM-SYNC-CONTRACT.md for the endpoints.

/** What the external side of a binding is: a CRM pipeline or a Notion database. */
export const CRM_SYNC_CONTAINER_KINDS = ["crm_pipeline", "notion_database"] as const;
export type CrmSyncContainerKind = (typeof CRM_SYNC_CONTAINER_KINDS)[number];

/** Which way a binding is allowed to move data. */
export const CRM_SYNC_BINDING_DIRECTIONS = ["both", "inbound_only", "outbound_only"] as const;
export type CrmSyncBindingDirection = (typeof CRM_SYNC_BINDING_DIRECTIONS)[number];

export const CRM_SYNC_BINDING_STATUSES = ["active", "paused", "error"] as const;
export type CrmSyncBindingStatus = (typeof CRM_SYNC_BINDING_STATUSES)[number];

/**
 * One owner per mapped field.
 * - crm: the CRM is the source of truth; GSAM edits are overwritten.
 * - gsam: GSAM is the source of truth; CRM edits are overwritten.
 * - shared: either side may edit; a change on both sides is a conflict.
 */
export const CRM_SYNC_FIELD_OWNERS = ["crm", "gsam", "shared"] as const;
export type CrmSyncFieldOwner = (typeof CRM_SYNC_FIELD_OWNERS)[number];

/** Built-in contact fields a field map may target as `contact.<field>`. */
export const CRM_SYNC_CONTACT_FIELDS = ["name", "role", "phone", "email"] as const;
export type CrmSyncContactField = (typeof CRM_SYNC_CONTACT_FIELDS)[number];

/** GSAM records that can hold external ids (one per source). */
export const CRM_SYNC_ENTITY_KINDS = ["case", "contact"] as const;
export type CrmSyncEntityKind = (typeof CRM_SYNC_ENTITY_KINDS)[number];

export const CRM_SYNC_EVENT_DIRECTIONS = ["inbound", "outbound"] as const;
export type CrmSyncEventDirection = (typeof CRM_SYNC_EVENT_DIRECTIONS)[number];

export const CRM_SYNC_EVENT_ACTIONS = ["created", "updated", "unchanged", "conflict", "failed"] as const;
export type CrmSyncEventAction = (typeof CRM_SYNC_EVENT_ACTIONS)[number];

export const CRM_SYNC_CONFLICT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type CrmSyncConflictStatus = (typeof CRM_SYNC_CONFLICT_STATUSES)[number];

export const CRM_SYNC_CONFLICT_RESOLUTIONS = ["keep_crm", "keep_gsam", "custom"] as const;
export type CrmSyncConflictResolution = (typeof CRM_SYNC_CONFLICT_RESOLUTIONS)[number];

/**
 * What holds a field in the "Sync conflicts" queue (GRE-1076).
 * - conflict: a shared field changed on both sides since the last sync.
 * - suggestion: a GSAM user or agent asked to change a CRM-owned field; it is
 *   written to the CRM only after a person accepts it.
 */
export const CRM_SYNC_CONFLICT_KINDS = ["conflict", "suggestion"] as const;
export type CrmSyncConflictKind = (typeof CRM_SYNC_CONFLICT_KINDS)[number];

/** Someone who changed the GSAM side of a held field. */
export type CrmSyncChangeAuthor =
  | { actorType: "user"; userId: string }
  | { actorType: "agent"; agentId: string };

/**
 * Nobody resolves a conflict that holds only their own change: true when the
 * GSAM side was changed by this user and nobody else. The CRM side is not
 * counted because CRM users are not matched to GSAM users yet.
 */
export function crmSyncIsOwnChangeOnly(authors: CrmSyncChangeAuthor[], userId: string): boolean {
  return authors.length > 0 && authors.every((author) => author.actorType === "user" && author.userId === userId);
}

/** A mapped field value. Kept to plain JSON values so it can be stored and compared. */
export type CrmSyncFieldValue = string | number | boolean | null | string[];

export type CrmSyncFieldDecision =
  /** Both sides already agree. Record `value` as the new last-synced value. */
  | { action: "none"; value: CrmSyncFieldValue }
  /** Write `value` into GSAM. */
  | { action: "pull_from_crm"; value: CrmSyncFieldValue }
  /** Write `value` into the CRM. */
  | { action: "push_to_crm"; value: CrmSyncFieldValue }
  /** Both sides changed a shared field to different values. Queue it; write nothing. */
  | { action: "conflict" };

export interface CrmSyncFieldInput {
  owner: CrmSyncFieldOwner;
  /** Value both sides held after the last successful sync. `undefined` when never synced. */
  lastSynced: CrmSyncFieldValue | undefined;
  crm: CrmSyncFieldValue;
  gsam: CrmSyncFieldValue;
}

function isEmptyValue(value: CrmSyncFieldValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Compares two field values. Empty values (null, missing, blank string, empty
 * list) are equal to each other; strings compare after trimming; lists compare
 * in order.
 */
export function crmSyncValuesEqual(
  a: CrmSyncFieldValue | undefined,
  b: CrmSyncFieldValue | undefined,
): boolean {
  if (isEmptyValue(a) || isEmptyValue(b)) return isEmptyValue(a) && isEmptyValue(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => item.trim() === b[index]!.trim());
  }
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

/**
 * The three-value rule. Compares the last-synced value with the current CRM
 * and GSAM values and says what one sync pass should do with the field.
 */
export function decideCrmSyncField(input: CrmSyncFieldInput): CrmSyncFieldDecision {
  const { owner, lastSynced, crm, gsam } = input;
  if (crmSyncValuesEqual(crm, gsam)) return { action: "none", value: crm };
  if (owner === "crm") return { action: "pull_from_crm", value: crm };
  if (owner === "gsam") return { action: "push_to_crm", value: gsam };

  // Shared field and the two sides differ.
  if (lastSynced === undefined) {
    // First sync has no base: fill an empty side, otherwise ask a person.
    if (isEmptyValue(gsam)) return { action: "pull_from_crm", value: crm };
    if (isEmptyValue(crm)) return { action: "push_to_crm", value: gsam };
    return { action: "conflict" };
  }
  const crmChanged = !crmSyncValuesEqual(crm, lastSynced);
  const gsamChanged = !crmSyncValuesEqual(gsam, lastSynced);
  if (crmChanged && !gsamChanged) return { action: "pull_from_crm", value: crm };
  if (gsamChanged && !crmChanged) return { action: "push_to_crm", value: gsam };
  return { action: "conflict" };
}
