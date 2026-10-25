import { z } from "zod";
import { acceptClientEngagementSchema, type EngagementStatus, type NdaStatus } from "./validators/client-journey.js";

// Deliverable publishing on Clients > Deliverables and the engagement
// timeline (GRE-2373, screens 12 and 13 of the GRE-2327 plan). Carried over
// from the website client portal: a deliverable filed for a client goes
// draft → pending approval (one version and its fingerprint frozen, one
// registered approver named) → approved (by that approver only) → published
// (only when the content still has the approved fingerprint) → accepted by the
// client, who gets a receipt email. Withdrawn stops it at any point before
// acceptance. The server and the UI share these rules so they cannot disagree.

export const CLIENT_PUBLICATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "accepted",
  "withdrawn",
] as const;
export type ClientPublicationStatus = (typeof CLIENT_PUBLICATION_STATUSES)[number];

export const CLIENT_PUBLICATION_STATUS_LABELS: Record<ClientPublicationStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  published: "Published",
  accepted: "Accepted by the client",
  withdrawn: "Withdrawn",
};

/** Every step recorded in the audit, in the order they usually happen. */
export const CLIENT_PUBLICATION_ACTIONS = [
  "created",
  "submitted",
  "approved",
  "rejected",
  "published",
  "acceptance_link_created",
  "accepted",
  "receipt_sent",
  "receipt_failed",
  "receipt_not_configured",
  "withdrawn",
] as const;
export type ClientPublicationAction = (typeof CLIENT_PUBLICATION_ACTIONS)[number];

/** The steps that move a publication on, and the statuses each may start from. */
const MOVES = {
  submit: ["draft"],
  approve: ["pending_approval"],
  reject: ["pending_approval", "approved"],
  publish: ["approved"],
  share: ["published"],
  accept: ["published"],
  withdraw: ["draft", "pending_approval", "approved", "published"],
} as const satisfies Record<string, readonly ClientPublicationStatus[]>;
export type ClientPublicationMove = keyof typeof MOVES;

export function canMoveClientPublication(status: ClientPublicationStatus, move: ClientPublicationMove): boolean {
  return (MOVES[move] as readonly ClientPublicationStatus[]).includes(status);
}

export type ClientPublicationGateCode = "nda_required" | "engagement_not_accepted";

/**
 * What must be true of the client before anything is published to them: the
 * NDA accepted or suspended, and the engagement pack accepted (from GSAM's
 * NDA gate and engagement acceptance). Empty when publishing may go ahead.
 */
export function clientPublicationGates(input: { ndaStatus: NdaStatus; engagementStatus: EngagementStatus }): ClientPublicationGateCode[] {
  const gates: ClientPublicationGateCode[] = [];
  if (input.ndaStatus === "required") gates.push("nda_required");
  if (input.engagementStatus !== "accepted") gates.push("engagement_not_accepted");
  return gates;
}

export const CLIENT_PUBLICATION_GATE_MESSAGES: Record<ClientPublicationGateCode, string> = {
  nda_required: "The client's NDA must be accepted or suspended before anything is published to them",
  engagement_not_accepted: "The client must accept the engagement pack before anything is published to them",
};

/**
 * The text a deliverable version's fingerprint is the sha256 of. A stored file
 * is named by the sha256 of its bytes and its type; a link deliverable by its
 * address. Two versions with the same content have the same fingerprint.
 */
export function deliverableFingerprintSource(input: {
  external: boolean;
  url: string | null;
  sha256: string | null;
  contentType: string | null;
}): string | null {
  if (input.external) return input.url ? `gsam-deliverable/v1\nlink\n${input.url}` : null;
  if (!input.sha256) return null;
  return `gsam-deliverable/v1\nfile\n${input.sha256}\n${(input.contentType ?? "").toLowerCase()}`;
}

// ---------- API shapes ----------

export interface ClientDeliverableApprover {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  createdAt: string;
}

export interface ClientPublicationEvent {
  id: string;
  action: ClientPublicationAction;
  actorType: "user" | "agent" | "client" | "system";
  actorName: string | null;
  fingerprint: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type ClientReceiptStatus = "not_sent" | "sent" | "failed" | "not_configured";

export interface ClientPublication {
  id: string;
  caseId: string;
  stageLinkId: string | null;
  deliverableIssueId: string;
  deliverableKey: string;
  title: string;
  status: ClientPublicationStatus;
  /** The version frozen on submit; for a draft, the newest version. */
  workProductId: string | null;
  version: number | null;
  /** The newest version of the deliverable, so a stale draft or approval shows. */
  latestVersion: number | null;
  fingerprint: string | null;
  approverUserId: string | null;
  approverName: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  rejectedReason: string | null;
  publishedAt: string | null;
  /** The client's link: when it was made and when it stops working. The link itself is shown once. */
  acceptanceLink: { createdAt: string; expiresAt: string; expired: boolean } | null;
  acceptedAt: string | null;
  acceptedName: string | null;
  acceptedRole: string | null;
  acceptedEmail: string | null;
  receipt: { status: ClientReceiptStatus; sentAt: string | null; error: string | null };
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  /** In-app path to the frozen version's content. */
  contentPath: string | null;
  url: string | null;
  events: ClientPublicationEvent[];
  createdAt: string;
  updatedAt: string;
}

/** GET /api/cases/:caseId/publications */
export interface ClientPublicationsResponse {
  caseId: string;
  approvers: ClientDeliverableApprover[];
  publications: ClientPublication[];
  /** Why nothing can be published yet; empty when it can. */
  gates: ClientPublicationGateCode[];
  /** Whether a receipt can be sent: the sending-only Resend secret is set. */
  receiptSenderConfigured: boolean;
}

/** POST /api/client-publications/:id/acceptance-link: the link, shown once. */
export interface CreateClientPublicationLinkResponse {
  url: string;
  path: string;
  expiresAt: string;
}

/** GET /api/client-deliverable/:token: the public page. Names, the deliverable and the acceptance only. */
export interface PublicClientDeliverable {
  companyName: string;
  clientName: string;
  title: string;
  version: number | null;
  /** Public path that returns the file, or null for a link deliverable. */
  contentPath: string | null;
  url: string | null;
  status: "open" | "accepted";
  expiresAt: string;
  acceptedAt: string | null;
  acceptedName: string | null;
}

// ---------- validators ----------

export const createClientPublicationSchema = z.object({ stageLinkId: z.string().guid() }).strict();
export const submitClientPublicationSchema = z.object({ approverUserId: z.string().trim().min(1).max(200) }).strict();
export const rejectClientPublicationSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const withdrawClientPublicationSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const registerClientApproverSchema = z.object({ userId: z.string().trim().min(1).max(200) }).strict();
/** The client accepts a published deliverable the way they accept the engagement pack. */
export const acceptClientDeliverableSchema = acceptClientEngagementSchema;

export type CreateClientPublication = z.infer<typeof createClientPublicationSchema>;
export type SubmitClientPublication = z.infer<typeof submitClientPublicationSchema>;
export type RejectClientPublication = z.infer<typeof rejectClientPublicationSchema>;
export type WithdrawClientPublication = z.infer<typeof withdrawClientPublicationSchema>;
export type RegisterClientApprover = z.infer<typeof registerClientApproverSchema>;
export type AcceptClientDeliverable = z.infer<typeof acceptClientDeliverableSchema>;

/** How long a deliverable acceptance link works for, in days. */
export const CLIENT_PUBLICATION_LINK_DAYS = 30;

// ---------- engagement timeline (screen 13) ----------

/**
 * One client's journey, read only from what is stored: the stage moves
 * recorded on the client, the NDA and engagement dates, and the publishing
 * steps. It replaces the website's timeline, which was guessed from documents.
 */
export interface EngagementTimelineStage {
  stageId: string;
  name: string;
  kind: string;
  enteredAt: string;
  leftAt: string | null;
  current: boolean;
  /** Moved there by hand, past the stage's rules. Internal only. */
  forced?: boolean;
}

export type EngagementMilestoneKind =
  | "nda_accepted"
  | "nda_suspended"
  | "engagement_sent"
  | "engagement_accepted"
  | "deliverable_published"
  | "deliverable_accepted";

export interface EngagementMilestone {
  kind: EngagementMilestoneKind;
  at: string;
  label: string;
  publicationId?: string;
}

export interface EngagementTimeline {
  caseId: string;
  stages: EngagementTimelineStage[];
  milestones: EngagementMilestone[];
}

export interface EngagementTimelineInput {
  caseId: string;
  currentStageId: string;
  /** Stage moves in any order: entering the pipeline and each transition. */
  moves: Array<{ toStageId: string; at: Date | string; forced: boolean }>;
  stages: Array<{ id: string; name: string; kind: string }>;
  nda: { status: NdaStatus; acceptedAt: Date | string | null; changedAt: Date | string | null };
  engagement: { status: EngagementStatus; sentAt: Date | string | null; acceptedAt: Date | string | null };
  publications: Array<{
    id: string;
    title: string;
    status: ClientPublicationStatus;
    publishedAt: Date | string | null;
    acceptedAt: Date | string | null;
  }>;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const byTime = <T extends { at: string }>(left: T, right: T) => left.at.localeCompare(right.at);

export function buildEngagementTimeline(input: EngagementTimelineInput): EngagementTimeline {
  const stageById = new Map(input.stages.map((stage) => [stage.id, stage]));
  const moves = input.moves
    .filter((move) => stageById.has(move.toStageId))
    .map((move) => ({ ...move, at: iso(move.at) }))
    .sort(byTime);
  const stages = moves.map((move, index): EngagementTimelineStage => {
    const stage = stageById.get(move.toStageId)!;
    const next = moves[index + 1];
    return {
      stageId: stage.id,
      name: stage.name,
      kind: stage.kind,
      enteredAt: move.at,
      leftAt: next ? next.at : null,
      current: !next && move.toStageId === input.currentStageId,
      forced: move.forced,
    };
  });

  const milestones: EngagementMilestone[] = [];
  if (input.nda.status === "accepted" && input.nda.acceptedAt) {
    milestones.push({ kind: "nda_accepted", at: iso(input.nda.acceptedAt), label: "NDA accepted" });
  } else if (input.nda.status === "suspended" && input.nda.changedAt) {
    milestones.push({ kind: "nda_suspended", at: iso(input.nda.changedAt), label: "NDA suspended" });
  }
  if (input.engagement.status !== "not_sent" && input.engagement.sentAt) {
    milestones.push({ kind: "engagement_sent", at: iso(input.engagement.sentAt), label: "Engagement pack sent" });
  }
  if (input.engagement.status === "accepted" && input.engagement.acceptedAt) {
    milestones.push({ kind: "engagement_accepted", at: iso(input.engagement.acceptedAt), label: "Engagement pack accepted" });
  }
  for (const publication of input.publications) {
    if ((publication.status === "published" || publication.status === "accepted") && publication.publishedAt) {
      milestones.push({
        kind: "deliverable_published",
        at: iso(publication.publishedAt),
        label: `${publication.title} published`,
        publicationId: publication.id,
      });
    }
    if (publication.status === "accepted" && publication.acceptedAt) {
      milestones.push({
        kind: "deliverable_accepted",
        at: iso(publication.acceptedAt),
        label: `${publication.title} accepted`,
        publicationId: publication.id,
      });
    }
  }
  return { caseId: input.caseId, stages, milestones: milestones.sort(byTime) };
}

/**
 * The timeline as the client may see it: journey stages only (no Paused or
 * Lost style stages), no hand-forced flags, and no internal ids.
 */
export function clientSafeEngagementTimeline(timeline: EngagementTimeline): EngagementTimeline {
  return {
    caseId: timeline.caseId,
    stages: timeline.stages
      .filter((stage) => stage.kind !== "cancelled")
      .map(({ forced: _forced, ...stage }) => stage),
    milestones: timeline.milestones.map(({ publicationId: _id, ...milestone }) => milestone),
  };
}
