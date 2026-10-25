import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, authUsers, cases, deepDiveItemFiles, pipelineCaseDocumentRequests, pipelineCaseEvidence } from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_RECORD_KEY,
  type DeepDiveFilesResponse,
  type DeepDiveItemFileLink,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { pipelineCaseDocumentRequestsService } from "./pipeline-case-document-requests.js";
import { pipelineCaseFilesService } from "./pipeline-case-files.js";

// Deep Dive evidence and files (GRE-2395). One client file, many Deep Dive
// items: a link row points an item at its client's evidence row or document
// request. Unlinking removes only that row; the file stays with the client.
// The deep_dive_item_files_guard_writes trigger (migration 0395) keeps every
// target on the item's own client. Client-facing code reads links only through
// listSharedDeepDiveFilesForClient in deep-dive-sharing.ts.

const DEEP_DIVE_TYPES = Object.values(DEEP_DIVE_CASE_TYPES);

export type DeepDiveFileActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string | null };

type ItemRow = Pick<typeof cases.$inferSelect, "id" | "companyId" | "caseType" | "clientCaseId">;

function linkResponse(row: {
  link: typeof deepDiveItemFiles.$inferSelect;
  agentName: string | null;
  userName: string | null;
}): DeepDiveItemFileLink {
  const { link } = row;
  return {
    id: link.id,
    caseId: link.caseId,
    evidenceId: link.evidenceId,
    documentRequestId: link.documentRequestId,
    visibility: link.visibility,
    linkedBy: link.linkedByAgentId
      ? { type: "agent", id: link.linkedByAgentId, name: row.agentName }
      : link.linkedByUserId
        ? { type: "user", id: link.linkedByUserId, name: row.userName }
        : null,
    linkedAt: link.createdAt.toISOString(),
  };
}

export function deepDiveFilesService(db: Db) {
  async function listLinks(companyId: string, caseIds: string[]): Promise<DeepDiveItemFileLink[]> {
    if (caseIds.length === 0) return [];
    const rows = await db
      .select({ link: deepDiveItemFiles, agentName: agents.name, userName: authUsers.name })
      .from(deepDiveItemFiles)
      .leftJoin(agents, and(eq(agents.id, deepDiveItemFiles.linkedByAgentId), eq(agents.companyId, companyId)))
      .leftJoin(authUsers, eq(authUsers.id, deepDiveItemFiles.linkedByUserId))
      .where(and(eq(deepDiveItemFiles.companyId, companyId), inArray(deepDiveItemFiles.caseId, caseIds)))
      .orderBy(asc(deepDiveItemFiles.createdAt), asc(deepDiveItemFiles.id));
    return rows.map(linkResponse);
  }

  async function getLink(item: ItemRow, linkId: string) {
    const row = await db
      .select({ link: deepDiveItemFiles, agentName: agents.name, userName: authUsers.name })
      .from(deepDiveItemFiles)
      .leftJoin(agents, and(eq(agents.id, deepDiveItemFiles.linkedByAgentId), eq(agents.companyId, item.companyId)))
      .leftJoin(authUsers, eq(authUsers.id, deepDiveItemFiles.linkedByUserId))
      .where(and(
        eq(deepDiveItemFiles.id, linkId),
        eq(deepDiveItemFiles.companyId, item.companyId),
        eq(deepDiveItemFiles.caseId, item.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("File link not found");
    return row;
  }

  /** The item's client, or a clear error: a file can only be linked to an item that names its client. */
  function clientOf(item: ItemRow) {
    if (!DEEP_DIVE_TYPES.includes(item.caseType as (typeof DEEP_DIVE_TYPES)[number])) {
      throw unprocessable("Only Deep Dive items have evidence and files");
    }
    if (!item.clientCaseId) throw unprocessable("Choose the client of this Deep Dive item before linking files");
    return item.clientCaseId;
  }

  async function assertTargetOnClient(
    companyId: string,
    clientCaseId: string,
    target: { evidenceId?: string; documentRequestId?: string },
  ) {
    const table = target.evidenceId ? pipelineCaseEvidence : pipelineCaseDocumentRequests;
    const id = target.evidenceId ?? target.documentRequestId!;
    const row = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.companyId, companyId), eq(table.caseId, clientCaseId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(target.evidenceId ? "File not found on this client" : "Document request not found on this client");
  }

  return {
    listLinks,

    /** The Evidence and files screen in one read: the record's client, its files and requests, and every link. */
    async screen(companyId: string): Promise<DeepDiveFilesResponse> {
      const filesSvc = pipelineCaseFilesService(db);
      const items = await db
        .select({ id: cases.id, caseType: cases.caseType, key: cases.key, clientCaseId: cases.clientCaseId })
        .from(cases)
        .where(and(eq(cases.companyId, companyId), inArray(cases.caseType, DEEP_DIVE_TYPES)));
      const record = items.find((item) => item.caseType === DEEP_DIVE_CASE_TYPES.record && item.key === DEEP_DIVE_RECORD_KEY);
      const clients = await filesSvc.listClients(companyId, {});
      const clientCaseId = record?.clientCaseId ?? null;
      const client = clients.find((entry) => entry.id === clientCaseId) ?? null;
      if (!client) return { client: null, clients, evidence: [], requests: [], links: [] };
      const [evidence, requests, links] = await Promise.all([
        filesSvc.listEvidence(companyId, [client.id]),
        pipelineCaseDocumentRequestsService(db).list(companyId, client.id),
        listLinks(companyId, items.filter((item) => item.clientCaseId === client.id).map((item) => item.id)),
      ]);
      return { client, clients, evidence, requests, links };
    },

    async link(
      item: ItemRow,
      target: { evidenceId?: string; documentRequestId?: string; visibility?: DeepDiveVisibility },
      actor: DeepDiveFileActor,
    ): Promise<DeepDiveItemFileLink> {
      const clientCaseId = clientOf(item);
      await assertTargetOnClient(item.companyId, clientCaseId, target);
      try {
        const [row] = await db
          .insert(deepDiveItemFiles)
          .values({
            companyId: item.companyId,
            caseId: item.id,
            evidenceId: target.evidenceId ?? null,
            documentRequestId: target.documentRequestId ?? null,
            visibility: target.visibility ?? "internal",
            linkedByUserId: actor.type === "user" ? actor.userId : null,
            linkedByAgentId: actor.type === "agent" ? actor.agentId : null,
          })
          .returning();
        return linkResponse(await getLink(item, row!.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("This file is already linked to this item");
        throw error;
      }
    },

    async setVisibility(item: ItemRow, linkId: string, visibility: DeepDiveVisibility): Promise<DeepDiveItemFileLink> {
      const existing = await getLink(item, linkId);
      if (existing.link.visibility === visibility) return linkResponse(existing);
      await db
        .update(deepDiveItemFiles)
        .set({ visibility, updatedAt: new Date() })
        .where(and(eq(deepDiveItemFiles.id, linkId), eq(deepDiveItemFiles.caseId, item.id)));
      return linkResponse(await getLink(item, linkId));
    },

    /** Remove one link. The file, and its links to other items, stay as they are. */
    async unlink(item: ItemRow, linkId: string): Promise<DeepDiveItemFileLink> {
      const existing = await getLink(item, linkId);
      await db
        .delete(deepDiveItemFiles)
        .where(and(eq(deepDiveItemFiles.id, linkId), eq(deepDiveItemFiles.caseId, item.id)));
      return linkResponse(existing);
    },
  };
}
