// Deep Dive sync to the website (GRE-2439). The public site never queries GSAM,
// so GSAM pushes: one client's Shared Deep Dive items, Shared files, the
// document requests linked Shared to them, and published deliverables, as one
// snapshot the site stores under that client (the tenant). The snapshot is
// whole, so an item unshared or a deliverable withdrawn is gone after the next
// sync. Items reach the payload only through listSharedDeepDiveItemsForClient
// and listSharedDeepDiveFilesForClient, so Internal items never leave GSAM.
//
// The site calls back, signed with its own key (gs-bridge-v1), when the client
// answers a document request; GSAM then marks the request received.
import { createHash, createPublicKey, verify } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  cases,
  clientDeliverablePublications,
  deepDiveItemFiles,
  pipelineCaseDocumentRequests,
  pipelineCases,
  websiteBridgeInboundNonces,
  websiteSite,
} from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_SYNC_SCHEMA,
  type DeepDiveSyncDocumentRequest,
  type DeepDiveSyncPayload,
  type DeepDiveSyncResult,
  type WebsiteBridgeSiteKey,
  type WebsiteDocumentRequestAnswer,
} from "@greatstone/shared";
import { isUniqueViolation } from "../../db-errors.js";
import { conflict, notFound } from "../../errors.js";
import { listSharedDeepDiveFilesForClient, listSharedDeepDiveItemsForClient, type DeepDiveClientScope } from "../deep-dive-sharing.js";
import { bridgeCanonicalQuery, bridgeCanonicalString, type WebsiteBridgeActor } from "./data-bridge-client.js";
import { websiteDataBridgeService, type BridgeSite, type WebsiteDataBridgeOptions } from "./data-bridge.js";

const DEEP_DIVE_TYPES = Object.values(DEEP_DIVE_CASE_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same window as the site's: a call back more than 60 s from GSAM's clock is refused. */
const TIME_WINDOW_SECONDS = 60;

/**
 * Document requests linked Shared to a Shared item of this client. Only these
 * go to the site, and only these can be answered from it.
 */
async function sharedDocumentRequests(db: Db, scope: DeepDiveClientScope, requestId?: string) {
  const rows = await db
    .select({ request: pipelineCaseDocumentRequests, itemId: cases.id })
    .from(deepDiveItemFiles)
    .innerJoin(cases, and(eq(cases.id, deepDiveItemFiles.caseId), eq(cases.companyId, deepDiveItemFiles.companyId)))
    .innerJoin(pipelineCaseDocumentRequests, and(
      eq(pipelineCaseDocumentRequests.id, deepDiveItemFiles.documentRequestId),
      eq(pipelineCaseDocumentRequests.companyId, scope.companyId),
      eq(pipelineCaseDocumentRequests.caseId, scope.clientCaseId),
    ))
    .where(and(
      eq(deepDiveItemFiles.companyId, scope.companyId),
      eq(deepDiveItemFiles.visibility, "shared"),
      eq(cases.companyId, scope.companyId),
      eq(cases.clientCaseId, scope.clientCaseId),
      eq(cases.visibility, "shared"),
      inArray(cases.caseType, DEEP_DIVE_TYPES),
      ...(requestId ? [eq(pipelineCaseDocumentRequests.id, requestId)] : []),
    ))
    .orderBy(asc(pipelineCaseDocumentRequests.position), asc(pipelineCaseDocumentRequests.createdAt), asc(cases.caseNumber));
  const byId = new Map<string, { request: typeof pipelineCaseDocumentRequests.$inferSelect; itemIds: string[] }>();
  for (const row of rows) {
    const entry = byId.get(row.request.id) ?? { request: row.request, itemIds: [] };
    if (!entry.itemIds.includes(row.itemId)) entry.itemIds.push(row.itemId);
    byId.set(row.request.id, entry);
  }
  return [...byId.values()];
}

function requestOut(entry: Awaited<ReturnType<typeof sharedDocumentRequests>>[number]): DeepDiveSyncDocumentRequest {
  const { request } = entry;
  const receivedAt = request.websiteAnsweredAt ?? (request.evidenceId ? request.updatedAt : null);
  return {
    id: request.id,
    title: request.title,
    note: request.note,
    itemIds: entry.itemIds,
    status: receivedAt ? "received" : "open",
    receivedAt: receivedAt ? receivedAt.toISOString() : null,
    createdAt: request.createdAt.toISOString(),
  };
}

/** The snapshot for one client of one company. Throws 404 when the client is not this company's. */
export async function buildDeepDiveSyncPayload(db: Db, scope: DeepDiveClientScope, now: Date = new Date()): Promise<DeepDiveSyncPayload> {
  const client = await db
    .select({ id: pipelineCases.id, title: pipelineCases.title })
    .from(pipelineCases)
    .where(and(eq(pipelineCases.id, scope.clientCaseId), eq(pipelineCases.companyId, scope.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!client) throw notFound("Client not found");
  const [items, files, requests, deliverables] = await Promise.all([
    listSharedDeepDiveItemsForClient(db, scope),
    listSharedDeepDiveFilesForClient(db, scope),
    sharedDocumentRequests(db, scope),
    db
      .select()
      .from(clientDeliverablePublications)
      .where(and(
        eq(clientDeliverablePublications.companyId, scope.companyId),
        eq(clientDeliverablePublications.caseId, scope.clientCaseId),
        inArray(clientDeliverablePublications.status, ["published", "accepted"]),
        isNotNull(clientDeliverablePublications.publishedAt),
      ))
      .orderBy(asc(clientDeliverablePublications.publishedAt), asc(clientDeliverablePublications.id)),
  ]);
  const sharedIds = new Set(items.map((item) => item.id));
  return {
    schema: DEEP_DIVE_SYNC_SCHEMA,
    tenantId: client.id,
    tenantName: client.title,
    generatedAt: now.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      type: item.caseType,
      key: item.key,
      title: item.title,
      summary: item.summary,
      status: item.status,
      fields: item.fields,
      // An Internal parent's id is not sent.
      parentId: item.parentCaseId && sharedIds.has(item.parentCaseId) ? item.parentCaseId : null,
      updatedAt: item.updatedAt,
    })),
    files: files.map((file) => ({
      id: file.linkId,
      itemId: file.itemId,
      title: file.title,
      kind: file.kind,
      status: file.status,
      heldAt: file.heldAt,
    })),
    documentRequests: requests.map(requestOut),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      title: row.title,
      version: row.version,
      status: row.status as "published" | "accepted",
      publishedAt: row.publishedAt!.toISOString(),
      acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    })),
  };
}

// ---- the site's call back ----

export type InboundBridgeErrorCode = "bad_key" | "expired" | "bad_signature" | "replay" | "not_found" | "bad_request";

const INBOUND_STATUS: Record<InboundBridgeErrorCode, number> = {
  bad_key: 401, expired: 401, bad_signature: 401, replay: 401, not_found: 404, bad_request: 400,
};

/** Answered as `{ error: { code } }` only, the same shape the site uses (contracts/gs-bridge-v1). */
export class InboundBridgeError extends Error {
  readonly status: number;
  constructor(readonly code: InboundBridgeErrorCode) {
    super(code);
    this.name = "InboundBridgeError";
    this.status = INBOUND_STATUS[code];
  }
}

export interface InboundBridgeRequest {
  method: string;
  /** The hosts the site may have signed: the Host header, and GSAM's public address. */
  hosts: string[];
  /** Path and query as received, for example `/api/website-bridge/v1/...`. */
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer | string | undefined;
}

export interface VerifiedSiteCall {
  site: Pick<typeof websiteSite.$inferSelect, "id" | "companyId" | "domain" | "dataBridgeSiteKeyId">;
  /** The `client:<id>` actor the site signed: the website customer who answered. */
  customerId: string;
}

export interface DeepDiveSyncOptions extends WebsiteDataBridgeOptions {
  now?: () => number;
}

export function deepDiveSyncService(db: Db, options: DeepDiveSyncOptions = {}) {
  const now = options.now ?? Date.now;
  const bridge = websiteDataBridgeService(db, options);

  async function preview(companyId: string, clientCaseId: string) {
    if (!UUID_RE.test(clientCaseId)) throw notFound("Client not found");
    return buildDeepDiveSyncPayload(db, { companyId, clientCaseId }, new Date(now()));
  }

  /** Push one client's snapshot to the site with the write key. The client must be of the site's company. */
  async function push(site: BridgeSite, clientCaseId: string, actor: WebsiteBridgeActor): Promise<DeepDiveSyncResult> {
    const payload = await preview(site.companyId, clientCaseId);
    await (await bridge.client(site, "write")).putDeepDiveTenant(payload.tenantId, payload, actor);
    return {
      tenantId: payload.tenantId,
      syncedAt: new Date(now()).toISOString(),
      counts: {
        items: payload.items.length,
        files: payload.files.length,
        documentRequests: payload.documentRequests.length,
        deliverables: payload.deliverables.length,
      },
    };
  }

  /** Record the site's public key for its calls back. One key id names one site. */
  async function setSiteKey(site: Pick<BridgeSite, "id">, input: WebsiteBridgeSiteKey): Promise<WebsiteBridgeSiteKey> {
    try {
      await db.update(websiteSite)
        .set({ dataBridgeSiteKeyId: input.keyId, dataBridgeSitePublicKey: input.publicKey, updatedAt: new Date(now()) })
        .where(eq(websiteSite.id, site.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("Another site already uses this key id. Give each site its own key.");
      throw error;
    }
    return { keyId: input.keyId, publicKey: input.publicKey };
  }

  /** Check a call from the site: its key, the time, the signature, then the nonce. Throws InboundBridgeError. */
  async function verifySiteCall(req: InboundBridgeRequest): Promise<VerifiedSiteCall> {
    const h = (name: string) => req.headers[name]?.trim() || "";
    const kid = h("x-gs-bridge-key");
    const time = h("x-gs-bridge-time");
    const nonce = h("x-gs-bridge-nonce");
    const actor = h("x-gs-bridge-actor");
    const run = h("x-gs-bridge-run") || null;
    const signature = h("x-gs-bridge-signature");
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(kid)) throw new InboundBridgeError("bad_key");
    const [site] = await db
      .select({
        id: websiteSite.id, companyId: websiteSite.companyId, domain: websiteSite.domain,
        dataBridgeSiteKeyId: websiteSite.dataBridgeSiteKeyId, publicKey: websiteSite.dataBridgeSitePublicKey,
      })
      .from(websiteSite)
      .where(and(eq(websiteSite.dataBridgeSiteKeyId, kid), isNull(websiteSite.archivedAt)))
      .limit(1);
    if (!site?.publicKey) throw new InboundBridgeError("bad_key");
    const nowSeconds = Math.floor(now() / 1000);
    if (!/^\d{1,12}$/.test(time) || Math.abs(Number(time) - nowSeconds) > TIME_WINDOW_SECONDS) {
      throw new InboundBridgeError("expired");
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^client:[A-Za-z0-9_-]{1,64}$/.test(actor)) {
      throw new InboundBridgeError("bad_signature");
    }
    const url = new URL(req.url, "http://gsam.invalid");
    const body = req.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, "utf8");
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    let key;
    try {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: site.publicKey }, format: "jwk" });
    } catch {
      throw new InboundBridgeError("bad_key");
    }
    const sig = Buffer.from(signature, "base64url");
    const signedOk = sig.length === 64 && req.hosts.some((host) => verify(null, Buffer.from(bridgeCanonicalString({
      method: req.method, host, path: url.pathname, query: bridgeCanonicalQuery(url.searchParams),
      time: Number(time), nonce, actor, run, bodySha256,
    }), "utf8"), key, sig));
    if (!signedOk) throw new InboundBridgeError("bad_signature");
    // A nonce works once per key; rows past the window are pruned here.
    await db.delete(websiteBridgeInboundNonces).where(lt(websiteBridgeInboundNonces.expiresAt, new Date(now())));
    const inserted = await db.insert(websiteBridgeInboundNonces)
      .values({ keyId: kid, nonce, expiresAt: new Date((nowSeconds + 2 * TIME_WINDOW_SECONDS) * 1000) })
      .onConflictDoNothing()
      .returning({ nonce: websiteBridgeInboundNonces.nonce });
    if (inserted.length === 0) throw new InboundBridgeError("replay");
    return { site, customerId: actor.slice("client:".length) };
  }

  /**
   * The client answered a document request on the website: mark it received,
   * with GSAM's time and the answering client. The tenant must be a client of
   * the site's own company and the request one GSAM sent to that tenant;
   * anything else is not found. The same answer id again changes nothing.
   */
  async function answerDocumentRequest(call: VerifiedSiteCall, tenantId: string, requestId: string, answer: WebsiteDocumentRequestAnswer) {
    if (answer.answeredBy.customerId !== call.customerId) throw new InboundBridgeError("bad_request");
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(requestId)) throw new InboundBridgeError("not_found");
    const scope = { companyId: call.site.companyId, clientCaseId: tenantId };
    const tenant = await db
      .select({ id: pipelineCases.id })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.id, tenantId), eq(pipelineCases.companyId, call.site.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!tenant) throw new InboundBridgeError("not_found");
    const [entry] = await sharedDocumentRequests(db, scope, requestId);
    if (!entry) throw new InboundBridgeError("not_found");
    const current = entry.request;
    if (current.websiteAnsweredAt && current.websiteAnswer?.answerId === answer.answerId) {
      return { requestId, receivedAt: current.websiteAnsweredAt.toISOString(), repeated: true };
    }
    const at = new Date(now());
    await db.update(pipelineCaseDocumentRequests)
      .set({
        websiteAnsweredAt: at,
        websiteAnsweredBy: {
          customerId: answer.answeredBy.customerId,
          name: answer.answeredBy.name ?? null,
          email: answer.answeredBy.email ?? null,
        },
        websiteAnswer: { answerId: answer.answerId, note: answer.note ?? null, fileName: answer.fileName ?? null },
        updatedAt: at,
      })
      .where(and(
        eq(pipelineCaseDocumentRequests.id, requestId),
        eq(pipelineCaseDocumentRequests.companyId, call.site.companyId),
        eq(pipelineCaseDocumentRequests.caseId, tenantId),
      ));
    return { requestId, receivedAt: at.toISOString(), repeated: false };
  }

  return { preview, push, setSiteKey, verifySiteCall, answerDocumentRequest };
}
export type DeepDiveSyncService = ReturnType<typeof deepDiveSyncService>;
