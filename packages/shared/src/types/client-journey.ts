import type { Deliverable, DeliverableConfidentiality, DeliverableKind } from "./deliverable.js";

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
}

/** GET /api/cases/:caseId/journey — the internal, per-stage view of a client. */
export interface ClientJourneyResponse {
  caseId: string;
  /** When the board recorded the client's accepted NDA; client-labelled items reach the portal only after it. */
  ndaAcceptedAt: string | null;
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
