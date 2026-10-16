import type { MemoryScope } from "@greatstone/shared";
import { logger } from "../../middleware/logger.js";
import { MemorySensitiveContentError } from "./sensitive-content.js";
import type { MemoryCaller, MemoryGatewayService } from "./service.js";

/** How much of a text file goes into the memory entry. */
export const CASE_DOCUMENT_TEXT_LIMIT = 4_000;

/** Media types whose bytes are readable text worth keeping. */
export function isReadableText(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type === "application/xml";
}

export function caseDocumentSourceId(caseId: string, evidenceId: string) {
  return `${caseId}/${evidenceId}`;
}

const normalise = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Where a client's documents are remembered: the client memory of the same
 * name when there is one the caller may write to, otherwise the organisation
 * memory. Either way the entry names the client.
 */
export function pickCaseDocumentScope(scopes: MemoryScope[], clientName: string): MemoryScope | null {
  const wanted = normalise(clientName);
  return (
    scopes.find((scope) => scope.kind === "client" && normalise(scope.name) === wanted) ??
    scopes.find((scope) => scope.kind === "organization") ??
    null
  );
}

export function caseDocumentEntry(input: {
  clientName: string;
  title: string;
  originalFilename: string | null;
  note: string | null;
  receivedAt: Date;
  text: string | null;
}): { title: string; content: string } {
  const day = input.receivedAt.toISOString().slice(0, 10);
  const file = input.originalFilename && input.originalFilename !== input.title ? ` (${input.originalFilename})` : "";
  const lines = [`${input.clientName}: ${input.title}${file} was added to the client on ${day}.`];
  if (input.note?.trim()) lines.push(`Note: ${input.note.trim()}`);
  const text = input.text?.trim();
  if (text) {
    const trimmed = text.length > CASE_DOCUMENT_TEXT_LIMIT ? `${text.slice(0, CASE_DOCUMENT_TEXT_LIMIT)}...` : text;
    lines.push("", "What it says:", trimmed);
  }
  return { title: `${input.clientName}: ${input.title}`.slice(0, 200), content: lines.join("\n").slice(0, 20_000) };
}

/**
 * Feed a document dropped onto a client into memory, as an entry waiting for
 * review. Never fails the upload: memory off, no writable scope, a held back
 * entry or any other error is logged and skipped.
 */
export async function rememberCaseDocument(
  svc: MemoryGatewayService,
  caller: MemoryCaller,
  input: {
    caseId: string;
    evidenceId: string;
    clientName: string;
    title: string;
    originalFilename: string | null;
    note: string | null;
    text: string | null;
    receivedAt?: Date;
  },
): Promise<string | null> {
  try {
    const settings = await svc.getSettings(caller.companyId);
    if (!settings.enabled) return null;
    const scope = pickCaseDocumentScope(await svc.listScopes(caller), input.clientName);
    if (!scope) return null;
    const entry = caseDocumentEntry({ ...input, receivedAt: input.receivedAt ?? new Date() });
    const result = await svc.contribute(caller, {
      scopeId: scope.id,
      title: entry.title,
      content: entry.content,
      entryType: "observation",
      decisionClass: "operational",
      sensitivity: "internal",
      entities: [input.clientName.trim()].filter(Boolean).slice(0, 1),
      topics: [],
      sourceKind: "client_document",
      sourceId: caseDocumentSourceId(input.caseId, input.evidenceId),
      evidence: { caseId: input.caseId, evidenceId: input.evidenceId, fileName: input.originalFilename },
    });
    return result.record.id;
  } catch (error) {
    if (!(error instanceof MemorySensitiveContentError)) {
      logger.warn({ err: error, companyId: caller.companyId, caseId: input.caseId }, "client document was not added to memory");
    }
    return null;
  }
}
