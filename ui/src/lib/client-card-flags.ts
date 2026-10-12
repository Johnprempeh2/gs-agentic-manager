// Attention flags for client cards on the "Client journey" pipeline board
// (GRE-1049). A card counts as a client card when its fields carry a
// last-contact date; other pipelines never show these flags.

import { daysInStage } from "./client-case";

export const NO_CONTACT_FLAG_DAYS = 14;
export const STUCK_STAGE_FLAG_DAYS = 30;

// B2 reads `lastContact`; accept the usual spellings for fields set up by hand.
const LAST_CONTACT_FIELD_KEYS = [
  "lastContact",
  "last_contact",
  "lastContactAt",
  "last_contact_at",
  "lastContactDate",
  "last_contact_date",
  "Last contact",
] as const;

export interface ClientCardFlagInput {
  fields?: Record<string, unknown> | null;
  stageEnteredAt?: Date | string | null;
  terminalKind?: string | null;
}

export interface ClientCardFlags {
  /** Days since last contact, set only when it is NO_CONTACT_FLAG_DAYS or more. */
  noContactDays: number | null;
  /** Days in the current stage, set only when it is STUCK_STAGE_FLAG_DAYS or more. */
  stuckStageDays: number | null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isClientCard(fields: Record<string, unknown> | null | undefined) {
  if (!fields) return false;
  return LAST_CONTACT_FIELD_KEYS.some((key) => key in fields);
}

export function readLastContactDate(fields: Record<string, unknown> | null | undefined): Date | null {
  if (!fields) return null;
  for (const key of LAST_CONTACT_FIELD_KEYS) {
    const date = toDate(fields[key]);
    if (date) return date;
  }
  return null;
}

export function getClientCardFlags(input: ClientCardFlagInput, now: Date = new Date()): ClientCardFlags {
  const none: ClientCardFlags = { noContactDays: null, stuckStageDays: null };
  // Done, lost and paused-out cases have left the journey; no nudges for them.
  if (input.terminalKind || !isClientCard(input.fields)) return none;

  const lastContact = readLastContactDate(input.fields);
  const contactDays = lastContact ? daysInStage(lastContact, now) : null;
  const stageEnteredAt = toDate(input.stageEnteredAt);
  const stageDays = stageEnteredAt ? daysInStage(stageEnteredAt, now) : null;

  return {
    noContactDays: contactDays != null && contactDays >= NO_CONTACT_FLAG_DAYS ? contactDays : null,
    stuckStageDays: stageDays != null && stageDays >= STUCK_STAGE_FLAG_DAYS ? stageDays : null,
  };
}
