import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { documentEvidenceLinks } from "@greatstone/db";
import {
  buildDocumentEvidenceExport,
  checkDocumentEvidence,
  extractEvidenceBullets,
  type DocumentEvidenceExport,
  type DocumentEvidenceLink,
  type DocumentEvidenceView,
  type UpsertDocumentEvidence,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";

export interface DocumentEvidenceActor {
  agentId: string | null;
  userId: string | null;
}

type IssueRef = { id: string; companyId: string };

/**
 * Evidence trail on issue documents (GRE-1146). Links are stored per bullet ID;
 * the bullets themselves are read from the document's latest revision each
 * time, so an edited document is checked as it is now.
 */
export function documentEvidenceService(db: Db) {
  const documentsSvc = documentService(db);

  async function loadDocument(issue: IssueRef, key: string) {
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, key);
    if (!doc) throw notFound("Document not found");
    return doc;
  }

  async function listLinks(issue: IssueRef, documentId: string): Promise<DocumentEvidenceLink[]> {
    const rows = await db
      .select()
      .from(documentEvidenceLinks)
      .where(and(eq(documentEvidenceLinks.companyId, issue.companyId), eq(documentEvidenceLinks.documentId, documentId)))
      .orderBy(asc(documentEvidenceLinks.bulletId));
    return rows as DocumentEvidenceLink[];
  }

  async function getView(issue: IssueRef, key: string, now = new Date()): Promise<DocumentEvidenceView> {
    const doc = await loadDocument(issue, key);
    const bullets = extractEvidenceBullets(doc.body ?? "");
    const links = await listLinks(issue, doc.id);
    const linksByBullet = new Map(links.map((link) => [link.bulletId, link]));
    const bulletIds = new Set(bullets.map((bullet) => bullet.bulletId));
    return {
      issueId: issue.id,
      documentKey: doc.key,
      documentId: doc.id,
      revisionNumber: doc.latestRevisionNumber,
      bullets: bullets.map((bullet) => ({ ...bullet, link: linksByBullet.get(bullet.bulletId) ?? null })),
      orphanedLinks: links.filter((link) => !bulletIds.has(link.bulletId)),
      check: checkDocumentEvidence({ bullets, links, now }),
    };
  }

  return {
    getView,

    /** Sets the links for the given bullets; other bullets keep theirs. Every bullet ID must be in the document. */
    upsert: async (
      issue: IssueRef,
      key: string,
      input: UpsertDocumentEvidence,
      actor: DocumentEvidenceActor,
    ): Promise<DocumentEvidenceView> => {
      const doc = await loadDocument(issue, key);
      const present = new Set(extractEvidenceBullets(doc.body ?? "").map((bullet) => bullet.bulletId));
      const unknown = input.bullets.map((bullet) => bullet.bulletId).filter((id) => !present.has(id));
      if (unknown.length > 0) {
        throw unprocessable(
          `Bullet ${unknown.join(", ")} is not in the document. Start the bullet with its bold ID, e.g. "- **S1** ...".`,
          { unknownBulletIds: unknown },
        );
      }
      await db.transaction(async (tx) => {
        for (const bullet of input.bullets) {
          await tx
            .insert(documentEvidenceLinks)
            .values({
              companyId: issue.companyId,
              issueId: issue.id,
              documentId: doc.id,
              documentKey: doc.key,
              bulletId: bullet.bulletId,
              sources: bullet.sources,
              inference: bullet.inference ?? false,
              judgement: bullet.judgement ?? false,
              createdByAgentId: actor.agentId,
              createdByUserId: actor.userId,
              updatedByAgentId: actor.agentId,
              updatedByUserId: actor.userId,
            })
            .onConflictDoUpdate({
              target: [documentEvidenceLinks.documentId, documentEvidenceLinks.bulletId],
              set: {
                sources: bullet.sources,
                ...(bullet.inference === undefined ? {} : { inference: bullet.inference }),
                ...(bullet.judgement === undefined ? {} : { judgement: bullet.judgement }),
                updatedByAgentId: actor.agentId,
                updatedByUserId: actor.userId,
                updatedAt: sql`now()`,
              },
            });
        }
      });
      return getView(issue, key);
    },

    /** Removes one bullet's links, including an orphaned one. Returns false when there was nothing to remove. */
    remove: async (issue: IssueRef, key: string, bulletId: string): Promise<boolean> => {
      const doc = await loadDocument(issue, key);
      const deleted = await db
        .delete(documentEvidenceLinks)
        .where(
          and(
            eq(documentEvidenceLinks.companyId, issue.companyId),
            eq(documentEvidenceLinks.documentId, doc.id),
            eq(documentEvidenceLinks.bulletId, bulletId),
          ),
        )
        .returning({ id: documentEvidenceLinks.id });
      return deleted.length > 0;
    },

    exportForDeck: async (issue: IssueRef, key: string, now = new Date()): Promise<DocumentEvidenceExport> => {
      const doc = await loadDocument(issue, key);
      return buildDocumentEvidenceExport({
        issueId: issue.id,
        documentKey: doc.key,
        revisionNumber: doc.latestRevisionNumber,
        bullets: extractEvidenceBullets(doc.body ?? ""),
        links: await listLinks(issue, doc.id),
        now,
      });
    },
  };
}
