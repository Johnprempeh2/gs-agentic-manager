import { z } from "zod";
import type { Deliverable } from "./types/deliverable.js";

// Prototypes (John, 14 Nov): every prototype site we build for a client, in one
// place. A prototype is a link deliverable of kind "prototype", so it keeps the
// deliverable's versions (the releases timeline), screenshot, link check,
// project and client. Two things are its own: a status, and whether one
// client sees it in their website portal. Registering one never shares it;
// only a person turns "Visible to <client>" on, and turning it off removes it
// from the portal on the next push, which runs at once.

export const PROTOTYPE_STATUSES = ["draft", "in_review", "shared", "retired"] as const;
export type PrototypeStatus = (typeof PROTOTYPE_STATUSES)[number];
/** The statuses a person or agent sets; "shared" follows from the portal toggle. */
export const prototypeSettableStatusSchema = z.enum(["draft", "in_review", "retired"]);
export type PrototypeSettableStatus = z.infer<typeof prototypeSettableStatusSchema>;

export const PROTOTYPE_STATUS_LABELS: Record<PrototypeStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  shared: "Shared",
  retired: "Retired",
};

export interface PrototypeClient {
  /** The CRM organisation (GSAM `organisations.id`). */
  id: string;
  name: string;
  /** False until a person links the organisation to its website organisation; it cannot be shared before. */
  websiteLinked: boolean;
}

export interface PrototypePortal {
  /** True when the client sees it in their portal now. */
  visible: boolean;
  sharedAt: string | null;
  sharedByUserId: string | null;
  /**
   * Shared once, but the latest version moved to another address, so the
   * portal no longer shows it until a person shares it again.
   */
  needsReshare: boolean;
}

export interface Prototype extends Deliverable {
  prototypeStatus: PrototypeStatus;
  client: PrototypeClient | null;
  portal: PrototypePortal;
  /** The task's assignee (agent or person), else the agent that registered it. */
  owner: { type: "agent" | "user"; id: string; name: string } | null;
}

export interface PrototypesResponse {
  prototypes: Prototype[];
}

export const prototypesQuerySchema = z.object({
  organisationId: z.string().guid().optional(),
  projectId: z.string().guid().optional(),
  status: z.enum(PROTOTYPE_STATUSES).optional(),
  q: z.string().trim().max(160).optional(),
});
export type PrototypesQuery = z.infer<typeof prototypesQuerySchema>;

/** PATCH /api/companies/:companyId/prototypes/:id/status */
export const setPrototypeStatusSchema = z.object({ status: prototypeSettableStatusSchema });

/**
 * POST /api/companies/:companyId/prototypes/:id/visibility — people only.
 * `organisationId` is the client the person confirmed; it must still be the
 * prototype's client, so a stale confirm cannot share with someone else.
 */
export const setPrototypeVisibilitySchema = z.object({
  visible: z.boolean(),
  organisationId: z.string().guid(),
});
export type SetPrototypeVisibility = z.infer<typeof setPrototypeVisibilitySchema>;

export interface PrototypePortalSync {
  /** Sites the push reached. */
  sites: number;
  /** Set when a site could not be reached: the change is saved in GSAM and the push must be tried again. */
  error: string | null;
}

export interface SetPrototypeVisibilityResponse {
  prototype: Prototype;
  portal: PrototypePortalSync;
}

// ---- the push to the website (gs-bridge-v1, write key) ----

export const PORTAL_PROTOTYPES_SCHEMA = "gs-portal-prototypes-v1";
/** Most prototypes one client's portal shows; the push is refused above it. */
export const PORTAL_PROTOTYPES_MAX = 50;
/** A thumbnail is a small JPEG as a data URL, so the site never fetches from GSAM. */
export const PORTAL_PROTOTYPE_THUMBNAIL_MAX_CHARS = 40_000;

/** The site's path: the whole list for one client (website `customers.id`), so a PUT replaces it. */
export const portalPrototypesSitePath = (customerId: string) =>
  `/api/admin/v1/portal-prototypes/clients/${encodeURIComponent(customerId)}`;

export interface PortalPrototypeItem {
  /** The deliverable's latest version id in GSAM; stable enough for the site's list key. */
  id: string;
  title: string;
  description: string | null;
  url: string;
  version: number;
  updatedAt: string;
  thumbnail: string | null;
}

export interface PortalPrototypesPayload {
  schema: typeof PORTAL_PROTOTYPES_SCHEMA;
  customerId: string;
  generatedAt: string;
  prototypes: PortalPrototypeItem[];
}
