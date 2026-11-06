import { z } from "zod";

// People and access on a connected website (GRE-4085, GRE-4079 step 3b): the site's staff roles, portal approvers and
// client company members, through the signed admin bridge (contracts/gs-bridge-v1, "People and access"). Reads are
// open to any actor with website:view. Every change is a person's: John (5 Nov) "a person approves every access
// change". A person changes it directly (website:publish); an agent asks with a `website_access_change` card, and a
// person's approval makes the change in their name. The site refuses an agent actor again (403 denied). A change
// answers 200 with the site's body; an agent or a board API key gets 403 website_access_people_only before any call.

export const WEBSITE_STAFF_ROLES = ["owner", "admin", "editor", "sales", "viewer"] as const;
export type WebsiteStaffRole = (typeof WEBSITE_STAFF_ROLES)[number];
export const WEBSITE_CLIENT_MEMBER_ROLES = ["admin", "member"] as const;
export type WebsiteClientMemberRole = (typeof WEBSITE_CLIENT_MEMBER_ROLES)[number];

export const WEBSITE_ACCESS_API_ROUTES = {
  /** GET → `{ items: WebsiteStaff[], nextCursor: null }` (website:view), by email. */
  staff: "/companies/:companyId/website/sites/:siteId/access/staff",
  /** PATCH `{ role }` → `{ item: WebsiteStaff }` (website:publish, people only). The last active owner is 409. */
  staffMember: "/companies/:companyId/website/sites/:siteId/access/staff/:staffId",
  /** GET → `{ items: WebsitePortalApprover[], nextCursor: null }` (website:view), oldest first. */
  portalApprovers: "/companies/:companyId/website/sites/:siteId/access/portal-approvers",
  /** PUT `{ label }` → `{ item }` (added or relabelled); DELETE → `{ staffId, removed: true }` (website:publish, people only). */
  portalApprover: "/companies/:companyId/website/sites/:siteId/access/portal-approvers/:staffId",
  /**
   * GET → `{ items: WebsiteClientMember[], nextCursor: null }` (website:view). POST `{ email, name, role }` → `{ item }`
   * (website:publish, people only): makes the sign-in (no password) and the membership; already a member is 409.
   */
  clientMembers: "/companies/:companyId/website/sites/:siteId/access/clients/:customerId/members",
  /** PATCH `{ role }` → `{ item }`; DELETE → `{ membershipId, organisationId, removed: true }` (website:publish, people only). */
  clientMember: "/companies/:companyId/website/sites/:siteId/access/clients/:customerId/members/:membershipId",
  /**
   * POST `WebsiteAccessChangeRequestInput` → 201 `{ approval }` (website:view; agents may). Opens a
   * `website_access_change` card with the row as it is now. Changes nothing. A person with website:publish approves it
   * and GSAM makes the change in their name; a change to the row first voids the card.
   */
  changeRequests: "/companies/:companyId/website/sites/:siteId/access/change-requests",
} as const;

export interface WebsiteStaff {
  id: string;
  email: string;
  name: string | null;
  role: WebsiteStaffRole;
  isActive: boolean;
  canSignIn: boolean;
  portalApprover: boolean;
  lastLoginAt: string | null;
  updatedAt: string;
}

export interface WebsitePortalApprover {
  staffId: string;
  email: string;
  name: string | null;
  label: string;
  staffActive: boolean;
  addedAt: string;
}

export interface WebsiteClientMember {
  membershipId: string;
  /** The website's client organisation (a `customers` row). */
  organisationId: string;
  /** The client's sign-in id, or null for a contact with no sign-in. */
  userId: string | null;
  email: string;
  name: string | null;
  role: WebsiteClientMemberRole;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebsiteAccessList<T> { items: T[]; nextCursor: null }

const id = z.string().uuid();
export const websiteStaffRoleSchema = z.object({ role: z.enum(WEBSITE_STAFF_ROLES) }).strict();
export const websitePortalApproverSchema = z.object({ label: z.string().trim().min(1).max(100) }).strict();
export const websiteClientMemberAddSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(WEBSITE_CLIENT_MEMBER_ROLES),
}).strict();
export const websiteClientMemberRoleSchema = z.object({ role: z.enum(WEBSITE_CLIENT_MEMBER_ROLES) }).strict();

/** One access change, as a person makes it on the routes above or an agent asks for it on a card. */
export const websiteAccessChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staff_role"), staffId: id, role: z.enum(WEBSITE_STAFF_ROLES) }).strict(),
  z.object({ kind: z.literal("approver_set"), staffId: id, label: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("approver_remove"), staffId: id }).strict(),
  z.object({ kind: z.literal("member_add"), customerId: id }).extend(websiteClientMemberAddSchema.shape).strict(),
  z.object({ kind: z.literal("member_role"), customerId: id, membershipId: id, role: z.enum(WEBSITE_CLIENT_MEMBER_ROLES) }).strict(),
  z.object({ kind: z.literal("member_remove"), customerId: id, membershipId: id }).strict(),
]);
export type WebsiteAccessChange = z.infer<typeof websiteAccessChangeSchema>;
export type WebsiteAccessChangeKind = WebsiteAccessChange["kind"];

/** The site's route for a change: method, path after `/api/admin/v1/` and body. The one place both sides map it. */
export function websiteAccessChangeCall(change: WebsiteAccessChange): {
  method: "PATCH" | "PUT" | "DELETE" | "POST"; path: string; body: Record<string, unknown> | undefined;
} {
  const e = encodeURIComponent;
  switch (change.kind) {
    case "staff_role": return { method: "PATCH", path: `access/staff/${e(change.staffId)}`, body: { role: change.role } };
    case "approver_set": return { method: "PUT", path: `access/portal-approvers/${e(change.staffId)}`, body: { label: change.label } };
    case "approver_remove": return { method: "DELETE", path: `access/portal-approvers/${e(change.staffId)}`, body: undefined };
    case "member_add": return { method: "POST", path: `access/clients/${e(change.customerId)}/members`,
      body: { email: change.email, name: change.name, role: change.role } };
    case "member_role": return { method: "PATCH", path: `access/clients/${e(change.customerId)}/members/${e(change.membershipId)}`,
      body: { role: change.role } };
    case "member_remove": return { method: "DELETE", path: `access/clients/${e(change.customerId)}/members/${e(change.membershipId)}`,
      body: undefined };
  }
}

export const websiteAccessChangeRequestSchema = z.object({
  change: websiteAccessChangeSchema,
  note: z.string().trim().min(1).max(2000).optional(),
  /** Links the card to the asker's task. */
  issueId: z.string().uuid().optional(),
}).strict();
export type WebsiteAccessChangeRequestInput = z.infer<typeof websiteAccessChangeRequestSchema>;

export const WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE = "website_access_change";

/** The card a person decides. The server builds it from the site's rows; callers cannot set it. */
export interface WebsiteAccessChangeApprovalPayload {
  siteId: string;
  siteName: string;
  title: string;
  summary: string;
  change: WebsiteAccessChange;
  /** sha256 of the change, so the same open ask returns the same card. */
  changeKey: string;
  /** The row the change touches as it was when asked (a staff row, an approver row, a member row), or null if none. */
  before: Record<string, unknown> | null;
  /** sha256 of `before`: a different row at approval voids the card. */
  beforeSha256: string;
  /** In words, e.g. `role: editor` → `role: admin`. */
  beforeText: string;
  afterText: string;
  requestedBy: string;
  note: string | null;
  /** Set when GSAM first sent the change: a retry replays the same site key and skips the row check. */
  sentAt?: string;
  /** The site's answer once applied. */
  result?: Record<string, unknown>;
}
