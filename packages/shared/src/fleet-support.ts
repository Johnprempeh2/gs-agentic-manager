// Support ticket bridge over the fleet channel (GRE-1084, GRE-1069 slide 27,
// board direction GRE-1354).
//
// "Get help" in a client instance (the spoke) opens a ticket there. The
// host script sends a summary of it to the Greatstone hub in a signed fleet
// message; the hub files it in the client's support queue and answers with
// the status, SLA times and our replies. The spoke always asks; the hub never
// calls a spoke.
//
// The hub holds only: ticket id, client code, title, summary, priority,
// category, status, SLA times and our owner. A file goes to the hub only when
// the client picks it. Linked issues, run logs and records stay in the spoke:
// the schemas below have no field for them, and every object is strict.
//
// Support is bounded platform support. An optional quality review is its own
// kind, apart from platform faults. An upgrade request only opens a ticket: it
// never approves a purchase or spend; a person at Greatstone must act on it.

import { z } from "zod";

export const FLEET_SUPPORT_KINDS = ["support", "quality-review", "upgrade"] as const;
export type FleetSupportKind = (typeof FLEET_SUPPORT_KINDS)[number];

export const FLEET_SUPPORT_PRIORITIES = ["P1", "P2", "P3"] as const;
export type FleetSupportPriority = (typeof FLEET_SUPPORT_PRIORITIES)[number];

/** Hub triage: the kind of platform fault. Same values as support_tickets.category. */
export const FLEET_SUPPORT_CATEGORIES = ["general", "install", "reliability"] as const;
export type FleetSupportCategory = (typeof FLEET_SUPPORT_CATEGORIES)[number];

/**
 * What the client sees. `queued` is spoke-only: the ticket is not yet on the
 * hub. The hub maps its issue status to one of the others.
 */
export const CLIENT_SUPPORT_STATUSES = ["queued", "open", "in_progress", "resolved", "closed"] as const;
export type ClientSupportStatus = (typeof CLIENT_SUPPORT_STATUSES)[number];
export type FleetSupportHubStatus = Exclude<ClientSupportStatus, "queued">;

export function clientSupportStatusForIssue(issueStatus: string): FleetSupportHubStatus {
  if (issueStatus === "done") return "resolved";
  if (issueStatus === "cancelled") return "closed";
  if (issueStatus === "backlog" || issueStatus === "todo") return "open";
  return "in_progress";
}

/** Only P3 for kinds that are not a platform fault, so they never start the P1 path. */
export function fleetSupportPriority(kind: FleetSupportKind, asked: FleetSupportPriority): FleetSupportPriority {
  return kind === "support" ? asked : "P3";
}

export const FLEET_SUPPORT_TITLE_MAX = 200;
export const FLEET_SUPPORT_SUMMARY_MAX = 4000;
export const FLEET_SUPPORT_REPLY_MAX = 8000;
/** Tickets in one sync message. More wait for the next pass. */
export const FLEET_SUPPORT_SYNC_MAX_TICKETS = 10;
export const FLEET_SUPPORT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const FLEET_SUPPORT_ATTACHMENTS_PER_TICKET = 5;
/** Signed sync message limit; a ticket summary is at most 4000 characters. */
export const FLEET_SUPPORT_MESSAGE_MAX_CHARS = 200_000;
/**
 * The hub sends back replies made this long before the spoke's cursor too,
 * so a reply that commits while an answer is built is not lost. The spoke
 * keeps each reply once, by id.
 */
export const FLEET_SUPPORT_CURSOR_OVERLAP_MS = 5 * 60 * 1000;

export const FLEET_SUPPORT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
] as const;
export type FleetSupportContentType = (typeof FLEET_SUPPORT_CONTENT_TYPES)[number];

const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });
/** A file name with no path. */
export const fleetSupportFileNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^/\\\0]+$/, "file name: no path")
  .refine((name) => name !== "." && name !== "..", "file name: no path");

/** One ticket as the spoke sends it. `revision` grows with each client edit; the hub keeps the newest. */
export const fleetSupportTicketSchema = z
  .object({
    ref: uuid,
    revision: z.number().int().min(1).max(1_000_000),
    kind: z.enum(FLEET_SUPPORT_KINDS),
    title: z.string().trim().min(1).max(FLEET_SUPPORT_TITLE_MAX),
    summary: z.string().max(FLEET_SUPPORT_SUMMARY_MAX),
    priority: z.enum(FLEET_SUPPORT_PRIORITIES),
  })
  .strict();
export type FleetSupportTicket = z.infer<typeof fleetSupportTicketSchema>;

/** Claims body of a `support-sync` message. */
export const fleetSupportSyncSchema = z
  .object({
    tickets: z.array(fleetSupportTicketSchema).max(FLEET_SUPPORT_SYNC_MAX_TICKETS),
    /** The hub's `at` from the last answer the spoke kept; null asks for everything. */
    since: isoTime.nullable(),
  })
  .strict();
export type FleetSupportSync = z.infer<typeof fleetSupportSyncSchema>;

/** Claims body of a `support-attachment` message. The bytes go beside the message and must match `sha256`. */
export const fleetSupportAttachmentSchema = z
  .object({
    ticketRef: uuid,
    ref: uuid,
    name: fleetSupportFileNameSchema,
    contentType: z.enum(FLEET_SUPPORT_CONTENT_TYPES),
    byteSize: z.number().int().min(1).max(FLEET_SUPPORT_ATTACHMENT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FleetSupportAttachment = z.infer<typeof fleetSupportAttachmentSchema>;

export const fleetSupportAttachmentRequestSchema = z
  .object({
    message: z.string().min(1).max(16_384),
    /** Base64 of the file. */
    content: z.string().min(1).max(Math.ceil(FLEET_SUPPORT_ATTACHMENT_MAX_BYTES / 3) * 4 + 4),
  })
  .strict();

export const fleetSupportReplySchema = z
  .object({ id: uuid, body: z.string().min(1).max(FLEET_SUPPORT_REPLY_MAX), at: isoTime })
  .strict();
export type FleetSupportReply = z.infer<typeof fleetSupportReplySchema>;

/** One ticket as the hub answers it. Only the fields the client may see. */
export const fleetSupportTicketStateSchema = z
  .object({
    ref: uuid,
    /** The hub's issue identifier, for the client to quote. */
    hubTicketId: z.string().regex(/^[A-Z][A-Z0-9]{0,9}-[0-9]{1,9}$/),
    /** The newest client revision the hub holds. */
    revision: z.number().int().min(1),
    status: z.enum(["open", "in_progress", "resolved", "closed"]),
    priority: z.enum(FLEET_SUPPORT_PRIORITIES),
    category: z.enum(FLEET_SUPPORT_CATEGORIES),
    receivedAt: isoTime,
    firstResponseDueAt: isoTime,
    firstResponseAt: isoTime.nullable(),
    /** The name of our owner (an agent or "Greatstone support"). */
    owner: z.string().max(80).nullable(),
    replies: z.array(fleetSupportReplySchema).max(200),
  })
  .strict();
export type FleetSupportTicketState = z.infer<typeof fleetSupportTicketStateSchema>;

export const fleetSupportSyncAnswerSchema = z
  .object({
    /** Hub time of this answer: the spoke's next `since`. */
    at: isoTime,
    /** Tickets in the message that the hub could not take, with why. They stay queued on the spoke. */
    refused: z.array(z.object({ ref: uuid, reason: z.enum(["support_not_set_up", "ticket_closed"]) }).strict()).max(FLEET_SUPPORT_SYNC_MAX_TICKETS),
    tickets: z.array(fleetSupportTicketStateSchema).max(500),
  })
  .strict();
export type FleetSupportSyncAnswer = z.infer<typeof fleetSupportSyncAnswerSchema>;

/** What the host script reads from the spoke app to send. */
export const clientSupportOutboxSchema = z
  .object({
    tickets: z.array(fleetSupportTicketSchema),
    attachments: z.array(fleetSupportAttachmentSchema),
  })
  .strict();
export type ClientSupportOutbox = z.infer<typeof clientSupportOutboxSchema>;

/** What the host script tells the spoke app after a sync. */
export const clientSupportInboxSchema = z
  .object({
    sentTickets: z.array(z.object({ ref: uuid, revision: z.number().int().min(1) }).strict()).max(FLEET_SUPPORT_SYNC_MAX_TICKETS * 10),
    sentAttachments: z.array(uuid).max(500),
    refused: fleetSupportSyncAnswerSchema.shape.refused,
    tickets: fleetSupportSyncAnswerSchema.shape.tickets,
  })
  .strict();
export type ClientSupportInbox = z.infer<typeof clientSupportInboxSchema>;
