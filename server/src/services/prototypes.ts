import { buffer } from "node:stream/consumers";
import sharp from "sharp";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, authUsers, issues, issueWorkProducts, organisations, pipelineCases, prototypePortalShares } from "@greatstone/db";
import {
  PORTAL_PROTOTYPE_THUMBNAIL_MAX_CHARS,
  PORTAL_PROTOTYPES_MAX,
  PORTAL_PROTOTYPES_SCHEMA,
  prototypesQuerySchema,
  type PortalPrototypeItem,
  type PortalPrototypesPayload,
  type Prototype,
  type PrototypePortalSync,
  type PrototypeSettableStatus,
  type PrototypesQuery,
  type PrototypeStatus,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { deliverableService } from "./deliverables.js";
import type { WebsiteBridgeActor } from "./website/data-bridge-client.js";
import { websiteDataBridgeService, type BridgeSite } from "./website/data-bridge.js";
import { websiteModuleService } from "./website/module.js";

// Prototypes (John, 14 Nov): link deliverables of kind "prototype", plus a
// status and the per-client portal share. See packages/shared/src/prototypes.ts.

type Share = typeof prototypePortalShares.$inferSelect;
type Loaded = { prototype: Prototype; share: Share | null; clientWebsiteOrganisationId: string | null };

// ponytail: one list read of up to 200 prototypes, filtered here; page in SQL when a company has more.
const LIST_LIMIT = 200;

/** Pushes for one client run one after another, so an older list can never land after a newer one. */
const pushChains = new Map<string, Promise<unknown>>();

/** The portal shows it only while it is still this client's and its latest version is still at the shared address. */
function isVisible(item: Omit<Loaded, "prototype"> & { prototype: Omit<Prototype, "portal" | "prototypeStatus"> }, storedStatus: PrototypeStatus) {
  const { share, prototype } = item;
  return !!share
    && storedStatus !== "retired"
    && !!prototype.url
    && share.sharedUrl === prototype.url
    && share.organisationId === prototype.client?.id
    && share.websiteOrganisationId === item.clientWebsiteOrganisationId;
}

/** Sends one client's list to one site; tests pass a fake. */
export type PortalPrototypesPush = (site: BridgeSite, payload: PortalPrototypesPayload, actor: WebsiteBridgeActor) => Promise<unknown>;

export function prototypeService(db: Db, storage?: StorageService, options: { push?: PortalPrototypesPush } = {}) {
  const deliverables = deliverableService(db, storage);
  const bridge = websiteDataBridgeService(db);
  const push: PortalPrototypesPush = options.push
    ?? (async (site, payload, actor) => (await bridge.client(site, "write")).putPortalPrototypes(payload.customerId, payload, actor));
  const sites = websiteModuleService(db);

  async function load(companyId: string, rawQuery: Partial<PrototypesQuery> = {}): Promise<Loaded[]> {
    const query = prototypesQuerySchema.parse(rawQuery);
    const { deliverables: rows } = await deliverables.list(companyId, {
      kind: "prototype",
      projectId: query.projectId,
      q: query.q,
      limit: LIST_LIMIT,
    });
    if (rows.length === 0) return [];

    const caseIds = [...new Set(rows.flatMap((row) => (row.clientCase ? [row.clientCase.id] : [])))];
    const issueIds = [...new Set(rows.map((row) => row.issue.id))];
    const [clients, statuses, owners, shares] = await Promise.all([
      caseIds.length === 0 ? [] : db
        .select({ caseId: pipelineCases.id, id: organisations.id, name: organisations.name, websiteId: organisations.websiteOrganisationId })
        .from(pipelineCases)
        .innerJoin(organisations, and(eq(organisations.id, pipelineCases.organisationId), eq(organisations.companyId, pipelineCases.companyId)))
        .where(and(eq(pipelineCases.companyId, companyId), inArray(pipelineCases.id, caseIds))),
      db
        .select({ id: issueWorkProducts.id, status: sql<string | null>`${issueWorkProducts.metadata}->>'prototypeStatus'` })
        .from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.id, rows.map((row) => row.id)))),
      db
        .select({ id: issues.id, agentId: agents.id, agentName: agents.name, userId: authUsers.id, userName: authUsers.name })
        .from(issues)
        .leftJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, issues.companyId)))
        .leftJoin(authUsers, eq(authUsers.id, issues.assigneeUserId))
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))),
      db
        .select()
        .from(prototypePortalShares)
        .where(and(eq(prototypePortalShares.companyId, companyId), inArray(prototypePortalShares.issueId, issueIds))),
    ]);
    const clientByCase = new Map(clients.map((row) => [row.caseId, row]));
    const statusById = new Map(statuses.map((row) => [row.id, row.status]));
    const ownerByIssue = new Map(owners.map((row) => [row.id, row]));
    const shareByKey = new Map(shares.map((row) => [`${row.issueId}:${row.deliverableKey}`, row]));

    const loaded = rows.map((row): Loaded => {
      const client = row.clientCase ? clientByCase.get(row.clientCase.id) ?? null : null;
      const raw = statusById.get(row.id);
      const storedStatus: PrototypeStatus = raw === "in_review" || raw === "retired" ? raw : "draft";
      const owner = ownerByIssue.get(row.issue.id);
      const share = shareByKey.get(`${row.issue.id}:${row.key}`) ?? null;
      const base = {
        ...row,
        client: client ? { id: client.id, name: client.name, websiteLinked: !!client.websiteId } : null,
        owner: owner?.agentId && owner.agentName
          ? { type: "agent" as const, id: owner.agentId, name: owner.agentName }
          : owner?.userId
            ? { type: "user" as const, id: owner.userId, name: owner.userName || "A person" }
            : row.createdByAgent ? { type: "agent" as const, ...row.createdByAgent } : null,
      };
      const clientWebsiteOrganisationId = client?.websiteId ?? null;
      const visible = isVisible({ prototype: base, share, clientWebsiteOrganisationId }, storedStatus);
      return {
        share,
        clientWebsiteOrganisationId,
        prototype: {
          ...base,
          prototypeStatus: visible ? "shared" : storedStatus,
          portal: {
            visible,
            sharedAt: visible ? share!.sharedAt.toISOString() : null,
            sharedByUserId: visible ? share!.sharedByUserId : null,
            needsReshare: !!share && !visible && storedStatus !== "retired",
          },
        },
      };
    });
    return loaded.filter(({ prototype }) =>
      (!query.organisationId || prototype.client?.id === query.organisationId)
      && (!query.status || prototype.prototypeStatus === query.status));
  }

  async function getLoaded(companyId: string, id: string): Promise<Loaded> {
    const detail = await deliverables.getDetail(companyId, id);
    if (!detail || detail.kind !== "prototype") throw notFound("Prototype not found");
    const match = (await load(companyId, { q: undefined, projectId: detail.project?.id }))
      .find((item) => item.prototype.issue.id === detail.issue.id && item.prototype.key === detail.key);
    if (!match) throw notFound("Prototype not found");
    return match;
  }

  /** A small JPEG of the stored screenshot, as a data URL, or null. */
  async function thumbnail(prototype: Prototype): Promise<string | null> {
    const attachmentId = /^\/api\/attachments\/([0-9a-f-]{36})\/content$/i.exec(prototype.screenshotPath ?? "")?.[1];
    if (!storage || !attachmentId) return null;
    try {
      const attachment = await deliverables.getAttachment(prototype.companyId, attachmentId);
      if (!attachment) return null;
      const object = await storage.getObject(prototype.companyId, attachment.objectKey);
      const image = await sharp(await buffer(object.stream)).resize(480, 270, { fit: "cover", position: "top" }).jpeg({ quality: 60 }).toBuffer();
      const url = `data:image/jpeg;base64,${image.toString("base64")}`;
      return url.length <= PORTAL_PROTOTYPE_THUMBNAIL_MAX_CHARS ? url : null;
    } catch {
      return null;
    }
  }

  /** Exactly what one client's portal is sent: only prototypes visible to that website organisation. */
  async function portalPayload(companyId: string, websiteOrganisationId: string, now = new Date()): Promise<PortalPrototypesPayload> {
    const visible = (await load(companyId))
      .filter((item) => item.prototype.portal.visible && item.share?.websiteOrganisationId === websiteOrganisationId)
      .slice(0, PORTAL_PROTOTYPES_MAX);
    const prototypes: PortalPrototypeItem[] = [];
    for (const { prototype } of visible) {
      prototypes.push({
        id: prototype.id,
        title: prototype.title,
        description: prototype.summary,
        url: prototype.url!,
        version: prototype.version,
        updatedAt: prototype.createdAt,
        thumbnail: await thumbnail(prototype),
      });
    }
    return { schema: PORTAL_PROTOTYPES_SCHEMA, customerId: websiteOrganisationId, generatedAt: now.toISOString(), prototypes };
  }

  /** Replace that client's list on every connected site. Never throws: a failure comes back as `error`. */
  function syncPortal(companyId: string, websiteOrganisationId: string, actor: WebsiteBridgeActor): Promise<PrototypePortalSync> {
    const key = `${companyId}:${websiteOrganisationId}`;
    const run = (pushChains.get(key) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<PrototypePortalSync> => {
      const targets = (await sites.listSites(companyId)).filter((site) => !site.archivedAt && site.dataBridgeWriteSecretId);
      if (targets.length === 0) return { sites: 0, error: "No website is connected for portal updates yet (no bridge write key)." };
      const payload = await portalPayload(companyId, websiteOrganisationId);
      let reached = 0;
      const failures: string[] = [];
      for (const site of targets) {
        try {
          await push(site, payload, actor);
          reached += 1;
        } catch (error) {
          failures.push(`${site.domain}: ${error instanceof Error ? error.message : "unreachable"}`);
        }
      }
      return { sites: reached, error: failures.length ? `The portal could not be updated on ${failures.join("; ")}` : null };
    });
    pushChains.set(key, run);
    void run.finally(() => { if (pushChains.get(key) === run) pushChains.delete(key); });
    return run;
  }

  /** Every version of the prototype carries the status. */
  async function writeStatus(companyId: string, prototype: Prototype, status: PrototypeSettableStatus) {
    await db
      .update(issueWorkProducts)
      .set({
        metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || ${JSON.stringify({ prototypeStatus: status })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, prototype.issue.id),
        eq(issueWorkProducts.type, "deliverable"),
        eq(issueWorkProducts.externalId, prototype.key),
      ));
  }

  async function removeShare(companyId: string, prototype: Prototype): Promise<Share | null> {
    const [removed] = await db
      .delete(prototypePortalShares)
      .where(and(
        eq(prototypePortalShares.companyId, companyId),
        eq(prototypePortalShares.issueId, prototype.issue.id),
        eq(prototypePortalShares.deliverableKey, prototype.key),
      ))
      .returning();
    return removed ?? null;
  }

  return {
    list: async (companyId: string, query: Partial<PrototypesQuery> = {}) => (await load(companyId, query)).map((item) => item.prototype),
    get: async (companyId: string, id: string) => (await getLoaded(companyId, id)).prototype,
    portalPayload,
    syncPortal,

    /** Draft, in review or retired. Retiring takes it out of the portal. */
    setStatus: async (companyId: string, id: string, status: PrototypeSettableStatus, actor: WebsiteBridgeActor) => {
      const { prototype } = await getLoaded(companyId, id);
      await writeStatus(companyId, prototype, status);
      const removed = status === "retired" ? await removeShare(companyId, prototype) : null;
      const portal = removed ? await syncPortal(companyId, removed.websiteOrganisationId, actor) : null;
      return { prototype: (await getLoaded(companyId, id)).prototype, unshared: removed, portal };
    },

    /**
     * People only (the route checks). `organisationId` is the client the
     * person confirmed and must be the prototype's client now.
     */
    setVisibility: async (
      companyId: string,
      id: string,
      input: { visible: boolean; organisationId: string; userId: string },
    ) => {
      const loaded = await getLoaded(companyId, id);
      const { prototype } = loaded;
      if (!prototype.client || prototype.client.id !== input.organisationId) {
        throw unprocessable("This prototype is not filed under that client. Reload and check its client.");
      }
      const actor: WebsiteBridgeActor = { type: "user", id: input.userId };
      if (!input.visible) {
        const removed = await removeShare(companyId, prototype);
        const websiteId = removed?.websiteOrganisationId ?? loaded.clientWebsiteOrganisationId;
        const portal = websiteId ? await syncPortal(companyId, websiteId, actor) : { sites: 0, error: null };
        return { prototype: (await getLoaded(companyId, id)).prototype, changed: !!removed, client: prototype.client, portal };
      }
      if (!loaded.clientWebsiteOrganisationId) {
        throw unprocessable(`Link ${prototype.client.name} to its website organisation first (Organisations, Edit).`);
      }
      if (prototype.prototypeStatus === "retired") throw unprocessable("A retired prototype cannot be shared. Set it back to In review first.");
      if (!prototype.url) throw unprocessable("Only a prototype with a live address can be shared");
      const values = {
        companyId,
        issueId: prototype.issue.id,
        deliverableKey: prototype.key,
        organisationId: prototype.client.id,
        websiteOrganisationId: loaded.clientWebsiteOrganisationId,
        sharedUrl: prototype.url,
        sharedByUserId: input.userId,
        sharedAt: new Date(),
      };
      await db
        .insert(prototypePortalShares)
        .values(values)
        .onConflictDoUpdate({
          target: [prototypePortalShares.companyId, prototypePortalShares.issueId, prototypePortalShares.deliverableKey],
          set: values,
        });
      const portal = await syncPortal(companyId, loaded.clientWebsiteOrganisationId, actor);
      return { prototype: (await getLoaded(companyId, id)).prototype, changed: !loaded.prototype.portal.visible, client: prototype.client, portal };
    },

    /**
     * After a move or a new version: if the prototype was shared, push its
     * client's list again, so the portal follows (a move or a new address hides it).
     */
    resyncIfShared: async (companyId: string, issueId: string, key: string, actor: WebsiteBridgeActor) => {
      const [share] = await db
        .select()
        .from(prototypePortalShares)
        .where(and(
          eq(prototypePortalShares.companyId, companyId),
          eq(prototypePortalShares.issueId, issueId),
          eq(prototypePortalShares.deliverableKey, key),
        ));
      return share ? syncPortal(companyId, share.websiteOrganisationId, actor) : null;
    },
  };
}

export type PrototypeService = ReturnType<typeof prototypeService>;
