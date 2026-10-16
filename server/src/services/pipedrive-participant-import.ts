// Read-only import of the people and followers on each Pipedrive deal (John,
// 16 Oct: every bit of client information must come across). Participants
// become the case's contacts, the main contact first, each keyed on the
// Pipedrive person id so a rerun updates the same row and a person removed
// from the deal in Pipedrive leaves the case too. Contacts added by hand in
// GSAM are never touched. Followers are GSAM-side users, so they are kept as a
// "Followers" field on the case by the deal import. Nothing is written to
// Pipedrive.
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelineCaseContacts } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult } from "@greatstone/shared";
import type { PipedriveClient } from "./crm-sync-pipedrive.js";

const SOURCE = "pipedrive";
const MAX_ERROR_SAMPLES = 20;

export interface PipedriveParticipant {
  personId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isMain: boolean;
}

/** Details of a person already imported, by Pipedrive person id. */
export interface ImportedPerson {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.value ?? record.id);
  }
  return str(value);
}

/** The primary entry of a Pipedrive email or phone list, else the first one with a value. */
function primaryValue(value: unknown): string | null {
  if (!Array.isArray(value)) return str(value);
  const entries = value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  const primary = entries.find((entry) => entry.primary === true && str(entry.value));
  return str((primary ?? entries.find((entry) => str(entry.value)))?.value);
}

export function mapPipedriveParticipant(item: Record<string, unknown>, mainPersonId: string | null): PipedriveParticipant | null {
  if (item.active_flag === false) return null;
  const person = (item.person && typeof item.person === "object" ? item.person : item.person_id) as unknown;
  const record = person && typeof person === "object" && !Array.isArray(person) ? person as Record<string, unknown> : {};
  const personId = idOf(item.person_id) ?? str(record.id);
  if (!personId) return null;
  return {
    personId,
    name: str(record.name),
    email: primaryValue(record.email),
    phone: primaryValue(record.phone),
    isMain: personId === mainPersonId,
  };
}

/** Every person on one deal, the main contact first. Throws the client's errors. */
export async function readPipedriveDealParticipants(client: PipedriveClient, dealId: string, mainPersonId: string | null) {
  const people: PipedriveParticipant[] = [];
  const seen = new Set<string>();
  let start: number | null = 0;
  while (start !== null) {
    const page: Awaited<ReturnType<PipedriveClient["listDealParticipantsPage"]>> = await client.listDealParticipantsPage({ dealId, start });
    for (const item of page.items) {
      const mapped = mapPipedriveParticipant(item, mainPersonId);
      if (!mapped || seen.has(mapped.personId)) continue;
      seen.add(mapped.personId);
      people.push(mapped);
    }
    start = page.nextStart;
  }
  return [...people.filter((person) => person.isMain), ...people.filter((person) => !person.isMain)];
}

/** Names of the users following one deal, in Pipedrive's order. Throws the client's errors. */
export async function readPipedriveDealFollowers(client: PipedriveClient, dealId: string, users: Map<string, string>) {
  const names: string[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const page: Awaited<ReturnType<PipedriveClient["listDealFollowersPage"]>> = await client.listDealFollowersPage({ dealId, start });
    for (const item of page.items) {
      const userId = idOf(item.user_id);
      if (!userId) continue;
      const name = users.get(userId) ?? str(item.name) ?? `Pipedrive user ${userId}`;
      if (!names.includes(name)) names.push(name);
    }
    start = page.nextStart;
  }
  return names;
}

type ContactRow = typeof pipelineCaseContacts.$inferSelect;

export function pipedriveParticipantImportService(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  return {
    async run(input: {
      companyId: string;
      result: OrganisationImportResult;
      userId: string | null;
      caseIdByDealId: Map<string, string>;
      /** Deals whose participants could be read; a deal left out keeps the contacts it had. */
      participantsByDealId: Map<string, PipedriveParticipant[]>;
      people: Map<string, ImportedPerson>;
    }) {
      const { companyId, result } = input;
      const counts: OrganisationImportCounts = { created: 0, updated: 0, skipped: 0, errors: 0 };
      result.participants = counts;
      if (input.participantsByDealId.size === 0) return counts;

      const existingByCase = new Map<string, ContactRow[]>();
      for (const row of await db.select().from(pipelineCaseContacts).where(and(
        eq(pipelineCaseContacts.companyId, companyId),
        eq(pipelineCaseContacts.source, SOURCE),
      ))) {
        const rows = existingByCase.get(row.caseId) ?? [];
        rows.push(row);
        existingByCase.set(row.caseId, rows);
      }

      for (const [dealId, participants] of input.participantsByDealId) {
        const caseId = input.caseIdByDealId.get(dealId);
        if (!caseId) continue;
        try {
          const current = new Map((existingByCase.get(caseId) ?? []).map((row) => [row.externalId!, row]));
          for (const [index, participant] of participants.entries()) {
            const person = input.people.get(participant.personId);
            const role = participant.isMain
              ? person?.role ? `Main contact, ${person.role}` : "Main contact"
              : person?.role ?? null;
            const values = {
              name: (person?.name ?? participant.name ?? `Pipedrive person ${participant.personId}`).slice(0, 500),
              role,
              email: person?.email ?? participant.email,
              phone: person?.phone ?? participant.phone,
              position: index,
            };
            const row = current.get(participant.personId);
            current.delete(participant.personId);
            if (!row) {
              await db.insert(pipelineCaseContacts).values({
                ...values,
                companyId,
                caseId,
                source: SOURCE,
                externalId: participant.personId,
                createdByUserId: input.userId,
              });
              counts.created += 1;
            } else if (
              row.name === values.name && row.role === values.role && row.email === values.email
              && row.phone === values.phone && row.position === values.position
            ) {
              counts.skipped += 1;
            } else {
              await db.update(pipelineCaseContacts).set({ ...values, updatedAt: now() })
                .where(and(eq(pipelineCaseContacts.companyId, companyId), eq(pipelineCaseContacts.id, row.id)));
              counts.updated += 1;
            }
          }
          // People taken off the deal in Pipedrive leave the case too.
          for (const row of current.values()) {
            await db.delete(pipelineCaseContacts)
              .where(and(eq(pipelineCaseContacts.companyId, companyId), eq(pipelineCaseContacts.id, row.id)));
            counts.updated += 1;
          }
        } catch (error) {
          counts.errors += 1;
          if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
            result.errorSamples.push({ kind: "participant", externalId: dealId, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      return counts;
    },
  };
}
