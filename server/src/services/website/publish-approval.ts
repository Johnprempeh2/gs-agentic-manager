import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, approvals, authUsers, websiteEntry, websitePage } from "@greatstone/db";
import {
  WEBSITE_PUBLISH_APPROVAL_TYPE,
  type WebsitePublishApprovalPayload,
  type WebsitePublishChange,
} from "@greatstone/shared";
import { HttpError, forbidden, unprocessable } from "../../errors.js";
import { accessService } from "../access.js";
import { WEBSITE_MESSAGES, publishProposalText } from "./messages.js";
import type { SiteRow, WebsiteActor } from "./module.js";

// The website_publish approval (GRE-2109, ADR GRE-1914 section 6). An agent,
// or a person without Publish rights, proposes a Publish of a site. A person
// with website:publish for that site approves it ("Approve and Publish"), and
// the Publish starts in that person's name. Approval is that person's click;
// nothing else starts a Publish (John, 23 Oct, GRE-2053).

type ApprovalRow = typeof approvals.$inferSelect;

export interface WebsitePublishStartInput {
  companyId: string;
  siteId: string;
  approvalId: string;
  /** Always a person: the one who approved. */
  publishedByUserId: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
}

/** Starts a Publish and returns its release. Throws an HttpError (e.g. 409 busy) when it cannot start. */
export type WebsitePublishStarter = (input: WebsitePublishStartInput) => Promise<{ releaseId: string }>;

let publishStarter: WebsitePublishStarter | null = null;

/**
 * The publish job (plan 2.4, GRE-2108) registers how a Publish starts. Until
 * it does, approving a proposal answers 503 and the proposal stays open.
 */
export function registerWebsitePublishStarter(starter: WebsitePublishStarter | null) {
  publishStarter = starter;
}

function payloadOf(approval: Pick<ApprovalRow, "payload">) {
  return (approval.payload ?? {}) as Partial<WebsitePublishApprovalPayload>;
}

export function websitePublishApprovals(db: Db) {
  const access = accessService(db);

  /** Every approved page and entry of the site: what the next Publish takes live. */
  async function approvedChanges(companyId: string, siteId: string): Promise<WebsitePublishChange[]> {
    const pages = await db
      .select({ id: websitePage.id, revisionId: websitePage.approvedRevisionId, title: websitePage.title })
      .from(websitePage)
      .where(and(
        eq(websitePage.companyId, companyId),
        eq(websitePage.siteId, siteId),
        eq(websitePage.status, "approved"),
        isNotNull(websitePage.approvedRevisionId),
        isNull(websitePage.archivedAt),
      ));
    const entries = await db
      .select({ id: websiteEntry.id, revisionId: websiteEntry.approvedRevisionId, collection: websiteEntry.collection, entryKey: websiteEntry.entryKey })
      .from(websiteEntry)
      .where(and(
        eq(websiteEntry.companyId, companyId),
        eq(websiteEntry.siteId, siteId),
        eq(websiteEntry.status, "approved"),
        isNotNull(websiteEntry.approvedRevisionId),
        isNull(websiteEntry.archivedAt),
      ));
    return [
      ...pages.map((page) => ({ kind: "page" as const, id: page.id, revisionId: page.revisionId!, label: page.title })),
      ...entries.map((entry) => ({ kind: "entry" as const, id: entry.id, revisionId: entry.revisionId!, label: `${entry.collection}/${entry.entryKey}` })),
    ];
  }

  async function openProposal(companyId: string, siteId: string) {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, WEBSITE_PUBLISH_APPROVAL_TYPE),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ));
    return rows.find((row) => payloadOf(row).siteId === siteId) ?? null;
  }

  async function proposerName(actor: WebsiteActor) {
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
   * Propose a Publish of every approved change. One open proposal per site:
   * a second call returns the open one (refreshed with the current changes).
   */
  async function propose(site: SiteRow, actor: WebsiteActor): Promise<{ approval: ApprovalRow; created: boolean }> {
    const changes = await approvedChanges(site.companyId, site.id);
    if (changes.length === 0) throw unprocessable(WEBSITE_MESSAGES["proposal.publish.nothing"], { code: "website_publish_nothing" });
    const text = publishProposalText(await proposerName(actor), changes.length);
    const payload: WebsitePublishApprovalPayload = {
      siteId: site.id,
      siteName: site.name,
      title: text.title,
      summary: text.summary,
      changeCount: changes.length,
      manifest: {
        pages: changes.filter((c) => c.kind === "page").map((c) => ({ pageId: c.id, revisionId: c.revisionId })),
        entries: changes.filter((c) => c.kind === "entry").map((c) => ({ entryId: c.id, revisionId: c.revisionId })),
      },
      changes,
    };
    const open = await openProposal(site.companyId, site.id);
    if (open) {
      const [refreshed] = await db
        .update(approvals)
        .set({ payload: { ...payloadOf(open), changeCount: payload.changeCount, manifest: payload.manifest, changes, summary: payload.summary }, updatedAt: new Date() })
        .where(eq(approvals.id, open.id))
        .returning();
      return { approval: refreshed ?? open, created: false };
    }
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId: site.companyId,
        type: WEBSITE_PUBLISH_APPROVAL_TYPE,
        requestedByAgentId: actor.agentId,
        requestedByUserId: actor.userId,
        status: "pending",
        payload: payload as unknown as Record<string, unknown>,
      })
      .returning();
    return { approval: approval!, created: true };
  }

  /** Approve, decline or ask for changes: only a person with website:publish for the proposal's site. */
  async function assertCanDecide(actor: Express.Request["actor"], approval: Pick<ApprovalRow, "type" | "companyId" | "payload">) {
    if (approval.type !== WEBSITE_PUBLISH_APPROVAL_TYPE) return;
    if (actor.type !== "board") throw forbidden(WEBSITE_MESSAGES["agent.publish_refused"], { code: "website_publish_agent_refused" });
    const siteId = payloadOf(approval).siteId;
    if (typeof siteId !== "string") throw unprocessable("This Publish proposal names no site");
    const decision = await access.decide({
      actor,
      action: "website:publish",
      resource: { type: "company", companyId: approval.companyId },
      scope: { siteId },
    });
    if (!decision.allowed) throw forbidden(WEBSITE_MESSAGES["proposal.publish.no_rights"], { code: "website_publish_decider_missing" });
  }

  /** Fail before the approval changes when this server cannot start a Publish yet. */
  function assertCanStart(approval: Pick<ApprovalRow, "type">) {
    if (approval.type !== WEBSITE_PUBLISH_APPROVAL_TYPE) return;
    if (!publishStarter) throw new HttpError(503, WEBSITE_MESSAGES["proposal.publish.unavailable"], { code: "website_publish_unavailable" });
  }

  /**
   * After the approval is recorded: start the Publish in the approver's name.
   * If it cannot start (a Publish is running, not enough credits), the
   * approval goes back to pending and the error goes to the approver.
   */
  async function startApprovedPublish(approval: ApprovalRow, publishedByUserId: string): Promise<ApprovalRow> {
    if (approval.type !== WEBSITE_PUBLISH_APPROVAL_TYPE) return approval;
    const payload = payloadOf(approval);
    try {
      if (!publishStarter) throw new HttpError(503, WEBSITE_MESSAGES["proposal.publish.unavailable"], { code: "website_publish_unavailable" });
      const { releaseId } = await publishStarter({
        companyId: approval.companyId,
        siteId: payload.siteId as string,
        approvalId: approval.id,
        publishedByUserId,
        requestedByAgentId: approval.requestedByAgentId,
        requestedByUserId: approval.requestedByUserId,
      });
      const [updated] = await db
        .update(approvals)
        .set({ payload: { ...payload, releaseId }, updatedAt: new Date() })
        .where(eq(approvals.id, approval.id))
        .returning();
      return updated ?? approval;
    } catch (err) {
      await db
        .update(approvals)
        .set({ status: "pending", decidedByUserId: null, decidedAt: null, decisionNote: null, updatedAt: new Date() })
        .where(and(eq(approvals.id, approval.id), eq(approvals.status, "approved")));
      throw err;
    }
  }

  return { approvedChanges, openProposal, propose, assertCanDecide, assertCanStart, startApprovedPublish };
}
