import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, approvals, authUsers } from "@greatstone/db";
import {
  COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE,
  type CommercePublishRequestApprovalPayload,
  type WebsiteCommercePublishRequestInput,
} from "@greatstone/shared";
import { HttpError, forbidden, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import { logActivity } from "../activity-log.js";
import type { SiteRow } from "./module.js";
import { websiteModuleService } from "./module.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { capabilityNotConfigured, websiteDataBridgeService, type WebsiteDataBridgeOptions } from "./data-bridge.js";

// The commerce_publish_request approval (GRE-4089; John, 5 Nov: "agents can publish anything but request approval to
// do so"). An agent asks to publish or archive one catalogue record. GSAM reads the record, keeps it on the card and
// publishes nothing. A person with website:commerce approves it, and GSAM publishes through the write key in that
// person's name, at the row version on the card. If the record changed after the ask, the card is void: the agent
// asks again. Direct publish still refuses agents (website_commerce_people_only).
//
// Idempotency: the site key for the publish comes from the approval id, so a second click or a retry after a lost
// answer replays the site's answer instead of publishing twice.

type ApprovalRow = typeof approvals.$inferSelect;
type Actor = Express.Request["actor"];
type Payload = CommercePublishRequestApprovalPayload;

const OPEN = ["pending", "revision_requested"] as const;
/** The record kept on the card for the person to read. A larger record keeps its plain fields only. */
const MAX_ITEM_BYTES = 16 * 1024;
const RESOURCE_WORD: Record<Payload["resource"], string> = {
  vendors: "vendor", categories: "category", offerings: "offering", "pricing-rules": "pricing rule",
};

export function publishIdempotencyKey(approvalId: string) {
  return createHash("sha256").update(`${COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE}:${approvalId}:publish`).digest().subarray(0, 16).toString("base64url");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The record's content, so a change the row version does not show (a child row) still voids the card. */
export function itemSha256(item: Record<string, unknown>) {
  return createHash("sha256").update(stable(item)).digest("hex");
}

function rowVersionOf(item: Record<string, unknown>) {
  const raw = item.row_version ?? item.rowVersion;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function statusOf(item: Record<string, unknown>) {
  return typeof item.status === "string" ? item.status : null;
}

function nameOf(item: Record<string, unknown>) {
  for (const key of ["name", "title", "slug"]) if (typeof item[key] === "string" && item[key]) return item[key] as string;
  return null;
}

function snapshotOf(item: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(item)) <= MAX_ITEM_BYTES) return item;
  const plain = Object.fromEntries(Object.entries(item).filter(([, v]) => v === null || typeof v !== "object")
    .map(([k, v]) => [k, typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v]));
  return { ...plain, _cut: "The record is large: only its plain fields are shown" };
}

function payloadOf(approval: Pick<ApprovalRow, "payload">) {
  return (approval.payload ?? {}) as Partial<Payload>;
}

/** The site refused the publish for good: the card cannot be approved as it stands. */
const CLOSES_CARD = new Set(["conflict", "not_found", "bad_request", "denied"]);

export type TellRequester = (approval: ApprovalRow, message: string, outcome: "rejected" | "cancelled", userId: string) => Promise<void>;

export function commercePublishApprovals(db: Db, bridgeOptions: WebsiteDataBridgeOptions = {}, tellRequester?: TellRequester) {
  const access = accessService(db);
  const bridge = websiteDataBridgeService(db, bridgeOptions);
  const sites = websiteModuleService(db);

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

  async function readItem(site: SiteRow, resource: Payload["resource"], id: string, actor: WebsiteBridgeActor) {
    const { item } = await bridge.commerce.get(site, resource, id, {}, actor) as { item: Record<string, unknown> };
    if (!item || typeof item !== "object") throw new WebsiteBridgeError("bad_response", 200, "no item");
    return item;
  }

  /**
   * Opens the card with the record as it is now. Publishes nothing and makes no write call. The same open ask (same
   * record, action and row version) returns the open card.
   */
  async function request(site: SiteRow, input: WebsiteCommercePublishRequestInput,
    actor: { agentId: string | null; userId: string | null; bridge: WebsiteBridgeActor }) {
    if (!site.dataBridgeWriteSecretId) throw capabilityNotConfigured("write");
    const item = await readItem(site, input.resource, input.id, actor.bridge);
    const rowVersion = rowVersionOf(item);
    if (rowVersion === null) throw new WebsiteBridgeError("bad_response", 200, "the record has no row version");
    const target = input.action === "publish" ? "published" : "archived";
    if (statusOf(item) === target) {
      throw unprocessable(`This ${RESOURCE_WORD[input.resource]} is already ${target}`, { code: "commerce_publish_request_no_change" });
    }

    const [open] = await db.select().from(approvals).where(and(eq(approvals.companyId, site.companyId),
      eq(approvals.type, COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE), inArray(approvals.status, [...OPEN]),
      sql`${approvals.payload}->>'siteId' = ${site.id}`, sql`${approvals.payload}->>'itemId' = ${input.id}`,
      sql`${approvals.payload}->>'action' = ${input.action}`,
      sql`(${approvals.payload}->'before'->>'rowVersion')::bigint = ${rowVersion}`)).limit(1);
    if (open) return { approval: open, replayed: true };

    const who = await requesterName(actor);
    const word = RESOURCE_WORD[input.resource];
    const itemName = nameOf(item);
    const label = itemName ? `${word} "${itemName}"` : `${word} ${input.id.slice(0, 8)}`;
    const verb = input.action === "publish" ? "Publish" : "Archive";
    const payload: Payload = {
      siteId: site.id,
      siteName: site.name,
      title: `${verb} ${label}`,
      summary: `${who} asks to ${input.action} the ${label} on ${site.name}: ${statusOf(item) ?? "unknown"} → ${target}. `
        + "Approving does it on the website in your name. If the record changes before you decide, this card is void.",
      resource: input.resource,
      itemId: input.id,
      itemName,
      action: input.action,
      before: { status: statusOf(item), rowVersion },
      after: { status: target },
      item: snapshotOf(item),
      itemSha256: itemSha256(item),
      requestedBy: who,
      note: input.note ?? null,
    };
    const [created] = await db.insert(approvals).values({
      companyId: site.companyId,
      type: COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE,
      requestedByAgentId: actor.agentId,
      requestedByUserId: actor.userId,
      status: "pending",
      payload: payload as unknown as Record<string, unknown>,
    }).returning();
    return { approval: created!, replayed: false };
  }

  /** Approve or reject: only a signed-in person with website:commerce for the card's site. */
  async function assertCanDecide(actor: Actor, approval: Pick<ApprovalRow, "type" | "companyId" | "payload">) {
    if (approval.type !== COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE) return;
    if (actor.type !== "board" || !actor.userId || (actor.source !== "session" && actor.source !== "local_implicit")) {
      throw forbidden("Only a person can decide a publish request, by clicking in GSAM.", { code: "commerce_publish_person_only" });
    }
    const siteId = payloadOf(approval).siteId;
    if (typeof siteId !== "string") throw unprocessable("This publish request names no site");
    const decision = await access.decide({ actor, action: "website:commerce", resource: { type: "company", companyId: approval.companyId }, scope: { siteId } });
    if (!decision.allowed) {
      throw forbidden("Only people with Commerce rights for this site can decide a publish request.", { code: "commerce_publish_decider_missing" });
    }
  }

  async function setPayload(approval: ApprovalRow, patch: Partial<Payload>) {
    const [updated] = await db.update(approvals).set({ payload: { ...payloadOf(approval), ...patch }, updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    return updated ?? approval;
  }

  /** Void: the card closes with the reason, and the asker hears it. */
  async function voidCard(approval: ApprovalRow, note: string, userId: string) {
    const [updated] = await db.update(approvals).set({ status: "cancelled", decisionNote: note.slice(0, 1000), updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    await tellRequester?.(updated ?? approval, note, "cancelled", userId);
    return updated ?? approval;
  }

  /**
   * After the approval service recorded the approval: check the record is still the one on the card, then publish it
   * in the approver's name. A changed record voids the card (409 commerce_publish_request_void). A site that cannot be
   * reached puts the card back to pending, so the person can try again.
   */
  async function applyApproval(approval: ApprovalRow, userId: string): Promise<ApprovalRow> {
    if (approval.type !== COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE) return approval;
    const p = payloadOf(approval) as Payload;
    const person: WebsiteBridgeActor = { type: "user", id: userId };
    const operation = `${p.resource}.${p.action}`;
    try {
      const site = await sites.getSite(approval.companyId, p.siteId);
      if (!site) throw unprocessable("The publish request's site is gone");
      let current = approval;
      // Once sent, a retry only replays the same key: the record may have moved because the publish landed.
      if (!p.publishSentAt) {
        const now = await readItem(site, p.resource, p.itemId, person);
        const nowVersion = rowVersionOf(now);
        if (nowVersion !== p.before.rowVersion || itemSha256(now) !== p.itemSha256) {
          const note = `Void: the ${RESOURCE_WORD[p.resource]} changed after the request (row version ${p.before.rowVersion} → `
            + `${nowVersion ?? "unknown"}). Nothing was published. Ask again for the record as it is now.`;
          await voidCard(approval, note, userId);
          throw new HttpError(409, note, { code: "commerce_publish_request_void" });
        }
        current = await setPayload(approval, { publishSentAt: new Date().toISOString() });
      }
      const result = await bridge.commerce.write(site, "POST", `${p.resource}/${p.itemId}/${p.action}`,
        { expectedRowVersion: p.before.rowVersion }, person, publishIdempotencyKey(approval.id));
      const item = (result.item ?? {}) as Record<string, unknown>;
      await logActivity(db, {
        companyId: approval.companyId, actorType: "user", actorId: userId, action: "website.commerce_changed",
        entityType: "website_site", entityId: site.id,
        details: { operation, path: `${p.resource}/${p.itemId}/${p.action}`, rowId: p.itemId, approvalId: approval.id,
          approvedByUserId: userId, requestedByAgentId: approval.requestedByAgentId },
      });
      return await setPayload(current, { result: { status: statusOf(item), rowVersion: rowVersionOf(item) } });
    } catch (error) {
      if (error instanceof HttpError && (error.details as { code?: string } | undefined)?.code === "commerce_publish_request_void") throw error;
      if (error instanceof WebsiteBridgeError && CLOSES_CARD.has(error.code)) {
        await voidCard(approval, error.code === "conflict"
          ? `Void: the ${RESOURCE_WORD[p.resource]} changed on the website before it could be published. Nothing was published. Ask again.`
          : `The website refused to ${p.action} this ${RESOURCE_WORD[p.resource]}: ${error.message}`, userId);
      } else {
        // a lost answer, or something a person can fix (a key, the clock): the card stays open for another try
        await db.update(approvals)
          .set({ status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, "approved")));
      }
      throw error;
    }
  }

  /** A rejection changes nothing on the site; the asker hears why. */
  async function applyRejection(approval: ApprovalRow, userId: string, decisionNote: string | null | undefined) {
    if (approval.type !== COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE) return;
    const p = payloadOf(approval);
    const why = decisionNote?.trim() ? ` Reason: ${decisionNote.trim()}` : " No reason was given.";
    await tellRequester?.(approval, `Not approved: ${p.title ?? "the publish request"}. Nothing was published.${why}`, "rejected", userId);
  }

  return { request, assertCanDecide, applyApproval, applyRejection };
}
export type CommercePublishApprovals = ReturnType<typeof commercePublishApprovals>;
