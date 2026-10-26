// The website admin bridge in GSAM (GRE-2323): the read key's setup, the
// "Website data" status and the reads themselves. The private key never leaves
// the vault except to sign inside this process; routes return only its id and
// public key.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { websiteSite } from "@greatstone/db";
import type {
  WebsiteCommerceListQuery,
  WebsiteDataListQuery,
  WebsiteCommerceRefundRequestInput,
  WebsiteCommerceWriteMethod,
  WebsiteCommerceResource,
  WebsiteDataBridgeCapability,
  WebsiteDataBridgeKey,
  WebsiteDataBridgeStatus,
  WebsiteDataResource,
  WebsitePaymentReportQuery,
} from "@greatstone/shared";
import { HttpError } from "../../errors.js";
import { secretService } from "../secrets.js";
import type { WebsiteEnquiry, WebsiteEnquiryReader } from "./enquiries.js";
import {
  WebsiteBridgeError,
  createWebsiteBridgeClient,
  parseBridgeCredential,
  type WebsiteBridgeActor,
  type WebsiteBridgeClient,
} from "./data-bridge-client.js";

export type BridgeSite = Pick<typeof websiteSite.$inferSelect,
  "id" | "companyId" | "domain" | "dataBridgeUrl" | "dataBridgeReadKeyId" | "dataBridgeReadSecretId"
  | "dataBridgeWriteKeyId" | "dataBridgeWriteSecretId" | "dataBridgeRefundKeyId" | "dataBridgeRefundSecretId">;

/** Per capability: the site's key columns, the vault value's config path and the key id's middle word. */
const CAPABILITY_KEYS = {
  read: { keyId: "dataBridgeReadKeyId", secretId: "dataBridgeReadSecretId", configPath: "dataBridge.readKey", kidWord: "read" },
  write: { keyId: "dataBridgeWriteKeyId", secretId: "dataBridgeWriteSecretId", configPath: "dataBridge.writeKey", kidWord: "write" },
  refund_request: { keyId: "dataBridgeRefundKeyId", secretId: "dataBridgeRefundSecretId", configPath: "dataBridge.refundKey", kidWord: "refund" },
} as const satisfies Record<WebsiteDataBridgeCapability, { keyId: keyof BridgeSite; secretId: keyof BridgeSite; configPath: string; kidWord: string }>;

/**
 * Fail closed (GRE-2354 section 6): a null write or refund key means that capability is off. The route answers 409
 * and makes no call to the site; reads still work.
 */
export function capabilityNotConfigured(capability: "write" | "refund_request") {
  return new HttpError(409, `Commerce changes are off for this site: no ${capability === "write" ? "write" : "refund"} key is set up`,
    { code: "capability_not_configured", capability });
}

const STATUS_TTL_MS = 60_000;
/** The scheduled enquiry pull: GSAM itself, with no person or agent behind it. */
export const ENQUIRY_PULL_ACTOR: WebsiteBridgeActor = { type: "system", id: "website-enquiry-pull" };
const STATUS_ACTOR: WebsiteBridgeActor = { type: "system", id: "website-data-status" };

const enquirySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().min(3),
  organisationName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
  utm: z.record(z.string(), z.string().nullable()).optional(),
  consent: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])).optional(),
  createdAt: z.string(),
});

export function bridgeUrlOf(site: Pick<BridgeSite, "domain" | "dataBridgeUrl">) {
  return site.dataBridgeUrl ?? `https://${site.domain}`;
}

export interface WebsiteDataBridgeOptions {
  /** Test seam: the client for a site and its stored credential value. */
  clientFor?: (site: BridgeSite, credentialValue: string) => WebsiteBridgeClient;
  now?: () => number;
}

export function websiteDataBridgeService(db: Db, options: WebsiteDataBridgeOptions = {}) {
  const secrets = secretService(db);
  const now = options.now ?? Date.now;
  const clientFor = options.clientFor ?? ((site: BridgeSite, value: string) =>
    createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value) }));
  const statusCache = new Map<string, { at: number; keyId: string | null; value: WebsiteDataBridgeStatus }>();

  async function client(site: BridgeSite, capability: WebsiteDataBridgeCapability = "read") {
    const keys = CAPABILITY_KEYS[capability];
    const secretId = site[keys.secretId];
    if (!secretId) {
      throw capability === "read" ? new WebsiteBridgeError("not_configured") : new WebsiteBridgeError("not_configured", null, `no ${keys.kidWord} key yet`);
    }
    // Read for this site only, as a system consumer, so each use is an access event like the publish token's (ADR 4.4).
    // Each write-side capability has its own consumer id, so the access events say which key was used.
    const value = await secrets.resolveSecretValue(site.companyId, secretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: capability === "read" ? `website-data-bridge:${site.id}` : `website-data-bridge:${site.id}:${keys.kidWord}`,
        configPath: keys.configPath,
        actorType: "system",
      },
    }).catch((error: unknown) => {
      throw new WebsiteBridgeError("not_configured", null, error instanceof Error ? error.message : `the ${capability} key is unavailable`);
    });
    return clientFor(site, value);
  }

  /** A commerce write or refund client: 409 capability_not_configured, before any vault read or site call, when the key is null. */
  async function commerceClient(site: BridgeSite, capability: "write" | "refund_request") {
    if (!site[CAPABILITY_KEYS[capability].secretId]) throw capabilityNotConfigured(capability);
    return client(site, capability);
  }

  /**
   * Makes a new key pair for the site: `read` for GSAM's reads, `write` for the Deep Dive sync (GRE-2439) and the
   * commerce writes, `refund_request` for refund requests (GRE-2354 2c(b)).
   * Returns the public half only; the private half goes to the vault.
   */
  async function createKey(site: BridgeSite, input: { environment: "stg" | "live"; capability?: WebsiteDataBridgeCapability; url?: string | null },
    userId: string | null): Promise<WebsiteDataBridgeKey> {
    const capability = input.capability ?? "read";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const month = new Date(now()).toISOString().slice(0, 7);
    const keys = CAPABILITY_KEYS[capability];
    const kid = `${input.environment}-${keys.kidWord}-${month}-${randomBytes(3).toString("hex")}`;
    const value = JSON.stringify({ kid, privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString() });
    const currentSecretId = site[keys.secretId];
    const existing = currentSecretId ? await secrets.getById(currentSecretId) : null;
    let secretId: string;
    if (existing && existing.status === "active" && existing.companyId === site.companyId) {
      await secrets.rotate(existing.id, { value }, { userId });
      secretId = existing.id;
    } else {
      const base = `Website data bridge ${capability} key ${site.id.slice(0, 8)}`;
      let name = base;
      for (let n = 2; await secrets.getByName(site.companyId, name); n += 1) name = `${base} ${n}`;
      const created = await secrets.create(site.companyId, {
        name,
        provider: "local_encrypted",
        value,
        description: capability === "write"
          ? `Ed25519 write key GSAM signs ${site.domain}'s Deep Dive sync and commerce writes with (GRE-2439, GRE-2354). Never shared.`
          : capability === "refund_request"
            ? `Ed25519 refund_request key GSAM records ${site.domain}'s refund requests with (GRE-2354). Moves no money; never shared.`
            : `Ed25519 read key GSAM signs ${site.domain}'s admin bridge calls with (GRE-2323). Read only; never shared.`,
      }, { userId });
      secretId = created.id;
    }
    await db.update(websiteSite).set({
      [keys.keyId]: kid,
      [keys.secretId]: secretId,
      ...(input.url !== undefined ? { dataBridgeUrl: input.url } : {}),
      updatedAt: new Date(now()),
    }).where(eq(websiteSite.id, site.id));
    statusCache.delete(site.id);
    const raw = publicKey.export({ format: "jwk" }).x as string;
    return { keyId: kid, capability, publicKey: raw, keysEntry: { kid, capability, publicKey: raw } };
  }

  async function status(site: BridgeSite): Promise<WebsiteDataBridgeStatus> {
    const url = bridgeUrlOf(site);
    const writeSide = { writeKeyId: site.dataBridgeWriteSecretId ? site.dataBridgeWriteKeyId : null,
      refundKeyId: site.dataBridgeRefundSecretId ? site.dataBridgeRefundKeyId : null };
    if (!site.dataBridgeReadSecretId || !site.dataBridgeReadKeyId) {
      return { state: "not_set_up", keyId: null, url, checkedAt: null, message: null, clockSkewSeconds: null, ...writeSide };
    }
    const cached = statusCache.get(site.id);
    if (cached && cached.keyId === site.dataBridgeReadKeyId && now() - cached.at < STATUS_TTL_MS) return { ...cached.value, ...writeSide };
    const checkedAt = new Date(now()).toISOString();
    let value: WebsiteDataBridgeStatus;
    try {
      const health = await (await client(site)).health(STATUS_ACTOR);
      value = { state: "connected", keyId: site.dataBridgeReadKeyId, url, checkedAt, message: null,
        clockSkewSeconds: Math.round((Date.parse(health.serverTime) - now()) / 1000) };
    } catch (error) {
      if (!(error instanceof WebsiteBridgeError)) throw error;
      value = { state: "failing", keyId: site.dataBridgeReadKeyId, url, checkedAt, message: error.message, clockSkewSeconds: null };
    }
    statusCache.set(site.id, { at: now(), keyId: site.dataBridgeReadKeyId, value });
    return { ...value, ...writeSide };
  }

  async function list(site: BridgeSite, resource: WebsiteDataResource,
    filters: { customer?: string; updatedSince?: string; cursor?: string; limit?: number }, actor: WebsiteBridgeActor) {
    return (await client(site)).list(resource, filters, actor);
  }

  async function releaseHealth(site: BridgeSite, actor: WebsiteBridgeActor) {
    return (await client(site)).releaseHealth(actor);
  }

  async function activityEvents(site: BridgeSite, cursor: string, limit: number, actor: WebsiteBridgeActor) {
    return (await client(site)).activityEvents(cursor, limit, actor);
  }

  async function schemaProbe(site: BridgeSite, actor: WebsiteBridgeActor) {
    return (await client(site)).schemaProbe(actor);
  }

  async function get(site: BridgeSite, resource: WebsiteDataResource, id: string, actor: WebsiteBridgeActor) {
    return (await client(site)).get(resource, id, actor);
  }

  /** Commerce reads (GRE-2354 2c(a)): the same read key and the same audit on the site. */
  const commerce = {
    async list(site: BridgeSite, resource: WebsiteCommerceResource, filters: WebsiteCommerceListQuery | WebsiteDataListQuery, actor: WebsiteBridgeActor) {
      return (await client(site)).list(resource, filters, actor);
    },
    async get(site: BridgeSite, resource: WebsiteCommerceResource, id: string, page: { cursor?: string; limit?: number }, actor: WebsiteBridgeActor) {
      const bridge = await client(site);
      return resource === "imports" ? bridge.importJob(id, page, actor) : bridge.get(resource, id, actor);
    },
    async fx(site: BridgeSite, actor: WebsiteBridgeActor) {
      return (await client(site)).fx(actor);
    },
    async payments(site: BridgeSite, range: WebsitePaymentReportQuery, actor: WebsiteBridgeActor) {
      return (await client(site)).payments(range, actor);
    },
    /** A typed commerce write (2c(b)) on the write key. The route has already checked the operation and the actor. */
    async write(site: BridgeSite, method: WebsiteCommerceWriteMethod, path: string, body: Record<string, unknown> | undefined,
      actor: WebsiteBridgeActor, idempotencyKey?: string) {
      return (await commerceClient(site, "write")).write(method, path, body, actor, idempotencyKey);
    },
    /** Records a refund request on the refund_request key. Moves no money. */
    async requestRefund(site: BridgeSite, input: WebsiteCommerceRefundRequestInput, actor: WebsiteBridgeActor, idempotencyKey?: string) {
      return (await commerceClient(site, "refund_request")).requestRefund(input, actor, idempotencyKey);
    },
    /** A person's decision on a refund request. */
    async decideRefund(site: BridgeSite, requestId: string, input: { decision: "approved" | "rejected"; approvalRef: string },
      actor: WebsiteBridgeActor & { type: "user" }, idempotencyKey?: string) {
      return (await commerceClient(site, "refund_request")).decideRefund(requestId, input, actor, idempotencyKey);
    },
  };

  /** Facet's reader (GRE-2324): the site's enquiries, page by page, as the scheduled pull. */
  const enquiryReader: WebsiteEnquiryReader = {
    async listEnquiries(siteId, cursor) {
      const [site] = await db.select().from(websiteSite).where(eq(websiteSite.id, siteId)).limit(1);
      if (!site) throw new WebsiteBridgeError("not_configured", null, "no such site");
      const page = await list(site, "enquiries", { cursor: cursor || undefined, limit: 100 }, ENQUIRY_PULL_ACTOR);
      const items: WebsiteEnquiry[] = page.items.map((raw) => {
        const parsed = enquirySchema.safeParse(raw);
        if (!parsed.success) throw new WebsiteBridgeError("bad_response", 200, `enquiry ${parsed.error.issues[0]?.path.join(".")}`);
        return parsed.data;
      });
      return { items, nextCursor: page.nextCursor };
    },
  };

  return { client, commerceClient, createKey, status, releaseHealth, activityEvents, schemaProbe, list, get, commerce, enquiryReader };
}
export type WebsiteDataBridgeService = ReturnType<typeof websiteDataBridgeService>;
