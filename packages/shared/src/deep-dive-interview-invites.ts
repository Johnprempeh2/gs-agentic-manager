import { z } from "zod";
import type { DeepDiveInterviewRoundStatus } from "./deep-dive-interviews.js";

/**
 * Parallel Interview invites and live progress (GRE-2665), slice 2 of GRE-2611.
 *
 * A round opens on the website only when a person has approved every question
 * set. Each invite asks the website (gs-interview-v1) to create the person's
 * account and membership, or names an existing website user. GSAM keeps only
 * the website employee, user and organisation ids per invite, plus which
 * question set the person gets; names, emails and status are read live from
 * the website. The user id is null while the website holds an invitation by
 * email, until the person makes their account.
 */

/** A person's place in the round, as the website reports it. */
export const DEEP_DIVE_INTERVIEW_INVITE_STATUSES = ["invited", "started", "completed", "abandoned", "declined"] as const;
export type DeepDiveInterviewInviteStatus = (typeof DEEP_DIVE_INTERVIEW_INVITE_STATUSES)[number];

export const DEEP_DIVE_INTERVIEW_INVITE_LABELS: Record<DeepDiveInterviewInviteStatus, string> = {
  invited: "Invited",
  started: "Started",
  completed: "Completed",
  abandoned: "Abandoned",
  declined: "Declined",
};

/** Resend the join link to someone who has not started; remind someone who has not finished. */
export const DEEP_DIVE_INTERVIEW_SEND_KINDS = ["resend", "remind"] as const;
export type DeepDiveInterviewSendKind = (typeof DEEP_DIVE_INTERVIEW_SEND_KINDS)[number];

export function deepDiveInterviewSendKindFor(status: DeepDiveInterviewInviteStatus): DeepDiveInterviewSendKind | null {
  if (status === "invited") return "resend";
  if (status === "started") return "remind";
  return null;
}

/** A website user or organisation id: letters, numbers, - and _ only, so a name or email can never be stored as one. */
export const websiteUserIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "Enter the website user id: letters, numbers, - and _ only");

export const DEEP_DIVE_INTERVIEW_MAX_INVITES_PER_CALL = 200;

const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter an email domain such as example.com");

/** Open the round on the website. Refused until a person has approved every question set. */
export const openDeepDiveInterviewRoundSchema = z
  .object({
    /** Who may join with the round's link. At least one. */
    allowedEmailDomains: z.array(emailDomainSchema).min(1).max(20),
    /** How many people may take part. */
    seatTotal: z.number().int().min(1).max(5_000),
  })
  .strict();
export type OpenDeepDiveInterviewRound = z.infer<typeof openDeepDiveInterviewRoundSchema>;

/**
 * One person to invite. A board person, or a manual add (a name), and either an
 * email (the website makes the account) or an existing website user id. In a
 * per-team round `unitId` is the team whose questions they get; in a per-person
 * round the board person's own set is used.
 */
export const deepDiveInterviewInviteeSchema = z
  .object({
    boardPersonId: z.string().guid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    roleTitle: z.string().trim().max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    websiteUserId: websiteUserIdSchema.optional(),
    unitId: z.string().guid().optional(),
  })
  .strict()
  .refine((p) => !!p.email !== !!p.websiteUserId, { message: "Give an email or an existing website user id, not both" })
  .refine((p) => !!p.boardPersonId || !!p.name, { message: "Choose a person from the board or give a name" });
export type DeepDiveInterviewInvitee = z.infer<typeof deepDiveInterviewInviteeSchema>;

export const inviteDeepDiveInterviewPeopleSchema = z
  .object({
    people: z.array(deepDiveInterviewInviteeSchema).min(1).max(DEEP_DIVE_INTERVIEW_MAX_INVITES_PER_CALL),
  })
  .strict();
export type InviteDeepDiveInterviewPeople = z.infer<typeof inviteDeepDiveInterviewPeopleSchema>;

/** Names people on the round by the website employee id every invite has, with or without an account yet. */
export const sendDeepDiveInterviewInvitesSchema = z
  .object({
    kind: z.enum(DEEP_DIVE_INTERVIEW_SEND_KINDS),
    websiteEmployeeIds: z.array(websiteUserIdSchema).min(1).max(DEEP_DIVE_INTERVIEW_MAX_INVITES_PER_CALL),
  })
  .strict();
export type SendDeepDiveInterviewInvites = z.infer<typeof sendDeepDiveInterviewInvitesSchema>;

export type DeepDiveInterviewStatusCounts = Record<DeepDiveInterviewInviteStatus, number>;

/** One person on the round. Name and email come live from the website and are never stored in GSAM. */
export interface DeepDiveInterviewProgressPerson {
  websiteEmployeeId: string;
  /** Null until the person makes their website account. */
  websiteUserId: string | null;
  name: string;
  email: string;
  roleTitle: string;
  unitId: string | null;
  teamName: string;
  /** The question set they get, or null when the website has them but GSAM did not invite them. */
  setId: string | null;
  status: DeepDiveInterviewInviteStatus;
  startedAt: string | null;
  endedAt: string | null;
  completionScore: number | null;
  invitedAt: string | null;
  sentCount: number;
  lastSentAt: string | null;
  remindedCount: number;
  lastRemindedAt: string | null;
}

export interface DeepDiveInterviewProgressTeam {
  unitId: string | null;
  name: string;
  total: number;
  counts: DeepDiveInterviewStatusCounts;
}

export interface DeepDiveInterviewProgress {
  roundId: string | null;
  status: DeepDiveInterviewRoundStatus | null;
  websiteOrganisationId: string | null;
  allowedEmailDomains: string[];
  seatTotal: number | null;
  /** When it was read from the website; null before the round opens. */
  readAt: string | null;
  total: number;
  counts: DeepDiveInterviewStatusCounts;
  teams: DeepDiveInterviewProgressTeam[];
  people: DeepDiveInterviewProgressPerson[];
}

export function emptyDeepDiveInterviewStatusCounts(): DeepDiveInterviewStatusCounts {
  return { invited: 0, started: 0, completed: 0, abandoned: 0, declined: 0 };
}

// ---------------------------------------------------------------------------
// gs-interview-v1: what GSAM sends the website and reads back
// (contracts/gs-interview-v1/README.md). Website answers are read leniently:
// unknown fields are kept out, missing optional fields default.
// ---------------------------------------------------------------------------

export const GS_INTERVIEW_ROUND_SCHEMA = "gs-interview-round-v1";

/**
 * `POST rounds/{roundId}`: the round as GSAM sends it. `retentionDays` and `readoutAt` (GRE-2653) are optional.
 * There is no client name: the website reads the organisation's own name.
 */
export const gsInterviewRoundPayloadSchema = z
  .object({
    schema: z.literal(GS_INTERVIEW_ROUND_SCHEMA),
    sponsor: z.string().nullable(),
    mode: z.enum(["team", "person"]),
    voice: z.boolean().optional(),
    targetMinutes: z.number().int(),
    status: z.enum(["draft", "open", "closed"]),
    seatTotal: z.number().int().min(0),
    costEnvelopePence: z.number().int().min(0).nullable().optional(),
    endDate: z.string().nullable().optional(),
    retentionDeleteAfter: z.string().nullable().optional(),
    retentionDays: z.number().int().min(0).max(3_650).optional(),
    readoutAt: z.string().datetime({ offset: true }).nullable().optional(),
    enrol: z.object({
      enabled: z.boolean(),
      expiresAt: z.string().nullable(),
      allowedEmailDomains: z.array(z.string()),
      defaultUnitId: z.string().nullable(),
      rotateToken: z.boolean(),
    }),
    units: z.array(
      z.object({
        id: z.string(),
        parentId: z.string().nullable(),
        name: z.string(),
        kind: z.string(),
        seatAllocation: z.number().int().min(0).nullable().optional(),
      }),
    ),
    contextPack: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GsInterviewRoundPayload = z.infer<typeof gsInterviewRoundPayloadSchema>;

const isoOrNull = z.string().nullable().optional().transform((v) => v ?? null);

/** `GET rounds/{roundId}`'s item. The retention fields (GRE-2653) are optional. */
export const gsInterviewRoundItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  joinUrl: z.string().nullable().optional().transform((v) => v ?? null),
  retentionDays: z.number().int().nullable().optional().transform((v) => v ?? null),
  readoutAt: isoOrNull,
  closedAt: isoOrNull,
  deletionDate: isoOrNull,
  /** What the client sees now (GRE-2667): the released synthesis, or nulls. */
  released: z
    .object({ synthesisId: z.string().nullable().optional(), releasedAt: isoOrNull })
    .nullable()
    .optional()
    .transform((v) => (v?.synthesisId ? { synthesisId: v.synthesisId, releasedAt: v.releasedAt } : null)),
});
export type GsInterviewRoundItem = z.infer<typeof gsInterviewRoundItemSchema>;

/**
 * `POST rounds/{roundId}/invites`: one person. An existing website account by `userId`, or an email and name
 * for someone with no account yet (the site holds the invitation by email until they make one).
 */
export interface GsInterviewInvitePerson {
  email?: string;
  userId?: string;
  name: string;
  roleTitle: string;
  unitId: string | null;
  portalRole: "employee" | "team_leader" | "client_admin";
}

export const gsInterviewInviteAnswerSchema = z.object({
  invited: z.array(
    z.object({
      userId: websiteUserIdSchema.nullable(),
      organisationId: z.string().optional(),
      employeeId: websiteUserIdSchema,
      outcome: z.enum(["created", "updated"]),
    }),
  ),
  emailed: z.number().int().min(0),
});
export type GsInterviewInviteAnswer = z.infer<typeof gsInterviewInviteAnswerSchema>;

/** `POST rounds/{roundId}/invites/send`: `userIds` for people with an account, `employeeIds` for invitations held by email. */
export type GsInterviewSendBody = {
  kind: DeepDiveInterviewSendKind;
  userIds: string[];
  employeeIds: string[];
};

export const gsInterviewSendAnswerSchema = z.object({
  emailed: z.number().int().min(0),
  skipped: z.number().int().min(0).default(0),
});
export type GsInterviewSendAnswer = z.infer<typeof gsInterviewSendAnswerSchema>;

/** `GET rounds/{roundId}/people`: status and progress only, no interview content. */
export const gsInterviewPersonSchema = z.object({
  userId: websiteUserIdSchema.nullable().optional().transform((v) => v ?? null),
  employeeId: websiteUserIdSchema,
  email: z.string().default(""),
  name: z.string().default(""),
  roleTitle: z.string().nullable().optional().transform((v) => v ?? ""),
  unitId: z.string().nullable().optional().transform((v) => v ?? null),
  status: z.enum(DEEP_DIVE_INTERVIEW_INVITE_STATUSES),
  sessionStartedAt: isoOrNull,
  sessionEndedAt: isoOrNull,
  completionScore: z.number().nullable().optional().transform((v) => v ?? null),
});
export type GsInterviewPerson = z.infer<typeof gsInterviewPersonSchema>;
