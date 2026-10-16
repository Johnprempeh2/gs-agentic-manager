import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { clientAcceptanceLinks, companies, pipelineCaseEvents, pipelineCases } from "@greatstone/db";
import {
  CLIENT_ACCEPTANCE_LINK_DAYS,
  ndaClears,
  type AcceptClientEngagement,
  type ClientAcceptanceLinkSummary,
  type NdaStatus,
  type PublicClientAcceptance,
} from "@greatstone/shared";
import { conflict, notFound } from "../errors.js";

// Online acceptance of the engagement pack (Ben, 12 Oct; John's yes, 16 Oct).
// The board makes a link for one client; the client opens it without signing
// in, reads the pack and accepts it. The token carries 256 bits and only its
// hash is stored, like an invite, so the link is shown once when it is made.

const TOKEN_PREFIX = "gsa_accept_";
const DAY_MS = 24 * 60 * 60 * 1000;

export function hashAcceptanceToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newAcceptanceToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function acceptancePagePath(token: string) {
  return `/accept/${encodeURIComponent(token)}`;
}

type LinkRow = typeof clientAcceptanceLinks.$inferSelect;

function summarise(row: LinkRow, now: Date): ClientAcceptanceLinkSummary {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expired: !row.acceptedAt && row.expiresAt.getTime() <= now.getTime(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedName: row.acceptedName,
    acceptedRole: row.acceptedRole,
    acceptedEmail: row.acceptedEmail,
  };
}

export function clientAcceptanceService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function loadCase(companyId: string, caseId: string) {
    const row = await db
      .select({
        id: pipelineCases.id,
        title: pipelineCases.title,
        ndaStatus: pipelineCases.ndaStatus,
        engagementStatus: pipelineCases.engagementStatus,
        engagementSentAt: pipelineCases.engagementSentAt,
        packEvidenceId: pipelineCases.engagementPackEvidenceId,
      })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId), isNull(pipelineCases.retiredAt)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Pipeline case not found");
    return row;
  }

  /** The open link for a token, with its client and company, or 404. Revoked and expired links read as not found. */
  async function resolve(token: string) {
    const trimmed = token.trim();
    if (!trimmed.startsWith(TOKEN_PREFIX)) throw notFound("This link is not valid");
    const row = await db
      .select({ link: clientAcceptanceLinks, companyName: companies.name })
      .from(clientAcceptanceLinks)
      .innerJoin(companies, eq(companies.id, clientAcceptanceLinks.companyId))
      .where(eq(clientAcceptanceLinks.tokenHash, hashAcceptanceToken(trimmed)))
      .then((rows) => rows[0] ?? null);
    if (!row || row.link.revokedAt) throw notFound("This link is not valid");
    // An accepted link keeps working so the client can see the confirmation.
    if (!row.link.acceptedAt && row.link.expiresAt.getTime() <= now().getTime()) {
      throw notFound("This link has expired");
    }
    const client = await loadCase(row.link.companyId, row.link.caseId).catch(() => null);
    if (!client) throw notFound("This link is not valid");
    return { link: row.link, companyName: row.companyName, client };
  }

  return {
    /** The newest link that was not revoked, for the board's engagement row. */
    current: async (companyId: string, caseId: string): Promise<ClientAcceptanceLinkSummary | null> => {
      const row = await db
        .select()
        .from(clientAcceptanceLinks)
        .where(and(
          eq(clientAcceptanceLinks.companyId, companyId),
          eq(clientAcceptanceLinks.caseId, caseId),
          isNull(clientAcceptanceLinks.revokedAt),
        ))
        .orderBy(desc(clientAcceptanceLinks.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row ? summarise(row, now()) : null;
    },

    /**
     * Make a new link for the client, revoking any older one. The NDA must be
     * cleared and the pack uploaded, since the page shows the pack.
     */
    create: async (companyId: string, caseId: string, userId: string | null) => {
      const client = await loadCase(companyId, caseId);
      if (!ndaClears(client.ndaStatus as NdaStatus)) {
        throw conflict("The NDA must be accepted or suspended before the engagement pack goes out", { code: "nda_required" });
      }
      if (!client.packEvidenceId) {
        throw conflict("Upload the engagement pack first, so the client has something to read", { code: "pack_required" });
      }
      if (client.engagementStatus === "accepted") {
        throw conflict("The engagement pack is already accepted", { code: "already_accepted" });
      }
      const token = newAcceptanceToken();
      const at = now();
      const created = await db.transaction(async (tx) => {
        await tx
          .update(clientAcceptanceLinks)
          .set({ revokedAt: at })
          .where(and(
            eq(clientAcceptanceLinks.companyId, companyId),
            eq(clientAcceptanceLinks.caseId, caseId),
            isNull(clientAcceptanceLinks.revokedAt),
          ));
        const [row] = await tx
          .insert(clientAcceptanceLinks)
          .values({
            companyId,
            caseId,
            tokenHash: hashAcceptanceToken(token),
            createdByUserId: userId,
            createdAt: at,
            expiresAt: new Date(at.getTime() + CLIENT_ACCEPTANCE_LINK_DAYS * DAY_MS),
          })
          .returning();
        return row!;
      });
      return { token, path: acceptancePagePath(token), link: summarise(created, at) };
    },

    /** Stop the client's link working. True when there was one to revoke. */
    revoke: async (companyId: string, caseId: string) => {
      await loadCase(companyId, caseId);
      const revoked = await db
        .update(clientAcceptanceLinks)
        .set({ revokedAt: now() })
        .where(and(
          eq(clientAcceptanceLinks.companyId, companyId),
          eq(clientAcceptanceLinks.caseId, caseId),
          isNull(clientAcceptanceLinks.revokedAt),
          isNull(clientAcceptanceLinks.acceptedAt),
        ))
        .returning({ id: clientAcceptanceLinks.id });
      return revoked.length > 0;
    },

    /** Withdraw every link for the client, accepted ones included (the engagement starts over). */
    revokeAll: async (companyId: string, caseId: string) => {
      await db
        .update(clientAcceptanceLinks)
        .set({ revokedAt: now() })
        .where(and(
          eq(clientAcceptanceLinks.companyId, companyId),
          eq(clientAcceptanceLinks.caseId, caseId),
          isNull(clientAcceptanceLinks.revokedAt),
        ));
    },

    /** What the public page shows. */
    view: async (token: string): Promise<PublicClientAcceptance> => {
      const { link, companyName, client } = await resolve(token);
      return {
        companyName,
        clientName: client.title,
        packTitle: "Engagement pack",
        packPath: `/api/client-acceptance/${encodeURIComponent(token.trim())}/pack`,
        status: link.acceptedAt ? "accepted" : "open",
        expiresAt: link.expiresAt.toISOString(),
        acceptedAt: link.acceptedAt?.toISOString() ?? null,
        acceptedName: link.acceptedName,
      };
    },

    /** The pack file behind a link: the evidence id and the company that owns it. */
    pack: async (token: string) => {
      const { link, client } = await resolve(token);
      if (!client.packEvidenceId) throw notFound("The engagement pack is not available");
      return { companyId: link.companyId, caseId: link.caseId, evidenceId: client.packEvidenceId };
    },

    /**
     * The client accepts. The link records who, and the client's engagement
     * moves to accepted with today's date, as an upload of the signed
     * acceptance would. A second accept on the same link is refused.
     */
    accept: async (
      token: string,
      input: AcceptClientEngagement,
      meta: { ip: string | null; userAgent: string | null },
    ) => {
      const { link } = await resolve(token);
      if (link.acceptedAt) throw conflict("This engagement pack is already accepted", { code: "already_accepted" });
      const at = now();
      const accepted = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(clientAcceptanceLinks)
          .set({
            acceptedAt: at,
            acceptedName: input.name.trim(),
            acceptedRole: input.role?.trim() || null,
            acceptedEmail: input.email.trim(),
            acceptedIp: meta.ip?.slice(0, 100) ?? null,
            acceptedUserAgent: meta.userAgent?.slice(0, 500) ?? null,
          })
          .where(and(
            eq(clientAcceptanceLinks.id, link.id),
            isNull(clientAcceptanceLinks.acceptedAt),
            isNull(clientAcceptanceLinks.revokedAt),
          ))
          .returning();
        if (!row) return null;
        const client = await tx
          .select({ sentAt: pipelineCases.engagementSentAt })
          .from(pipelineCases)
          .where(eq(pipelineCases.id, link.caseId))
          .then((rows) => rows[0] ?? null);
        await tx
          .update(pipelineCases)
          .set({
            engagementStatus: "accepted",
            engagementSentAt: client?.sentAt ?? at,
            engagementAcceptedAt: at,
            engagementChangedAt: at,
            engagementChangedByUserId: null,
            updatedAt: at,
          })
          .where(and(eq(pipelineCases.companyId, link.companyId), eq(pipelineCases.id, link.caseId)));
        await tx.insert(pipelineCaseEvents).values({
          companyId: link.companyId,
          caseId: link.caseId,
          type: "updated",
          actorType: "system",
          payload: {
            action: "engagement_accepted_online",
            linkId: link.id,
            acceptedName: row.acceptedName,
            acceptedEmail: row.acceptedEmail,
          },
        });
        return row;
      });
      if (!accepted) throw conflict("This engagement pack is already accepted", { code: "already_accepted" });
      return { companyId: link.companyId, caseId: link.caseId, link: summarise(accepted, at) };
    },
  };
}
