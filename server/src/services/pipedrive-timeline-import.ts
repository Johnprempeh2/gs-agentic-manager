// Read-only import of Pipedrive activities, notes and call logs into the CRM
// timeline (John, 16 Oct: every bit of client information must come across).
// Each entry links to the organisation, person and deal case it was about, by
// Pipedrive id. Rows are keyed on source, kind and Pipedrive id, so a rerun
// updates them. Nothing is written to Pipedrive.
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { crmTimelineEntries } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult } from "@greatstone/shared";
import { PipedriveAuthError, PipedriveApiError, type PipedriveClient } from "./crm-sync-pipedrive.js";

const SOURCE = "pipedrive";
const MAX_ERROR_SAMPLES = 20;
const MAX_BODY = 50_000;

type EntryKind = "activity" | "note" | "call" | "email" | "stage_change";

/** Deal fields whose changes make the deal's stage history. */
const HISTORY_FIELDS: Record<string, string> = { stage_id: "Stage", pipeline_id: "Pipeline", status: "Status" };
type EntryRow = typeof crmTimelineEntries.$inferSelect;
type EntryValues = Omit<typeof crmTimelineEntries.$inferInsert, "id" | "companyId" | "source" | "createdAt" | "updatedAt">;

export interface TimelineLinks {
  organisationIdByExternalId: Map<string, string>;
  contactIdByExternalId: Map<string, string>;
  caseIdByDealId: Map<string, string>;
  /** GSAM case id of every imported lead, by Pipedrive lead id. */
  caseIdByLeadId?: Map<string, string>;
  users: Map<string, string>;
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

function nameOf(value: unknown, users: Map<string, string>): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.name) ?? (idOf(record) ? users.get(idOf(record)!) ?? null : null);
  }
  const id = str(value);
  return id ? users.get(id) ?? null : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };

/** Pipedrive notes and activity notes are HTML; GSAM keeps them as plain text with line breaks. */
export function htmlToText(value: unknown): string | null {
  const html = str(value);
  if (!html) return null;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (match, code: string) => {
      const lower = code.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, MAX_BODY) : null;
}

/** "2026-10-01" plus "14:30" (UTC, as Pipedrive stores it) or a "2026-10-01 14:30:00" time, as a Date. */
export function pipedriveTime(dateOrTime: unknown, time?: unknown): Date | null {
  const raw = str(dateOrTime);
  if (!raw) return null;
  const clock = str(time);
  const text = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${clock && /^\d{2}:\d{2}/.test(clock) ? clock.slice(0, 5) : "00:00"}:00Z` : `${raw.replace(" ", "T")}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? "" : "Z"}`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "01:30" -> 90. */
function minutesOf(value: unknown): number | null {
  const text = str(value);
  const match = text ? /^(\d{1,3}):(\d{2})/.exec(text) : null;
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes > 0 ? minutes : null;
}

function links(record: Record<string, unknown>, map: TimelineLinks) {
  const orgId = idOf(record.org_id);
  const personId = idOf(record.person_id);
  const dealId = idOf(record.deal_id);
  const leadId = idOf(record.lead_id);
  return {
    organisationId: orgId ? map.organisationIdByExternalId.get(orgId) ?? null : null,
    contactId: personId ? map.contactIdByExternalId.get(personId) ?? null : null,
    // An activity or note on a lead links to the lead's case.
    caseId: (dealId ? map.caseIdByDealId.get(dealId) : undefined) ?? (leadId ? map.caseIdByLeadId?.get(leadId) : undefined) ?? null,
  };
}

function compact(details: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(details).filter(([, value]) =>
    value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
}

export function mapPipedriveActivity(activity: Record<string, unknown>, map: TimelineLinks): EntryValues | null {
  const externalId = str(activity.id);
  if (!externalId) return null;
  const participants = Array.isArray(activity.participants)
    ? activity.participants.flatMap((item) => {
      const id = idOf((item as Record<string, unknown>)?.person_id);
      return id ? [id] : [];
    })
    : [];
  const attendees = Array.isArray(activity.attendees)
    ? activity.attendees.flatMap((item) => {
      const record = item as Record<string, unknown>;
      const label = str(record?.name) ?? str(record?.email_address);
      return label ? [label] : [];
    })
    : [];
  return {
    externalId,
    kind: "activity",
    activityType: str(activity.type),
    subject: str(activity.subject)?.slice(0, 1_000) ?? null,
    body: htmlToText(activity.note),
    occurredAt: pipedriveTime(activity.due_date, activity.due_time) ?? pipedriveTime(activity.add_time),
    durationMinutes: minutesOf(activity.duration),
    done: typeof activity.done === "boolean" ? activity.done : activity.done === 1 ? true : activity.done === 0 ? false : null,
    ownerName: nameOf(activity.user_id ?? activity.owner_name, map.users) ?? str(activity.owner_name),
    ...links(activity, map),
    details: compact({
      location: str(activity.location) ?? str((activity.location as Record<string, unknown> | null)?.value),
      publicDescription: htmlToText(activity.public_description),
      doneAt: str(activity.marked_as_done_time),
      busy: activity.busy_flag === true ? true : null,
      participantPersonIds: participants,
      attendees,
      personName: str(activity.person_name),
      organisationName: str(activity.org_name),
      dealTitle: str(activity.deal_title),
      leadId: str(activity.lead_id),
    }),
  };
}

export function mapPipedriveNote(note: Record<string, unknown>, map: TimelineLinks): EntryValues | null {
  const externalId = str(note.id);
  const body = htmlToText(note.content);
  if (!externalId || !body) return null;
  const pinned = ["pinned_to_deal_flag", "pinned_to_person_flag", "pinned_to_organization_flag", "pinned_to_lead_flag"]
    .some((key) => note[key] === true || note[key] === 1);
  return {
    externalId,
    kind: "note",
    activityType: null,
    subject: null,
    body,
    occurredAt: pipedriveTime(note.add_time),
    durationMinutes: null,
    done: null,
    ownerName: nameOf(note.user ?? note.user_id, map.users),
    ...links(note, map),
    details: compact({ pinned: pinned ? true : null, leadId: str(note.lead_id), updatedAt: str(note.update_time) }),
  };
}

export function mapPipedriveCallLog(call: Record<string, unknown>, map: TimelineLinks): EntryValues | null {
  const externalId = str(call.id);
  if (!externalId) return null;
  const seconds = Number(call.duration);
  return {
    externalId,
    kind: "call",
    activityType: "call",
    subject: str(call.subject)?.slice(0, 1_000) ?? null,
    body: htmlToText(call.note),
    occurredAt: pipedriveTime(call.start_time),
    durationMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null,
    done: true,
    ownerName: nameOf(call.user_id, map.users),
    ...links(call, map),
    details: compact({
      outcome: str(call.outcome),
      toPhone: str(call.to_phone_number),
      fromPhone: str(call.from_phone_number),
      endedAt: str(call.end_time),
      activityId: str(call.activity_id),
      hasRecording: call.has_recording === true ? true : null,
    }),
  };
}

/** JSON with object keys sorted, because jsonb does not keep key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item as Record<string, unknown> | null;
    const email = str(record?.email_address);
    const name = str(record?.name);
    if (!email && !name) return [];
    return [name && email && name !== email ? `${name} <${email}>` : (email ?? name)!];
  });
}

/** One deal flow item as a timeline entry: an email or a stage, pipeline or status change. Others are imported elsewhere. */
export function mapPipedriveFlowItem(item: Record<string, unknown>, dealId: string, map: TimelineLinks): EntryValues | null {
  const data = item.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;
  const caseId = map.caseIdByDealId.get(dealId) ?? null;
  if (item.object === "dealChange") {
    const field = str(data.field_key);
    const label = field ? HISTORY_FIELDS[field] : undefined;
    const externalId = str(data.id);
    if (!label || !externalId) return null;
    const extra = (data.additional_data ?? {}) as Record<string, unknown>;
    const from = str(extra.old_value_formatted) ?? str(data.old_value);
    const to = str(extra.new_value_formatted) ?? str(data.new_value);
    return {
      externalId,
      kind: "stage_change",
      activityType: field,
      subject: `${label}: ${from ?? "none"} → ${to ?? "none"}`,
      body: null,
      occurredAt: pipedriveTime(data.log_time) ?? pipedriveTime(item.timestamp),
      durationMinutes: null,
      done: null,
      ownerName: nameOf(data.user_id, map.users),
      organisationId: null,
      contactId: null,
      caseId,
      details: compact({ field, from, to, fromId: str(data.old_value), toId: str(data.new_value), source: str(data.change_source) }),
    };
  }
  if (item.object === "mailMessage") {
    const externalId = str(data.id);
    if (!externalId) return null;
    return {
      externalId,
      kind: "email",
      activityType: "email",
      subject: str(data.subject)?.slice(0, 1_000) ?? null,
      body: htmlToText(data.snippet ?? data.body),
      occurredAt: pipedriveTime(data.message_time) ?? pipedriveTime(data.add_time) ?? pipedriveTime(item.timestamp),
      durationMinutes: null,
      done: null,
      ownerName: nameOf(data.user_id, map.users),
      organisationId: null,
      contactId: null,
      caseId,
      details: compact({
        from: addressList(data.from),
        to: addressList(data.to),
        cc: addressList(data.cc),
        hasAttachments: data.has_attachments_flag === true || data.has_attachments_flag === 1 ? true : null,
        threadId: str(data.mail_thread_id),
      }),
    };
  }
  return null;
}

function sameEntry(row: EntryRow, values: EntryValues) {
  return row.activityType === (values.activityType ?? null)
    && row.subject === (values.subject ?? null)
    && row.body === (values.body ?? null)
    && (row.occurredAt?.getTime() ?? null) === (values.occurredAt?.getTime() ?? null)
    && row.durationMinutes === (values.durationMinutes ?? null)
    && row.done === (values.done ?? null)
    && row.ownerName === (values.ownerName ?? null)
    && row.organisationId === (values.organisationId ?? null)
    && row.contactId === (values.contactId ?? null)
    && row.caseId === (values.caseId ?? null)
    && stableJson(row.details ?? {}) === stableJson(values.details ?? {});
}

const emptyCounts = (): OrganisationImportCounts => ({ created: 0, updated: 0, skipped: 0, errors: 0 });

export function pipedriveTimelineImportService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  return {
    async run(input: { companyId: string; client: PipedriveClient; links: TimelineLinks; result: OrganisationImportResult }) {
      const { companyId, client, result } = input;
      const counts = {
        activities: emptyCounts(),
        notes: emptyCounts(),
        calls: emptyCounts(),
        emails: emptyCounts(),
        stageChanges: emptyCounts(),
      };
      result.activities = counts.activities;
      result.notes = counts.notes;
      result.calls = counts.calls;
      result.emails = counts.emails;
      result.stageChanges = counts.stageChanges;

      const existing = new Map<string, EntryRow>();
      const rows = await db.select().from(crmTimelineEntries)
        .where(and(eq(crmTimelineEntries.companyId, companyId), eq(crmTimelineEntries.source, SOURCE)));
      for (const row of rows) existing.set(`${row.kind}:${row.externalId}`, row);

      const write = async (kind: EntryKind, values: EntryValues | null, count: OrganisationImportCounts) => {
        if (!values) {
          count.skipped += 1;
          return;
        }
        try {
          const current = existing.get(`${kind}:${values.externalId}`);
          if (!current) {
            const [row] = await db.insert(crmTimelineEntries).values({ ...values, companyId, source: SOURCE }).returning();
            existing.set(`${kind}:${values.externalId}`, row!);
            count.created += 1;
          } else if (sameEntry(current, values)) {
            count.skipped += 1;
          } else {
            const [row] = await db.update(crmTimelineEntries).set({ ...values, updatedAt: now() })
              .where(and(eq(crmTimelineEntries.companyId, companyId), eq(crmTimelineEntries.id, current.id)))
              .returning();
            existing.set(`${kind}:${values.externalId}`, row!);
            count.updated += 1;
          }
        } catch (error) {
          count.errors += 1;
          if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
            result.errorSamples.push({
              kind: kind === "stage_change" ? "deal" : kind,
              externalId: values.externalId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };

      const pages: Array<[EntryKind, (start: number) => ReturnType<PipedriveClient["listNotesPage"]>, typeof mapPipedriveNote, OrganisationImportCounts]> = [
        ["activity", (start) => client.listActivitiesPage({ start }), mapPipedriveActivity, counts.activities],
        ["note", (start) => client.listNotesPage({ start }), mapPipedriveNote, counts.notes],
        ["call", (start) => client.listCallLogsPage({ start }), mapPipedriveCallLog, counts.calls],
      ];
      for (const [kind, list, map, count] of pages) {
        let start: number | null = 0;
        while (start !== null) {
          let page: Awaited<ReturnType<typeof list>>;
          try {
            page = await list(start);
          } catch (error) {
            // Call logs need a Pipedrive plan or scope some accounts lack; the rest of the import still counts.
            if (kind !== "call" || !(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
            count.errors += 1;
            if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
              result.errorSamples.push({ kind: "call", externalId: "all", message: `Pipedrive did not share call logs: ${error.message}` });
            }
            break;
          }
          for (const item of page.items) await write(kind, map(item, input.links), count);
          start = page.nextStart;
        }
      }

      // Each deal's history holds its emails and its stage changes; one read per deal.
      flow: for (const dealId of input.links.caseIdByDealId.keys()) {
        let start: number | null = 0;
        while (start !== null) {
          let page: Awaited<ReturnType<PipedriveClient["listDealFlowPage"]>>;
          try {
            page = await client.listDealFlowPage({ dealId, start });
          } catch (error) {
            if (error instanceof PipedriveAuthError) {
              // The token cannot read deal history at all; stop asking for every deal.
              counts.stageChanges.errors += 1;
              if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
                result.errorSamples.push({ kind: "deal", externalId: dealId, message: `Pipedrive did not share deal history: ${error.message}` });
              }
              break flow;
            }
            if (!(error instanceof PipedriveApiError)) throw error;
            counts.stageChanges.errors += 1;
            if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
              result.errorSamples.push({ kind: "deal", externalId: dealId, message: `Could not read the deal history: ${error.message}` });
            }
            break;
          }
          for (const item of page.items) {
            const kind = item.object === "mailMessage" ? "email" : item.object === "dealChange" ? "stage_change" : null;
            if (!kind) continue;
            const values = mapPipedriveFlowItem(item, dealId, input.links);
            // Field changes other than stage, pipeline and status are not history entries.
            if (!values && kind === "stage_change") continue;
            await write(kind, values, kind === "email" ? counts.emails : counts.stageChanges);
          }
          start = page.nextStart;
        }
      }
      return counts;
    },
  };
}
