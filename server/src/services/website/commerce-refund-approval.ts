import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, approvals, authUsers } from "@greatstone/db";
import {
  COMMERCE_REFUND_REQUEST_APPROVAL_TYPE,
  type CommerceRefundRequestApprovalPayload,
  type WebsiteCommerceRefundRequestInput,
} from "@greatstone/shared";
import { forbidden, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import type { SiteRow } from "./module.js";
import { websiteModuleService } from "./module.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { capabilityNotConfigured, websiteDataBridgeService, type WebsiteDataBridgeOptions } from "./data-bridge.js";

// The commerce_refund_request approval (GRE-2354 2c(b), design section 5). An agent or a person asks for a refund on
// a website order. GSAM opens the card first, then records the request on the site with the refund_request key, so
// the request always has an owner: the card. A person with website:commerce decides it, and GSAM sends that decision
// to the site in their name. Nothing here moves money: a person refunds in Stripe, and the site marks the request done.
//
// Idempotency: each step's key comes from the approval id, so a retry, a second click or a re-send after a lost
// answer replays the site's stored answer instead of writing twice.

type ApprovalRow = typeof approvals.$inferSelect;
type Actor = Express.Request["actor"];

const OPEN = ["pending", "revision_requested"] as const;

/** 22 base64url characters from the approval and the step: the same step always has the same key. */
export function refundIdempotencyKey(approvalId: string, step: "request" | "approved" | "rejected") {
  return createHash("sha256").update(`${COMMERCE_REFUND_REQUEST_APPROVAL_TYPE}:${approvalId}:${step}`).digest().subarray(0, 16).toString("base64url");
}

/**
 * The site key for recording the request. With a caller's key it comes from that key, so two cards opened at the
 * same moment under it still record one request on the site; the second card's decision then fails and cancels it.
 */
function requestKeyOf(approval: Pick<ApprovalRow, "id" | "companyId">, clientKey: string | undefined) {
  return clientKey
    ? createHash("sha256").update(`${COMMERCE_REFUND_REQUEST_APPROVAL_TYPE}:${approval.companyId}:client:${clientKey}`).digest().subarray(0, 16).toString("base64url")
    : refundIdempotencyKey(approval.id, "request");
}

function payloadOf(approval: Pick<ApprovalRow, "payload">) {
  return (approval.payload ?? {}) as Partial<CommerceRefundRequestApprovalPayload>;
}

function formatMinor(amountMinor: number, currency: string | null) {
  const major = (amountMinor / 100).toFixed(2);
  return currency ? `${currency} ${major}` : `${major} (minor units ${amountMinor})`;
}

/**
 * Recording: the site answers inside one transaction, so a refusal it sent means nothing was recorded. A lost answer
 * (a network error, a timeout, 502/503/504) or an answer GSAM could not read (`bad_response`, which may be a 2xx)
 * may hide a recorded request, so the card stays open for it.
 */
function definite(error: unknown) {
  return error instanceof WebsiteBridgeError ? !error.retryable && error.code !== "bad_response" : true;
}
/** Deciding: the site says this request can never take the decision (no longer open, over the refundable amount). */
const CLOSES_CARD = new Set(["conflict", "over_refundable", "not_found", "bad_request"]);

export function commerceRefundApprovals(db: Db, bridgeOptions: WebsiteDataBridgeOptions = {}) {
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

  async function setPayload(approval: ApprovalRow, patch: Partial<CommerceRefundRequestApprovalPayload>) {
    const [updated] = await db
      .update(approvals)
      .set({ payload: { ...payloadOf(approval), ...patch }, updatedAt: new Date() })
      .where(eq(approvals.id, approval.id))
      .returning();
    return updated ?? approval;
  }

  async function cancel(approval: ApprovalRow, note: string) {
    const [updated] = await db
      .update(approvals)
      .set({ status: "cancelled", decisionNote: note.slice(0, 1000), updatedAt: new Date() })
      .where(eq(approvals.id, approval.id))
      .returning();
    return updated ?? approval;
  }

  function fromItem(item: Record<string, unknown>): Partial<CommerceRefundRequestApprovalPayload> {
    return {
      requestId: String(item.id),
      requestStatus: typeof item.status === "string" ? item.status : null,
      ...(typeof item.currency === "string" ? { currency: item.currency } : {}),
    };
  }

  /**
   * Opens the card, then records the request on the site. A refusal from the site (over the refundable amount, no
   * such order) cancels the card and answers the error. If the site's answer is lost, the card stays open with no
   * request id; deciding it sends the same request again first (same key), so it is recorded at most once.
   */
  async function request(site: SiteRow, input: WebsiteCommerceRefundRequestInput,
    actor: { agentId: string | null; userId: string | null; bridge: WebsiteBridgeActor }, clientKey?: string) {
    if (!site.dataBridgeRefundSecretId) throw capabilityNotConfigured("refund_request");
    // the caller's Idempotency-Key: the same key is the same card, so a retried call opens no second request
    if (clientKey) {
      const [existing] = await db.select().from(approvals).where(and(eq(approvals.companyId, site.companyId),
        eq(approvals.type, COMMERCE_REFUND_REQUEST_APPROVAL_TYPE), sql`${approvals.payload}->>'clientKey' = ${clientKey}`)).limit(1);
      if (existing) {
        const p = payloadOf(existing);
        if (p.siteId !== site.id || p.orderId !== input.orderId || p.amountMinor !== input.amountMinor || p.reason !== input.reason) {
          throw new WebsiteBridgeError("idempotency_mismatch");
        }
        return { approval: existing, request: null, confirmed: Boolean(p.requestId), replayed: true };
      }
    }
    const who = await requesterName(actor);
    const payload: CommerceRefundRequestApprovalPayload = {
      siteId: site.id,
      siteName: site.name,
      title: `Refund request: order ${input.orderId.slice(0, 8)}`,
      summary: `${who} asks for a refund of ${formatMinor(input.amountMinor, null)} on order ${input.orderId}. Reason: ${input.reason}. `
        + "Approving records the decision on the website only: a person still makes the refund in Stripe.",
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: null,
      reason: input.reason,
      requestedBy: who,
      requestId: null,
      requestStatus: null,
      ...(clientKey ? { clientKey } : {}),
    };
    const [created] = await db
      .insert(approvals)
      .values({
        companyId: site.companyId,
        type: COMMERCE_REFUND_REQUEST_APPROVAL_TYPE,
        requestedByAgentId: actor.agentId,
        requestedByUserId: actor.userId,
        status: "pending",
        payload: payload as unknown as Record<string, unknown>,
      })
      .returning();
    const approval = created!;
    try {
      const recorded = await bridge.commerce.requestRefund(site, input, actor.bridge, requestKeyOf(approval, clientKey));
      const updated = await setPayload(approval, fromItem(recorded.item));
      return { approval: updated, request: recorded.item, confirmed: true, replayed: false };
    } catch (error) {
      if (!definite(error)) return { approval, request: null, confirmed: false, replayed: false };
      await cancel(approval, `The website did not record the request: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** Approve or reject: only a signed-in person with website:commerce for the card's site. */
  async function assertCanDecide(actor: Actor, approval: Pick<ApprovalRow, "type" | "companyId" | "payload">) {
    if (approval.type !== COMMERCE_REFUND_REQUEST_APPROVAL_TYPE) return;
    if (actor.type !== "board" || !actor.userId || (actor.source !== "session" && actor.source !== "local_implicit")) {
      throw forbidden("Only a person can decide a refund request, by clicking in GSAM.", { code: "commerce_refund_person_only" });
    }
    const siteId = payloadOf(approval).siteId;
    if (typeof siteId !== "string") throw unprocessable("This refund request names no site");
    const decision = await access.decide({
      actor,
      action: "website:commerce",
      resource: { type: "company", companyId: approval.companyId },
      scope: { siteId },
    });
    if (!decision.allowed) {
      throw forbidden("Only people with Commerce rights for this site can decide a refund request.", { code: "commerce_refund_decider_missing" });
    }
  }

  /**
   * After the approval service recorded the decision: send it to the site as the deciding person. When the site
   * cannot be reached the card goes back to pending and the error goes to the person, so they can try again. When the
   * site says the request cannot be decided (no longer open, over the refundable amount), the card is cancelled with
   * the reason: it does not wait for a decision that can never land.
   */
  async function applyDecision(approval: ApprovalRow, decision: "approved" | "rejected", userId: string): Promise<ApprovalRow> {
    if (approval.type !== COMMERCE_REFUND_REQUEST_APPROVAL_TYPE) return approval;
    const payload = payloadOf(approval);
    const person: WebsiteBridgeActor & { type: "user" } = { type: "user", id: userId };
    try {
      const site = await sites.getSite(approval.companyId, payload.siteId as string);
      if (!site) throw unprocessable("The refund request's site is gone");
      let current = approval;
      let requestId = payload.requestId ?? null;
      if (!requestId) {
        const recorded = await bridge.commerce.requestRefund(site, {
          orderId: payload.orderId as string, amountMinor: payload.amountMinor as number, reason: payload.reason as string,
        }, approval.requestedByAgentId ? { type: "agent", id: approval.requestedByAgentId }
          : approval.requestedByUserId ? { type: "user", id: approval.requestedByUserId } : person, requestKeyOf(approval, payload.clientKey));
        current = await setPayload(current, fromItem(recorded.item));
        requestId = String(recorded.item.id);
      }
      const decided = await bridge.commerce.decideRefund(site, requestId, { decision, approvalRef: approval.id }, person,
        refundIdempotencyKey(approval.id, decision));
      return await setPayload(current, fromItem(decided.item));
    } catch (error) {
      if (error instanceof WebsiteBridgeError && CLOSES_CARD.has(error.code)) {
        await cancel(approval, `The website could not take this decision: ${error.message}`);
      } else {
        // a lost answer, or something a person can fix (a key, the clock): the card stays open for another try
        await db
          .update(approvals)
          .set({ status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), inArray(approvals.status, ["approved", "rejected"])));
      }
      throw error;
    }
  }

  async function openForSite(companyId: string, siteId: string) {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, COMMERCE_REFUND_REQUEST_APPROVAL_TYPE), inArray(approvals.status, [...OPEN])));
    return rows.filter((row) => payloadOf(row).siteId === siteId);
  }

  return { request, assertCanDecide, applyDecision, openForSite };
}
export type CommerceRefundApprovals = ReturnType<typeof commerceRefundApprovals>;
