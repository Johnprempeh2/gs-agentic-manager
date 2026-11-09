import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, approvals, authUsers } from "@greatstone/db";
import {
  COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE,
  WEBSITE_LICENCE_SECRET_FIELDS,
  websiteCommerceSettingsOperation,
  type CommerceChangeRequestApprovalPayload,
  type WebsiteCommerceChangeRequestInput,
  type WebsiteDataResource,
} from "@greatstone/shared";
import { HttpError, forbidden, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import { logActivity } from "../activity-log.js";
import { secretService } from "../secrets.js";
import type { SiteRow } from "./module.js";
import { websiteModuleService } from "./module.js";
import { WebsiteBridgeError, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { capabilityNotConfigured, websiteDataBridgeService, type BridgeSite, type WebsiteDataBridgeOptions } from "./data-bridge.js";
import type { TellRequester } from "./commerce-publish-approval.js";

// Commerce settings an agent asks a person for (GRE-4783, GRE-4079 step 5b; contract "Commerce settings" in
// contracts/gs-bridge-v1). John (5 Nov): anything that emails a client, changes money, or issues or revokes a licence
// key goes through a person's approval card, like refunds. So:
//
// - an agent asks: GSAM checks the change is one of the settings, keeps it on a commerce_change_request card and
//   changes nothing. A licence key or download link goes to the vault; the card shows a key's last four only;
// - a person with website:commerce approves it and GSAM makes the change on the write key in their name, once;
// - the site refuses an agent actor on every people-only change (403 denied) as a second wall.
//
// Idempotency: an approved card's site key comes from the approval id, so a second click or a retry after a lost
// answer replays the site's answer instead of changing twice.

type ApprovalRow = typeof approvals.$inferSelect;
type Actor = Express.Request["actor"];
type Payload = CommerceChangeRequestApprovalPayload;

const OPEN = ["pending", "revision_requested"] as const;
/** The site refused the change for good: the card cannot be approved as it stands. */
const CLOSES_CARD = new Set(["conflict", "not_found", "bad_request", "denied", "idempotency_mismatch"]);

export function commerceChangeIdempotencyKey(approvalId: string) {
  return createHash("sha256").update(`${COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE}:${approvalId}:apply`).digest().subarray(0, 16).toString("base64url");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What each change does, in words, for the card's title. */
const WORDS: Record<string, string> = {
  "orders.edit": "Change an order's status",
  "orders.notify_licence": "Email the client that their licence is ready",
  "enquiries.edit": "Change an enquiry's status",
  "enquiries.delete": "Delete a front door lead for good",
  "customers.create": "Add a client company with a customer tier",
  "customers.edit": "Change a client company's customer tier",
  "engagements.create": "Add a timeline item",
  "engagements.edit": "Change a timeline item the client can see",
  "engagements.delete": "Delete a timeline item the client can see",
  "engagements.share": "Share a timeline item with the client",
  "engagements.unshare": "Stop sharing a timeline item with the client",
  "licences.issue": "Issue a licence",
  "licences.edit": "Change a licence's key or download link",
  "licences.revoke": "Revoke a licence",
  "licences.reissue": "Re-issue a revoked licence",
  "customer-tiers.create": "Add a customer tier",
  "customer-tiers.edit": "Change a customer tier",
  "portal-acceptances.resend": "Send a client's portal receipt again",
};
/** Changes that email a client: the card says so. */
const EMAILS = new Set(["orders.notify_licence", "portal-acceptances.resend"]);
/** The record a path names, to read for the card's words. */
const SUBJECT: Record<string, WebsiteDataResource> = {
  orders: "orders", customers: "customers", engagements: "engagements", licences: "licences", "portal-acceptances": "portal-acceptances",
};

export function commerceChangeApprovals(db: Db, bridgeOptions: WebsiteDataBridgeOptions = {}, tellRequester?: TellRequester) {
  const access = accessService(db);
  const bridge = websiteDataBridgeService(db, bridgeOptions);
  const sites = websiteModuleService(db);
  const secrets = secretService(db);

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

  /** A name for the record the change touches (a client, an order reference, a licence's product), or null. */
  async function subjectOf(site: BridgeSite, parts: string[], actor: WebsiteBridgeActor) {
    const resource = SUBJECT[parts[0]!];
    if (!resource || !parts[1]) return null;
    try {
      const { item } = await bridge.get(site, resource, parts[1], actor);
      return str(item.name) ?? str(item.title) ?? str(item.reference) ?? str(item.offering_name) ?? null;
    } catch {
      return null; // the card still says what the change is; the site checks the record again at approval
    }
  }

  /**
   * Opens the card. Changes nothing and makes no write call. A licence key or download link goes to the vault. The
   * same open ask (same change) returns the open card.
   */
  async function request(site: SiteRow, input: WebsiteCommerceChangeRequestInput,
    actor: { agentId: string | null; userId: string | null; bridge: WebsiteBridgeActor }) {
    if (!site.dataBridgeWriteSecretId) throw capabilityNotConfigured("write");
    const parts = input.path.split("/");
    const operation = websiteCommerceSettingsOperation(input.method, parts, input.body);
    if (!operation) {
      throw unprocessable("That is not a commerce settings change", { code: "website_commerce_change_request_invalid" });
    }
    const changeKey = createHash("sha256").update(stable({ method: input.method, path: input.path, body: input.body ?? null })).digest("hex");
    const [open] = await db.select().from(approvals).where(and(eq(approvals.companyId, site.companyId),
      eq(approvals.type, COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE), inArray(approvals.status, [...OPEN]),
      sql`${approvals.payload}->>'siteId' = ${site.id}`, sql`${approvals.payload}->>'changeKey' = ${changeKey}`)).limit(1);
    if (open) return { approval: open, replayed: true };

    const body = input.body ? { ...input.body } : null;
    const secretValues: Record<string, unknown> = {};
    for (const field of WEBSITE_LICENCE_SECRET_FIELDS) {
      if (body && field in body) {
        secretValues[field] = body[field];
        delete body[field];
      }
    }
    const vaultedFields = Object.keys(secretValues);
    const key = str(secretValues.licenceKey);
    const subject = await subjectOf(site, parts, actor.bridge) ?? str(body?.name) ?? str(body?.title) ?? str(body?.offeringName);
    const asker = await requesterName(actor);
    const words = WORDS[operation.name] ?? operation.name;
    const title = subject ? `${words}: ${subject}` : words;
    let vaultRef: string | null = null;
    if (vaultedFields.length) {
      const created = await secrets.create(site.companyId, {
        name: `Website licence for an approval ${randomUUID().slice(0, 8)}`,
        provider: "local_encrypted",
        value: JSON.stringify(secretValues),
        description: `The licence key or download link an approval card on ${site.domain} sends when a person approves it (GRE-4783). Removed once the card is decided.`,
      }, { agentId: actor.agentId, userId: actor.userId });
      vaultRef = created.id;
    }
    const payload: Payload = {
      siteId: site.id,
      siteName: site.name,
      title,
      summary: `${asker} asks: ${title}. `
        + (EMAILS.has(operation.name) ? "This sends an email to the client. " : "")
        + "Approving makes this change on the website in your name. If the record changed after the ask, the website refuses it and nothing changes.",
      operation: operation.name,
      method: input.method,
      path: input.path,
      body,
      vaultedFields,
      licenceKeyLast4: key ? key.slice(-4) : null,
      vaultRef,
      changeKey,
      requestedBy: asker,
      note: input.note ?? null,
    };
    const [created] = await db.insert(approvals).values({
      companyId: site.companyId,
      type: COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE,
      requestedByAgentId: actor.agentId,
      requestedByUserId: actor.userId,
      status: "pending",
      payload: payload as unknown as Record<string, unknown>,
    }).returning();
    return { approval: created!, replayed: false, operation };
  }

  /** Approve or reject: only a signed-in person with website:commerce for the card's site. */
  async function assertCanDecide(actor: Actor, approval: Pick<ApprovalRow, "type" | "companyId" | "payload">) {
    if (approval.type !== COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE) return;
    if (actor.type !== "board" || !actor.userId || (actor.source !== "session" && actor.source !== "local_implicit")) {
      throw forbidden("Only a person can decide a commerce change, by clicking in GSAM.", { code: "commerce_change_person_only" });
    }
    const siteId = (approval.payload as Partial<Payload> | null)?.siteId;
    if (typeof siteId !== "string") throw unprocessable("This commerce change names no site");
    const decision = await access.decide({ actor, action: "website:commerce", resource: { type: "company", companyId: approval.companyId }, scope: { siteId } });
    if (!decision.allowed) {
      throw forbidden("Only people with Commerce rights for this site can decide a commerce change.", { code: "commerce_change_decider_missing" });
    }
  }

  async function setPayload(approval: ApprovalRow, patch: Partial<Payload>) {
    const [updated] = await db.update(approvals).set({ payload: { ...(approval.payload as object), ...patch }, updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    return updated ?? approval;
  }

  /** The vaulted key goes once the card is decided for good: nothing is left to send it. */
  async function forgetSecret(approval: ApprovalRow) {
    const p = approval.payload as Partial<Payload>;
    if (!p.vaultRef) return approval;
    await secrets.remove(p.vaultRef).catch(() => null);
    return setPayload(approval, { vaultRef: null });
  }

  async function closeCard(approval: ApprovalRow, note: string, userId: string) {
    const [updated] = await db.update(approvals).set({ status: "cancelled", decisionNote: note.slice(0, 1000), updatedAt: new Date() })
      .where(eq(approvals.id, approval.id)).returning();
    const closed = await forgetSecret(updated ?? approval);
    await tellRequester?.(closed, note, "cancelled", userId);
    return closed;
  }

  async function bodyToSend(approval: ApprovalRow, p: Payload) {
    const body: Record<string, unknown> | undefined = p.body ? { ...p.body } : undefined;
    if (!p.vaultRef) {
      if (p.vaultedFields?.length) throw unprocessable("The licence key for this card is gone. Ask again.", { code: "website_commerce_change_secret_missing" });
      return body;
    }
    const value = await secrets.resolveSecretValue(approval.companyId, p.vaultRef, "latest", {
      accessContext: { consumerType: "system", consumerId: `website-commerce-change:${approval.id}`, configPath: "approval.vaultRef", actorType: "system" },
    });
    return { ...(body ?? {}), ...(JSON.parse(value) as Record<string, unknown>) };
  }

  /**
   * After the approval service recorded the approval: make the change in the approver's name, once. The site's
   * refusal (a stale row version, a cancelled order, a revoked licence) closes the card. A site that cannot be
   * reached puts the card back to pending, so the person can try again.
   */
  async function applyApproval(approval: ApprovalRow, userId: string): Promise<ApprovalRow> {
    if (approval.type !== COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE) return approval;
    const p = approval.payload as unknown as Payload;
    const person = { type: "user", id: userId } as const;
    try {
      const site = await sites.getSite(approval.companyId, p.siteId);
      if (!site) throw unprocessable("The commerce change's site is gone");
      const body = await bodyToSend(approval, p);
      let current = p.sentAt ? approval : await setPayload(approval, { sentAt: new Date().toISOString() });
      const result = await bridge.commerce.settingsWrite(site, p.method, p.path.split("/").map(encodeURIComponent).join("/"), body, person,
        commerceChangeIdempotencyKey(approval.id));
      const item = "item" in result ? result.item : null;
      await logActivity(db, {
        companyId: approval.companyId, actorType: "user", actorId: userId, action: "website.commerce_changed",
        entityType: "website_site", entityId: site.id,
        details: { operation: p.operation, path: p.path, rowId: item && typeof item.id === "string" ? item.id : "id" in result ? result.id : null,
          ...("email" in result && result.email ? { email: result.email } : {}),
          approvalId: approval.id, approvedByUserId: userId, requestedByAgentId: approval.requestedByAgentId },
      });
      current = await setPayload(current, { result: result as Record<string, unknown> });
      return await forgetSecret(current);
    } catch (error) {
      if (error instanceof WebsiteBridgeError && CLOSES_CARD.has(error.code)) {
        await closeCard(approval, `The website refused this change: ${error.message} Nothing was changed.`, userId);
      } else if (error instanceof HttpError && (error.details as { code?: string } | undefined)?.code === "website_commerce_change_secret_missing") {
        await closeCard(approval, `${error.message} Nothing was changed.`, userId);
      } else {
        await db.update(approvals)
          .set({ status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, "approved")));
      }
      throw error;
    }
  }

  /** A rejection changes nothing on the site; the vaulted key goes and the asker hears why. */
  async function applyRejection(approval: ApprovalRow, userId: string, decisionNote: string | null | undefined) {
    if (approval.type !== COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE) return;
    const rejected = await forgetSecret(approval);
    const p = rejected.payload as Partial<Payload>;
    const why = decisionNote?.trim() ? ` Reason: ${decisionNote.trim()}` : " No reason was given.";
    await tellRequester?.(rejected, `Not approved: ${p.title ?? "the commerce change"}. Nothing was changed.${why}`, "rejected", userId);
  }

  return { request, assertCanDecide, applyApproval, applyRejection };
}
export type CommerceChangeApprovals = ReturnType<typeof commerceChangeApprovals>;
