import type { Deliverable, DeliverableConfidentiality, DeliverableKind } from "./deliverable.js";
import type { EngagementStatus } from "../validators/client-journey.js";

// Client journey by stage (GRE-1473): each stage of a client's journey
// (Executive Discovery, GITA, Deep Dive, GDXP, playback) lists the standard
// templates and the deliverables for that stage. The client portal shows only
// the client-facing, final deliverables of stages the client has completed.

/** Where a stage sits for this client. `side` is a Paused or Lost style stage the case is in now. */
export type ClientJourneyStageState = "done" | "current" | "next" | "side";

export interface ClientJourneyStageTemplate {
  title: string;
  url: string | null;
  note: string | null;
}

/** A deliverable filed under a stage, with the flag that lets the client see it. */
export interface ClientJourneyStageDeliverable {
  /** The stage link id; use it to move, flag or remove the link. */
  linkId: string;
  stageId: string;
  clientFacing: boolean;
  deliverable: Deliverable;
}

/**
 * A deliverable the stage config expects (`expectedDeliverables`), and the
 * filed deliverable that meets it, if any. Read-only: it shows the gap.
 */
export interface ClientJourneyExpectedDeliverable {
  key: string;
  title: string;
  kind: DeliverableKind | null;
  /** The filed deliverable that matches by key or title, or null while it is missing. */
  deliverableId: string | null;
}

export interface ClientJourneyStage {
  id: string;
  key: string;
  name: string;
  kind: string;
  position: number;
  state: ClientJourneyStageState;
  templates: ClientJourneyStageTemplate[];
  deliverables: ClientJourneyStageDeliverable[];
  expected: ClientJourneyExpectedDeliverable[];
  /** Documents asked of the client at this stage, in order. */
  requests?: ClientDocumentRequest[];
  /** The stage config's standard document list, less what is already requested. */
  suggestedRequests?: ClientJourneySuggestedRequest[];
}

/**
 * A document asked of the client at one stage (Ben, 12 Oct: the deep dive's
 * document request stage). It is received once an upload is linked to it.
 */
export interface ClientDocumentRequest {
  id: string;
  stageId: string;
  title: string;
  note: string | null;
  createdAt: string;
  /** The file that met the request, or null while it is outstanding. */
  received: ClientDocumentRequestReceived | null;
}

export interface ClientDocumentRequestReceived {
  evidenceId: string;
  title: string;
  /** API path that returns the file; null for a link or a task file. */
  contentPath: string | null;
  receivedAt: string;
}

export interface ClientJourneySuggestedRequest {
  title: string;
  note: string | null;
}

/** A case's NDA: required (the default), accepted (with its date) or suspended (with its reason). */
export interface ClientNda {
  status: "required" | "accepted" | "suspended";
  acceptedAt: string | null;
  /** Why the NDA is suspended; set only while suspended. */
  suspendedReason: string | null;
  /** The board user who last changed the status (name, else null) and when. */
  changedBy: string | null;
  changedAt: string | null;
  /** The signed NDA uploaded onto the client, if there is one. */
  signedDocument?: ClientNdaSignedDocument | null;
}

/** The uploaded signed NDA: an upload in the client's evidence. */
export interface ClientNdaSignedDocument {
  evidenceId: string;
  title: string;
  /** API path that returns the file. */
  contentPath: string;
  uploadedAt: string;
}

/** A file on the client that the NDA or engagement pack points at. */
export interface ClientJourneyFileRef {
  evidenceId: string;
  title: string;
  /** API path that returns the file. */
  contentPath: string;
  uploadedAt: string;
}

/**
 * The engagement pack after the NDA (Ben, 8 and 12 Oct): not sent, sent or
 * accepted, with the pack that went out and the client's signed acceptance.
 */
export interface ClientEngagement {
  status: EngagementStatus;
  sentAt: string | null;
  acceptedAt: string | null;
  changedBy: string | null;
  changedAt: string | null;
  pack: ClientJourneyFileRef | null;
  acceptance: ClientJourneyFileRef | null;
  /** The newest online acceptance link, or null when none was made or it was revoked. */
  onlineLink?: ClientAcceptanceLinkSummary | null;
}

/**
 * The online acceptance link for a client, as the board sees it. The link
 * itself is shown only once, when it is made.
 */
export interface ClientAcceptanceLinkSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** True once the expiry date has passed without an acceptance. */
  expired: boolean;
  acceptedAt: string | null;
  acceptedName: string | null;
  acceptedRole: string | null;
  acceptedEmail: string | null;
}

/** POST /api/cases/:caseId/engagement/online-link: the new link, shown once. */
export interface CreateClientAcceptanceLinkResponse {
  /** Full address when the server knows its public URL, else the path to append to it. */
  url: string;
  path: string;
  link: ClientAcceptanceLinkSummary;
}

/**
 * GET /api/client-acceptance/:token: what the client sees on the public page.
 * Only the names, the pack and the acceptance: nothing internal.
 */
export interface PublicClientAcceptance {
  companyName: string;
  clientName: string;
  packTitle: string;
  /** Public path that returns the pack file. */
  packPath: string;
  status: "open" | "accepted";
  expiresAt: string;
  acceptedAt: string | null;
  acceptedName: string | null;
}

/** GET /api/cases/:caseId/journey — the internal, per-stage view of a client. */
export interface ClientJourneyResponse {
  caseId: string;
  /** When the board recorded the client's accepted NDA (null unless `nda.status` is accepted). Kept for older callers. */
  ndaAcceptedAt: string | null;
  /** The NDA: client-labelled items reach the portal once it is accepted or suspended. */
  nda: ClientNda;
  /** The engagement pack; it can go out once the NDA is accepted or suspended. */
  engagement?: ClientEngagement;
  stages: ClientJourneyStage[];
  /** Deliverables on the client's tasks and projects that are not filed under a stage yet. */
  unfiled: Deliverable[];
}

/**
 * One deliverable as the client portal shows it. Only outcome fields: no
 * task, agent, run, project or internal notes.
 */
export interface ClientPortalDeliverable {
  title: string;
  summary: string | null;
  kind: DeliverableKind;
  version: number;
  contentType: string;
  updatedAt: string;
  confidentiality: Exclude<DeliverableConfidentiality, "internal">;
  /**
   * Authenticated in-app path the portal publisher uses to fetch the file
   * and copy it to the portal. It is not shown to the client. Null for a
   * link deliverable, which the portal links to at `url` instead.
   */
  contentPath: string | null;
  /** The live site of a link deliverable. */
  url: string | null;
}

export interface ClientPortalStage {
  key: string;
  name: string;
  deliverables: ClientPortalDeliverable[];
}

/** GET /api/cases/:caseId/portal — what the client sees on its portal. */
export interface ClientPortalJourneyResponse {
  caseId: string;
  title: string;
  /** Completed stages only, in journey order. */
  stages: ClientPortalStage[];
}
