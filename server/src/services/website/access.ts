import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, approvals, authUsers } from "@greatstone/db";
import {
  WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE,
  type WebsiteAccessChange,
  type WebsiteAccessChangeApprovalPayload,
  type WebsiteAccessChangeRequestInput,
} from "@greatstone/shared";
import { HttpError, forbidden, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import { logActivity } from "../activity-log.js";
import type { SiteRow } from "./module.js";
import { websiteModuleService } from "./module.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { websiteDataBridgeService, type BridgeSite, type WebsiteDataBridgeOptions } from "./data-bridge.js";

// People and access on a connected website (GRE-4085, GRE-4079 step 3b; contract "People and access" in
// contracts/gs-bridge-v1). John (5 Nov): "a person approves every access change". So:
//
// - reads (staff, portal approvers, a client's members) go on the read key for any actor with website:view;
// - a person with website:publish changes access directly, on the write key in their own name;
// - an agent asks: GSAM reads the row the change touches, keeps it on a website_access_change card and changes
//   nothing. A person with website:publish approves it and GSAM makes the change in their name. A different row at
//   approval voids the card. The site refuses an agent actor on every change (403 denied) as a second wall.
//
// Idempotency: an approved card's site key comes from the approval id, so a second click or a retry after a lost
// answer replays the site's answer instead of changing twice.

type ApprovalRow = typeof approvals.$inferSelect;
type Actor = Express.Request["actor"];
type Payload = WebsiteAccessChangeApprovalPayload;

const OPEN = ["pending", "revision_requested"] as const;
/** The site refused the change for good: the card cannot be approved as it stands. */
const CLOSES_CARD = new Set(["conflict", "not_found", "bad_request", "denied"]);

/** Fail closed: no write key means access changes are off. No vault read, no call to the site. */
export function accessChangesOff() {
  return new HttpError(409, "Access changes are off for this site: no write key is set up", { code: "capability_not_configured", capability: "write" });
}

export function accessChangeIdempotencyKey(approvalId: string) {
  return createHash("sha256").update(`${WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE}:${approvalId}:apply`).digest().subarray(0, 16).toString("base64url");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha256 = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/** What the activity log keeps of a change: ids, roles and labels. Never an email or a name. */
export function accessChangeLogDetails(change: WebsiteAccessChange) {
  const { email: _email, name: _name, ...rest } = change as WebsiteAccessChange & { email?: string; name?: string };
  return rest;
}

function who(row: Record<string, unknown> | null) {
  if (!row) return "this person";
  const name = typeof row.name === "string" && row.name ? row.name : null;
  return name ?? (typeof row.email === "string" ? row.email : "this person");
}

export function websiteAccessService(db: Db, bridgeOptions: WebsiteDataBridgeOptions = {},
  tellRequester?: (approval: ApprovalRow, message: string, outcome: "rejected" | "cancelled", userId: string) => Promise<void>) {
  const access = accessService(db);
  const bridge = websiteDataBridgeService(db, bridgeOptions);
  const sites = websiteModuleService(db);

  const read = (site: BridgeSite) => bridge.client(site, "read");
  async function writeClient(site: BridgeSite) {
    if (!site.dataBridgeWriteSecretId) throw accessChangesOff();
    return bridge.client(site, "write");
  }

  const reads = {
    async staff(site: BridgeSite, actor: WebsiteBridgeActor) { return (await read(site)).accessStaff(actor); },
    async portalApprovers(site: BridgeSite, actor: WebsiteBridgeActor) { return (await read(site)).accessPortalApprovers(actor); },
    async clientMembers(site: BridgeSite, customerId: string, actor: WebsiteBridgeActor) {
      return (await read(site)).accessClientMembers(customerId, actor);
    },
  };

  /** A person's change, in their own name. The route has checked the actor is a person with website:publish. */
  async function change(site: BridgeSite, input: WebsiteAccessChange, actor: WebsiteBridgeActor & { type: "user" }, idempotencyKey?: string) {
    return (await writeClient(site)).accessChange(input, actor, idempotencyKey);
  }

  /** The row the change touches, as the site has it now, or null when there is none yet. */
  async function subjectOf(site: BridgeSite, input: WebsiteAccessChange, actor: WebsiteBridgeActor): Promise<Record<string, unknown> | null> {
    switch (input.kind) {
      case "staff_role":
        return (await reads.staff(site, actor)).items.find((s) => s.id === input.staffId) ?? null;
      case "approver_set":
      case "approver_remove": {
        const [staff, approvers] = await Promise.all([reads.staff(site, actor), reads.portalApprovers(site, actor)]);
        const person = staff.items.find((s) => s.id === input.staffId);
        if (!person) return null;
        const approver = approvers.items.find((a) => a.staffId === input.staffId);
        return { staffId: person.id, email: person.email, name: person.name, isActive: person.isActive, canSignIn: person.canSignIn,
          approver: approver ? { label: approver.label, addedAt: approver.addedAt } : null };
      }
      case "member_add":
        return (await reads.clientMembers(site, input.customerId, actor)).items
          .find((m) => m.email.toLowerCase() === input.email.toLowerCase()) ?? null;
      case "member_role":
      case "member_remove":
        return (await reads.clientMembers(site, input.customerId, actor)).items.find((m) => m.membershipId === input.membershipId) ?? null;
    }
  }

  /** Before and after in words, or a 422 when the change would change nothing or names no one. */
  function describe(input: WebsiteAccessChange, before: Record<string, unknown> | null) {
    const missing = () => unprocessable("The website has no such person for this change", { code: "website_access_request_not_found" });
    const same = (what: string) => unprocessable(`Nothing to change: ${what}`, { code: "website_access_request_no_change" });
    const approver = (before?.approver ?? null) as { label: string } | null;
    switch (input.kind) {
      case "staff_role":
        if (!before) throw missing();
        if (before.role === input.role) throw same(`${who(before)} is already ${input.role}`);
        return { title: `Make ${who(before)} ${input.role} (staff)`, beforeText: `role: ${String(before.role)}`, afterText: `role: ${input.role}` };
      case "approver_set":
        if (!before) throw missing();
        if (approver?.label === input.label) throw same(`${who(before)} is already a portal approver as "${input.label}"`);
        return { title: `${approver ? "Relabel" : "Add"} ${who(before)} as portal approver`,
          beforeText: approver ? `portal approver: "${approver.label}"` : "not a portal approver", afterText: `portal approver: "${input.label}"` };
      case "approver_remove":
        if (!before) throw missing();
        if (!approver) throw same(`${who(before)} is not a portal approver`);
        return { title: `Remove ${who(before)} as portal approver`, beforeText: `portal approver: "${approver.label}"`, afterText: "not a portal approver" };
      case "member_add":
        if (before?.role === input.role) throw same(`${input.email} is already a ${input.role} of this client`);
        return { title: `Add ${input.name} to a client company as ${input.role}`,
          beforeText: before ? `member: ${String(before.role)}` : "not a member", afterText: `member: ${input.role} (${input.email})` };
      case "member_role":
        if (!before) throw missing();
        if (before.role === input.role) throw same(`${who(before)} is already ${input.role}`);
        return { title: `Make ${who(before)} ${input.role} of their client company`, beforeText: `member: ${String(before.role)}`,
          afterText: `member: ${input.role}` };
      case "member_remove":
        if (!before) throw missing();
        return { title: `Remove ${who(before)} from their client company`, beforeText: `member: ${String(before.role)}`,
          afterText: "not a member (keeps their sign-in)" };
    }
  }

  async function requesterName(actor: { agentId: string | null; userId: string | null }) {
    if (actor.agentId) {
      const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId));
      return row?.name ?? "An agent";
    }
    if (actor.userId) {
      const [row] = await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, actor.userId));
      return row?.name ?? "A team member";
    }
    return "A team member";
  }

  /**
   * Opens the card with the row as it is now. Changes nothing and makes no write call. The same open ask (same change)
   * returns the open card.
   */
  async function request(site: SiteRow, input: WebsiteAccessChangeRequestInput,
    actor: { agentId: string | null; userId: string | null; bridge: WebsiteBridgeActor }) {
    if (!site.dataBridgeWriteSecretId) throw accessChangesOff();
    const changeKey = sha256(input.change);
    const [open] = await db.select().from(approvals).where(and(eq(approvals.companyId, site.companyId),
      eq(approvals.type, WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE), inArray(approvals.status, [...OPEN]),
      sql`${approvals.payload}->>'siteId' = ${site.id}`, sql`${approvals.payload}->>'changeKey' = ${changeKey}`)).limit(1);
    if (open) return { approval: open, replayed: true };

    const before = await subjectOf(site, input.change, actor.bridge);
    const words = describe(input.change, before);
    const asker = await requesterName(actor);
    const payload: Payload = {
      siteId: site.id,
      siteName: site.name,
      title: words.title,
      summary: `${asker} asks for an access change on ${site.name}: ${words.beforeText} → ${words.afterText}. `
        + "Approving makes it on the website in your name. If this person's access changes before you decide, this card is void.",
      change: input.change,
      changeKey,
      before,
      beforeSha256: sha256(before),
      beforeText: words.beforeText,
      afterText: words.afterText,
      requestedBy: asker,
      note: input.note ?? null,
    };
    const [created] = await db.insert(approvals).values({
      companyId: site.companyId,
      type: WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE,
      requestedByAgentId: actor.agentId,
      requestedByUserId: actor.userId,
      status: "pending",
      payload: payload as unknown as Record<string, unknown>,
    }).returning();
    return { approval: created!, replayed: false };
  }

  /** Approve or reject: only a signed-in person with website:publish for the card's site. */
  async function assertCanDecide(actor: Actor, approval: Pick<ApprovalRow, "type" | "companyId" | "payload">) {
    if (approval.type !== WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE) return;
    if (actor.type !== "board" || !actor.userId || (actor.source !== "session" && actor.source !== "local_implicit")) {
      throw forbidden("Only a person can decide an access change, by clicking in GSAM.", { code: "website_access_person_only" });
    }
    const siteId = (approval.payload as Partial<Payload> | null)?.siteId;
    if (typeof siteId !== "string") throw unprocessable("This access change names no site");
    const decision = await access.decide({ actor, action: "website:publish", resource: { type: "company", companyId: approval.companyId }, scope: { siteId } });
    if (!decision.allowed) {
      throw forbidden("Only people with Publish rights for this site can decide an access change.", { code: "website_access_decider_missing" });
    }
  }

  async function setPayload(approval: ApprovalRow, patch: Partial<Payload>) {
    const [updated] = await db.update(approvals).set({ payload: { ...(approval.payload as object), ...patch }, updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    return updated ?? approval;
  }

  async function voidCard(approval: ApprovalRow, note: string, userId: string) {
    const [updated] = await db.update(approvals).set({ status: "cancelled", decisionNote: note.slice(0, 1000), updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    await tellRequester?.(updated ?? approval, note, "cancelled", userId);
    return updated ?? approval;
  }

  /**
   * After the approval service recorded the approval: check the row is still the one on the card, then make the
   * change in the approver's name. A changed row voids the card (409 website_access_request_void). A site that cannot
   * be reached puts the card back to pending, so the person can try again.
   */
  async function applyApproval(approval: ApprovalRow, userId: string): Promise<ApprovalRow> {
    if (approval.type !== WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE) return approval;
    const p = approval.payload as unknown as Payload;
    const person = { type: "user", id: userId } as const;
    try {
      const site = await sites.getSite(approval.companyId, p.siteId);
      if (!site) throw unprocessable("The access change's site is gone");
      let current = approval;
      // Once sent, a retry only replays the same key: the row may have moved because the change landed.
      if (!p.sentAt) {
        if (sha256(await subjectOf(site, p.change, person)) !== p.beforeSha256) {
          const note = "Void: this person's access changed on the website after the request. Nothing was changed. Ask again for it as it is now.";
          await voidCard(approval, note, userId);
          throw new HttpError(409, note, { code: "website_access_request_void" });
        }
        current = await setPayload(approval, { sentAt: new Date().toISOString() });
      }
      const result = await change(site, p.change, person, accessChangeIdempotencyKey(approval.id));
      await logActivity(db, {
        companyId: approval.companyId, actorType: "user", actorId: userId, action: "website.access_changed",
        entityType: "website_site", entityId: site.id,
        details: { ...accessChangeLogDetails(p.change), approvalId: approval.id, approvedByUserId: userId,
          requestedByAgentId: approval.requestedByAgentId },
      });
      return await setPayload(current, { result: result as Record<string, unknown> });
    } catch (error) {
      if (error instanceof HttpError && (error.details as { code?: string } | undefined)?.code === "website_access_request_void") throw error;
      if (error instanceof WebsiteBridgeError && CLOSES_CARD.has(error.code)) {
        await voidCard(approval, error.code === "conflict"
          ? `The website refused the change: ${error.message} Nothing was changed.`
          : `The website refused this access change: ${error.message}`, userId);
      } else {
        await db.update(approvals)
          .set({ status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, "approved")));
      }
      throw error;
    }
  }

  /** A rejection changes nothing on the site; the asker hears why. */
  async function applyRejection(approval: ApprovalRow, userId: string, decisionNote: string | null | undefined) {
    if (approval.type !== WEBSITE_ACCESS_CHANGE_APPROVAL_TYPE) return;
    const p = approval.payload as Partial<Payload>;
    const why = decisionNote?.trim() ? ` Reason: ${decisionNote.trim()}` : " No reason was given.";
    await tellRequester?.(approval, `Not approved: ${p.title ?? "the access change"}. Nothing was changed.${why}`, "rejected", userId);
  }

  return { reads, change, request, assertCanDecide, applyApproval, applyRejection };
}
export type WebsiteAccessService = ReturnType<typeof websiteAccessService>;
