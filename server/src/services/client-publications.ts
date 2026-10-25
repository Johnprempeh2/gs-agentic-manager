import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  assets,
  authUsers,
  clientDeliverableApprovers,
  clientDeliverablePublicationEvents,
  clientDeliverablePublications,
  companies,
  companyMemberships,
  issueAttachments,
  issueWorkProducts,
  pipelineCaseEvents,
  pipelineCases,
  pipelineCaseStageDeliverables,
  pipelineStages,
} from "@greatstone/db";
import {
  CLIENT_PUBLICATION_GATE_MESSAGES,
  CLIENT_PUBLICATION_LINK_DAYS,
  buildEngagementTimeline,
  canMoveClientPublication,
  clientPublicationGates,
  clientSafeEngagementTimeline,
  deliverableFingerprintSource,
  type AcceptClientDeliverable,
  type ClientDeliverableApprover,
  type ClientPublication,
  type ClientPublicationAction,
  type ClientPublicationMove,
  type ClientPublicationsResponse,
  type ClientPublicationStatus,
  type EngagementStatus,
  type EngagementTimeline,
  type NdaStatus,
  type PublicClientDeliverable,
} from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { clientReceiptSender, type ClientReceiptSender } from "./client-receipts.js";

// Deliverable publishing on Clients > Deliverables (GRE-2373). The routes
// decide who may call each step; this service holds the order of the steps,
// the frozen fingerprint and the audit. The database checks the same rules
// again (migration 0402), so a bug here cannot publish unapproved content.

export type ClientPublicationActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId: string | null }
  | { type: "client" }
  | { type: "system" };

const TOKEN_PREFIX = "gsa_deliver_";
const DAY_MS = 24 * 60 * 60 * 1000;
const versionOrder = sql`((${issueWorkProducts.metadata}->>'version')::integer)`;

type PublicationRow = typeof clientDeliverablePublications.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function hashPublicationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function publicationPagePath(token: string) {
  return `/deliverable/${encodeURIComponent(token)}`;
}

function metadataOf(row: { metadata: unknown }) {
  return (row.metadata as Record<string, unknown> | null) ?? {};
}

function versionOf(row: { metadata: unknown }) {
  const value = metadataOf(row).version;
  return typeof value === "number" ? value : null;
}

function actorColumns(actor: ClientPublicationActor) {
  if (actor.type === "user") return { actorType: "user", actorUserId: actor.userId };
  if (actor.type === "agent") return { actorType: "agent", actorAgentId: actor.agentId, runId: actor.runId };
  return { actorType: actor.type };
}

function gateError(codes: ReturnType<typeof clientPublicationGates>) {
  return conflict(CLIENT_PUBLICATION_GATE_MESSAGES[codes[0]!], { code: codes[0], gates: codes });
}

export function clientPublicationService(
  db: Db,
  deps: { now?: () => Date; receipts?: ClientReceiptSender } = {},
) {
  const now = deps.now ?? (() => new Date());
  const receipts = deps.receipts ?? clientReceiptSender(db);

  async function record(
    tx: Tx | Db,
    row: Pick<PublicationRow, "id" | "companyId" | "caseId">,
    action: ClientPublicationAction,
    actor: ClientPublicationActor,
    input: { fingerprint?: string | null; detail?: Record<string, unknown> } = {},
  ) {
    await tx.insert(clientDeliverablePublicationEvents).values({
      companyId: row.companyId,
      caseId: row.caseId,
      publicationId: row.id,
      action,
      ...actorColumns(actor),
      fingerprint: input.fingerprint ?? null,
      detail: input.detail ?? {},
    });
  }

  async function loadCase(companyId: string, caseId: string) {
    const row = await db
      .select({
        id: pipelineCases.id,
        title: pipelineCases.title,
        pipelineId: pipelineCases.pipelineId,
        stageId: pipelineCases.stageId,
        ndaStatus: pipelineCases.ndaStatus,
        ndaAcceptedAt: pipelineCases.ndaAcceptedAt,
        ndaStatusChangedAt: pipelineCases.ndaStatusChangedAt,
        engagementStatus: pipelineCases.engagementStatus,
        engagementSentAt: pipelineCases.engagementSentAt,
        engagementAcceptedAt: pipelineCases.engagementAcceptedAt,
      })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId), isNull(pipelineCases.retiredAt)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Pipeline case not found");
    return row;
  }

  function gatesOf(client: { ndaStatus: string; engagementStatus: string }) {
    return clientPublicationGates({
      ndaStatus: client.ndaStatus as NdaStatus,
      engagementStatus: client.engagementStatus as EngagementStatus,
    });
  }

  async function loadPublication(id: string) {
    const row = await db
      .select()
      .from(clientDeliverablePublications)
      .where(eq(clientDeliverablePublications.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Publication not found");
    return row;
  }

  function assertMove(row: PublicationRow, move: ClientPublicationMove) {
    if (!canMoveClientPublication(row.status as ClientPublicationStatus, move)) {
      throw conflict(`A ${row.status.replace("_", " ")} deliverable cannot be moved this way`, {
        code: "publication_status",
        status: row.status,
      });
    }
  }

  /** Move a row on only if nobody moved it first; the audit row goes in the same transaction. */
  async function move(
    row: PublicationRow,
    patch: Partial<typeof clientDeliverablePublications.$inferInsert>,
    action: ClientPublicationAction,
    actor: ClientPublicationActor,
    audit: { fingerprint?: string | null; detail?: Record<string, unknown> } = {},
  ) {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(clientDeliverablePublications)
        .set({ ...patch, updatedAt: now() })
        .where(and(
          eq(clientDeliverablePublications.id, row.id),
          eq(clientDeliverablePublications.status, row.status),
        ))
        .returning();
      if (!updated) throw conflict("This deliverable changed meanwhile; reload and try again", { code: "publication_changed" });
      await record(tx, updated, action, actor, audit);
      return updated;
    });
  }

  /** The newest version of a deliverable (task and key), or null when none is left. */
  async function newestVersion(companyId: string, issueId: string, key: string) {
    return db
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "deliverable"),
        eq(issueWorkProducts.externalId, key),
      ))
      .orderBy(sql`${versionOrder} desc nulls last`, desc(issueWorkProducts.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** sha256 of a version's content: the stored file's bytes and type, or a link's address. */
  async function fingerprintOf(companyId: string, workProductId: string | null) {
    if (!workProductId) return null;
    const product = await db
      .select()
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, workProductId)))
      .then((rows) => rows[0] ?? null);
    if (!product) return null;
    const metadata = metadataOf(product);
    const external = metadata.external === true;
    let file: { sha256: string; contentType: string } | null = null;
    if (!external && typeof metadata.attachmentId === "string") {
      file = await db
        .select({ sha256: assets.sha256, contentType: assets.contentType })
        .from(issueAttachments)
        .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)))
        .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.id, metadata.attachmentId)))
        .then((rows) => rows[0] ?? null);
    }
    const source = deliverableFingerprintSource({
      external,
      url: product.url ?? null,
      sha256: file?.sha256 ?? null,
      contentType: file?.contentType ?? null,
    });
    return source ? createHash("sha256").update(source).digest("hex") : null;
  }

  async function activeApprover(companyId: string, caseId: string, userId: string) {
    return db
      .select({ id: clientDeliverableApprovers.id })
      .from(clientDeliverableApprovers)
      .where(and(
        eq(clientDeliverableApprovers.companyId, companyId),
        eq(clientDeliverableApprovers.caseId, caseId),
        eq(clientDeliverableApprovers.userId, userId),
        isNull(clientDeliverableApprovers.removedAt),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function namesOf(userIds: string[], agentIds: string[]) {
    const users = userIds.length
      ? await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, userIds))
      : [];
    const agentRows = agentIds.length
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    return {
      user: new Map(users.map((user) => [user.id, user])),
      agent: new Map(agentRows.map((agent) => [agent.id, agent.name])),
    };
  }

  /** Resolve a client's link: open or accepted, never revoked or (unless accepted) expired. */
  async function resolveToken(token: string) {
    const trimmed = token.trim();
    if (!trimmed.startsWith(TOKEN_PREFIX)) throw notFound("This link is not valid");
    const row = await db
      .select({ publication: clientDeliverablePublications, companyName: companies.name, clientName: pipelineCases.title })
      .from(clientDeliverablePublications)
      .innerJoin(companies, eq(companies.id, clientDeliverablePublications.companyId))
      .innerJoin(pipelineCases, and(
        eq(pipelineCases.id, clientDeliverablePublications.caseId),
        eq(pipelineCases.companyId, clientDeliverablePublications.companyId),
        isNull(pipelineCases.retiredAt),
      ))
      .where(eq(clientDeliverablePublications.acceptanceTokenHash, hashPublicationToken(trimmed)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("This link is not valid");
    const { publication } = row;
    if (publication.status !== "published" && publication.status !== "accepted") throw notFound("This link is not valid");
    if (publication.status === "published" && (publication.acceptanceLinkExpiresAt?.getTime() ?? 0) <= now().getTime()) {
      throw notFound("This link has expired");
    }
    return { ...row, token: trimmed };
  }

  async function sendReceipt(row: PublicationRow, companyName: string, clientName: string) {
    const outcome = await receipts.send(row.companyId, {
      to: row.acceptedEmail!,
      recipientName: row.acceptedName ?? row.acceptedEmail!,
      companyName,
      clientName,
      deliverableTitle: row.title,
      version: row.version,
      fingerprint: row.publishedFingerprint ?? row.fingerprint ?? "",
      acceptedAt: row.acceptedAt ?? now(),
      idempotencyKey: `client-receipt-${row.id}`,
    });
    const at = now();
    await db.transaction(async (tx) => {
      await tx
        .update(clientDeliverablePublications)
        .set({
          receiptStatus: outcome.status,
          receiptSentAt: outcome.status === "sent" ? at : null,
          receiptMessageId: outcome.status === "sent" ? outcome.messageId : null,
          receiptError: outcome.status === "sent" ? null : outcome.error,
          updatedAt: at,
        })
        .where(eq(clientDeliverablePublications.id, row.id));
      await record(
        tx,
        row,
        outcome.status === "sent" ? "receipt_sent" : outcome.status === "failed" ? "receipt_failed" : "receipt_not_configured",
        { type: "system" },
        { detail: outcome.status === "sent" ? { to: row.acceptedEmail, messageId: outcome.messageId } : { to: row.acceptedEmail, error: outcome.error } },
      );
    });
    return outcome;
  }

  return {
    /** The company and client a publication belongs to, for the route's access check. */
    scopeOf: async (id: string) => {
      const row = await loadPublication(id);
      return { companyId: row.companyId, caseId: row.caseId };
    },

    list: async (companyId: string, caseId: string): Promise<ClientPublicationsResponse> => {
      const client = await loadCase(companyId, caseId);
      const [approverRows, rows] = await Promise.all([
        db
          .select()
          .from(clientDeliverableApprovers)
          .where(and(
            eq(clientDeliverableApprovers.companyId, companyId),
            eq(clientDeliverableApprovers.caseId, caseId),
            isNull(clientDeliverableApprovers.removedAt),
          ))
          .orderBy(asc(clientDeliverableApprovers.createdAt)),
        db
          .select()
          .from(clientDeliverablePublications)
          .where(and(eq(clientDeliverablePublications.companyId, companyId), eq(clientDeliverablePublications.caseId, caseId)))
          .orderBy(desc(clientDeliverablePublications.createdAt)),
      ]);
      const events = rows.length
        ? await db
          .select()
          .from(clientDeliverablePublicationEvents)
          .where(and(
            eq(clientDeliverablePublicationEvents.companyId, companyId),
            inArray(clientDeliverablePublicationEvents.publicationId, rows.map((row) => row.id)),
          ))
          .orderBy(asc(clientDeliverablePublicationEvents.createdAt))
        : [];
      const userIds = new Set<string>(approverRows.map((row) => row.userId));
      const agentIds = new Set<string>();
      for (const row of rows) {
        if (row.approverUserId) userIds.add(row.approverUserId);
        if (row.approvedByUserId) userIds.add(row.approvedByUserId);
      }
      for (const event of events) {
        if (event.actorUserId) userIds.add(event.actorUserId);
        if (event.actorAgentId) agentIds.add(event.actorAgentId);
      }
      const names = await namesOf([...userIds], [...agentIds]);
      const products = new Map<string, typeof issueWorkProducts.$inferSelect | null>();
      const latest = new Map<string, number | null>();
      for (const row of rows) {
        const newest = await newestVersion(companyId, row.deliverableIssueId, row.deliverableKey);
        latest.set(row.id, newest ? versionOf(newest) : null);
        const pinnedId = row.workProductId ?? (row.status === "draft" ? newest?.id ?? null : null);
        products.set(row.id, pinnedId === newest?.id ? newest : pinnedId
          ? await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, pinnedId))).then((r) => r[0] ?? null)
          : null);
      }
      const at = now().getTime();
      const publications = rows.map((row): ClientPublication => {
        const product = products.get(row.id) ?? null;
        const metadata = product ? metadataOf(product) : {};
        const external = metadata.external === true;
        return {
          id: row.id,
          caseId: row.caseId,
          stageLinkId: row.stageLinkId,
          deliverableIssueId: row.deliverableIssueId,
          deliverableKey: row.deliverableKey,
          title: row.title,
          status: row.status as ClientPublicationStatus,
          workProductId: product?.id ?? null,
          version: row.version ?? (product ? versionOf(product) : null),
          latestVersion: latest.get(row.id) ?? null,
          fingerprint: row.fingerprint,
          approverUserId: row.approverUserId,
          approverName: row.approverUserId ? names.user.get(row.approverUserId)?.name ?? null : null,
          submittedAt: row.submittedAt?.toISOString() ?? null,
          approvedAt: row.approvedAt?.toISOString() ?? null,
          approvedByName: row.approvedByUserId ? names.user.get(row.approvedByUserId)?.name ?? null : null,
          rejectedReason: row.rejectedReason,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          acceptanceLink: row.acceptanceLinkCreatedAt && row.acceptanceLinkExpiresAt
            ? {
              createdAt: row.acceptanceLinkCreatedAt.toISOString(),
              expiresAt: row.acceptanceLinkExpiresAt.toISOString(),
              expired: !row.acceptedAt && row.acceptanceLinkExpiresAt.getTime() <= at,
            }
            : null,
          acceptedAt: row.acceptedAt?.toISOString() ?? null,
          acceptedName: row.acceptedName,
          acceptedRole: row.acceptedRole,
          acceptedEmail: row.acceptedEmail,
          receipt: { status: row.receiptStatus, sentAt: row.receiptSentAt?.toISOString() ?? null, error: row.receiptError },
          withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
          withdrawnReason: row.withdrawnReason,
          contentPath: product && !external && typeof metadata.attachmentId === "string"
            ? `/api/attachments/${metadata.attachmentId}/content`
            : null,
          url: product && external ? product.url ?? null : null,
          events: events
            .filter((event) => event.publicationId === row.id)
            .map((event) => ({
              id: event.id,
              action: event.action as ClientPublicationAction,
              actorType: event.actorType as ClientPublication["events"][number]["actorType"],
              actorName: event.actorUserId
                ? names.user.get(event.actorUserId)?.name ?? null
                : event.actorAgentId
                  ? names.agent.get(event.actorAgentId) ?? null
                  : null,
              fingerprint: event.fingerprint,
              detail: event.detail,
              createdAt: event.createdAt.toISOString(),
            })),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      });
      const approvers = approverRows.map((row): ClientDeliverableApprover => ({
        id: row.id,
        userId: row.userId,
        name: names.user.get(row.userId)?.name ?? null,
        email: names.user.get(row.userId)?.email ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
      return {
        caseId,
        approvers,
        publications,
        gates: gatesOf(client),
        receiptSenderConfigured: await receipts.configured(companyId),
      };
    },

    /**
     * Register a person as an approver for this client. They must be an active
     * member of the company, or the person registering (who already has access).
     */
    registerApprover: async (companyId: string, caseId: string, userId: string, byUserId: string) => {
      await loadCase(companyId, caseId);
      if (userId !== byUserId) {
        const member = await db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ))
          .then((rows) => rows[0] ?? null);
        if (!member) throw unprocessable("An approver must be an active member of this company", { code: "approver_not_member" });
      }
      try {
        const [row] = await db
          .insert(clientDeliverableApprovers)
          .values({ companyId, caseId, userId, createdByUserId: byUserId })
          .returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("This person is already an approver for this client", { code: "duplicate_approver" });
        throw error;
      }
    },

    removeApprover: async (companyId: string, caseId: string, approverId: string, byUserId: string) => {
      const [row] = await db
        .update(clientDeliverableApprovers)
        .set({ removedAt: now(), removedByUserId: byUserId })
        .where(and(
          eq(clientDeliverableApprovers.companyId, companyId),
          eq(clientDeliverableApprovers.caseId, caseId),
          eq(clientDeliverableApprovers.id, approverId),
          isNull(clientDeliverableApprovers.removedAt),
        ))
        .returning();
      if (!row) throw notFound("Approver not found");
      return row;
    },

    /** Start a draft from a deliverable filed under one of this client's stages. */
    create: async (companyId: string, caseId: string, stageLinkId: string, actor: ClientPublicationActor) => {
      await loadCase(companyId, caseId);
      const link = await db
        .select()
        .from(pipelineCaseStageDeliverables)
        .where(and(
          eq(pipelineCaseStageDeliverables.companyId, companyId),
          eq(pipelineCaseStageDeliverables.caseId, caseId),
          eq(pipelineCaseStageDeliverables.id, stageLinkId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!link) throw notFound("Stage deliverable not found");
      const newest = await newestVersion(companyId, link.deliverableIssueId, link.deliverableKey);
      if (!newest) throw unprocessable("This deliverable has no version to publish", { code: "deliverable_missing" });
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(clientDeliverablePublications)
            .values({
              companyId,
              caseId,
              stageLinkId: link.id,
              deliverableIssueId: link.deliverableIssueId,
              deliverableKey: link.deliverableKey,
              title: newest.title,
              createdByUserId: actor.type === "user" ? actor.userId : null,
              createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            })
            .returning();
          await record(tx, row!, "created", actor, { detail: { stageLinkId: link.id, version: versionOf(newest) } });
          return row!;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This deliverable already has a publication for this client", { code: "duplicate_publication" });
        }
        throw error;
      }
    },

    /** Freeze the newest version and its fingerprint, and ask one registered approver. */
    submit: async (id: string, approverUserId: string, actor: ClientPublicationActor) => {
      const row = await loadPublication(id);
      assertMove(row, "submit");
      if (!(await activeApprover(row.companyId, row.caseId, approverUserId))) {
        throw unprocessable("Choose a registered approver for this client", { code: "approver_not_registered" });
      }
      const newest = await newestVersion(row.companyId, row.deliverableIssueId, row.deliverableKey);
      const fingerprint = await fingerprintOf(row.companyId, newest?.id ?? null);
      if (!newest || !fingerprint) {
        throw unprocessable("This deliverable has no content to approve", { code: "deliverable_missing" });
      }
      return move(row, {
        status: "pending_approval",
        workProductId: newest.id,
        version: versionOf(newest),
        title: newest.title,
        fingerprint,
        approverUserId,
        submittedAt: now(),
        submittedByUserId: actor.type === "user" ? actor.userId : null,
        submittedByAgentId: actor.type === "agent" ? actor.agentId : null,
        rejectedReason: null,
      }, "submitted", actor, { fingerprint, detail: { approverUserId, version: versionOf(newest) } });
    },

    /** Only the named approver approves, and only content that still has the frozen fingerprint. */
    approve: async (id: string, userId: string) => {
      const row = await loadPublication(id);
      assertMove(row, "approve");
      if (row.approverUserId !== userId) throw forbidden("Only the approver named for this deliverable can approve it");
      if (!(await activeApprover(row.companyId, row.caseId, userId))) {
        throw forbidden("You are no longer a registered approver for this client");
      }
      const current = await fingerprintOf(row.companyId, row.workProductId);
      if (!current || current !== row.fingerprint) {
        throw conflict("The content changed after it was sent for approval; send it again", { code: "fingerprint_mismatch" });
      }
      return move(row, {
        status: "approved",
        approvedAt: now(),
        approvedByUserId: userId,
        approvedFingerprint: current,
      }, "approved", { type: "user", userId }, { fingerprint: current });
    },

    /** The approver sends it back to draft with a reason; the frozen version is let go. */
    reject: async (id: string, userId: string, reason: string) => {
      const row = await loadPublication(id);
      assertMove(row, "reject");
      if (row.approverUserId !== userId) throw forbidden("Only the approver named for this deliverable can send it back");
      return move(row, {
        status: "draft",
        workProductId: null,
        version: null,
        fingerprint: null,
        approverUserId: null,
        approvedAt: null,
        approvedByUserId: null,
        approvedFingerprint: null,
        rejectedReason: reason,
      }, "rejected", { type: "user", userId }, { fingerprint: row.fingerprint, detail: { reason } });
    },

    /** Publish exactly what was approved, once the NDA and the engagement allow it. */
    publish: async (id: string, userId: string) => {
      const row = await loadPublication(id);
      assertMove(row, "publish");
      const gates = gatesOf(await loadCase(row.companyId, row.caseId));
      if (gates.length) throw gateError(gates);
      const current = await fingerprintOf(row.companyId, row.workProductId);
      if (!current || current !== row.approvedFingerprint) {
        throw conflict("The content is not what was approved; send it for approval again", { code: "fingerprint_mismatch" });
      }
      return move(row, {
        status: "published",
        publishedAt: now(),
        publishedByUserId: userId,
        publishedFingerprint: current,
      }, "published", { type: "user", userId }, { fingerprint: current });
    },

    /** A link for the client to read and accept it. Shown once; a new link replaces the old. */
    createLink: async (id: string, userId: string) => {
      const row = await loadPublication(id);
      assertMove(row, "share");
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const at = now();
      const expiresAt = new Date(at.getTime() + CLIENT_PUBLICATION_LINK_DAYS * DAY_MS);
      await move(row, {
        acceptanceTokenHash: hashPublicationToken(token),
        acceptanceLinkCreatedAt: at,
        acceptanceLinkExpiresAt: expiresAt,
      }, "acceptance_link_created", { type: "user", userId }, { detail: { expiresAt: expiresAt.toISOString() } });
      return { token, path: publicationPagePath(token), expiresAt: expiresAt.toISOString() };
    },

    withdraw: async (id: string, userId: string, reason: string) => {
      const row = await loadPublication(id);
      assertMove(row, "withdraw");
      return move(row, {
        status: "withdrawn",
        withdrawnAt: now(),
        withdrawnReason: reason,
        acceptanceTokenHash: null,
      }, "withdrawn", { type: "user", userId }, { fingerprint: row.fingerprint, detail: { reason } });
    },

    /** Send the receipt again after it failed or before a sending key was set. */
    resendReceipt: async (id: string) => {
      const row = await loadPublication(id);
      if (row.status !== "accepted") throw conflict("Only an accepted deliverable has a receipt", { code: "publication_status" });
      if (row.receiptStatus === "sent") throw conflict("The receipt was already sent", { code: "receipt_sent" });
      const names = await db
        .select({ companyName: companies.name, clientName: pipelineCases.title })
        .from(pipelineCases)
        .innerJoin(companies, eq(companies.id, pipelineCases.companyId))
        .where(eq(pipelineCases.id, row.caseId))
        .then((rows) => rows[0]!);
      return sendReceipt(row, names.companyName, names.clientName);
    },

    // ---------- the client's side (no sign-in; the token is the only key) ----------

    view: async (token: string): Promise<PublicClientDeliverable> => {
      const { publication, companyName, clientName, token: trimmed } = await resolveToken(token);
      const product = publication.workProductId
        ? await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, publication.workProductId)).then((r) => r[0] ?? null)
        : null;
      const external = product ? metadataOf(product).external === true : false;
      return {
        companyName,
        clientName,
        title: publication.title,
        version: publication.version,
        contentPath: external ? null : `/api/client-deliverable/${encodeURIComponent(trimmed)}/content`,
        url: external ? product?.url ?? null : null,
        status: publication.status === "accepted" ? "accepted" : "open",
        expiresAt: publication.acceptanceLinkExpiresAt!.toISOString(),
        acceptedAt: publication.acceptedAt?.toISOString() ?? null,
        acceptedName: publication.acceptedName,
      };
    },

    /** The frozen file behind a link, and the company that owns it. Its fingerprint must still be the published one. */
    content: async (token: string) => {
      const { publication } = await resolveToken(token);
      const product = publication.workProductId
        ? await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, publication.workProductId)).then((r) => r[0] ?? null)
        : null;
      const attachmentId = product ? metadataOf(product).attachmentId : null;
      if (typeof attachmentId !== "string") throw notFound("This deliverable is not available");
      if ((await fingerprintOf(publication.companyId, publication.workProductId)) !== publication.publishedFingerprint) {
        throw notFound("This deliverable is not available");
      }
      return { companyId: publication.companyId, attachmentId };
    },

    accept: async (token: string, input: AcceptClientDeliverable, meta: { ip: string | null; userAgent: string | null }) => {
      const { publication, companyName, clientName } = await resolveToken(token);
      if (publication.status === "accepted") throw conflict("This deliverable is already accepted", { code: "already_accepted" });
      const at = now();
      const accepted = await move(publication, {
        status: "accepted",
        acceptedAt: at,
        acceptedName: input.name.trim(),
        acceptedRole: input.role?.trim() || null,
        acceptedEmail: input.email.trim(),
        acceptedIp: meta.ip?.slice(0, 100) ?? null,
        acceptedUserAgent: meta.userAgent?.slice(0, 500) ?? null,
      }, "accepted", { type: "client" }, {
        fingerprint: publication.publishedFingerprint,
        detail: { name: input.name.trim(), role: input.role?.trim() || null, email: input.email.trim() },
      }).catch((error) => {
        if (error?.details?.code === "publication_changed") throw conflict("This deliverable is already accepted", { code: "already_accepted" });
        throw error;
      });
      await sendReceipt(accepted, companyName, clientName);
      return accepted;
    },

    // ---------- the engagement timeline (screen 13) ----------

    timeline: async (companyId: string, caseId: string, options: { clientSafe?: boolean } = {}): Promise<EngagementTimeline> => {
      const client = await loadCase(companyId, caseId);
      const [stages, moves, publications] = await Promise.all([
        db
          .select({ id: pipelineStages.id, name: pipelineStages.name, kind: pipelineStages.kind })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, client.pipelineId)),
        db
          .select({ toStageId: pipelineCaseEvents.toStageId, at: pipelineCaseEvents.createdAt, type: pipelineCaseEvents.type })
          .from(pipelineCaseEvents)
          .where(and(
            eq(pipelineCaseEvents.companyId, companyId),
            eq(pipelineCaseEvents.caseId, caseId),
            inArray(pipelineCaseEvents.type, ["ingested", "transitioned", "transition_forced"]),
          )),
        db
          .select({
            id: clientDeliverablePublications.id,
            title: clientDeliverablePublications.title,
            status: clientDeliverablePublications.status,
            publishedAt: clientDeliverablePublications.publishedAt,
            acceptedAt: clientDeliverablePublications.acceptedAt,
          })
          .from(clientDeliverablePublications)
          .where(and(eq(clientDeliverablePublications.companyId, companyId), eq(clientDeliverablePublications.caseId, caseId))),
      ]);
      const timeline = buildEngagementTimeline({
        caseId,
        currentStageId: client.stageId,
        moves: moves
          .filter((row): row is typeof row & { toStageId: string } => Boolean(row.toStageId))
          .map((row) => ({ toStageId: row.toStageId, at: row.at, forced: row.type === "transition_forced" })),
        stages,
        nda: { status: client.ndaStatus as NdaStatus, acceptedAt: client.ndaAcceptedAt, changedAt: client.ndaStatusChangedAt },
        engagement: {
          status: client.engagementStatus as EngagementStatus,
          sentAt: client.engagementSentAt,
          acceptedAt: client.engagementAcceptedAt,
        },
        publications: publications.map((row) => ({ ...row, status: row.status as ClientPublicationStatus })),
      });
      return options.clientSafe ? clientSafeEngagementTimeline(timeline) : timeline;
    },
  };
}
