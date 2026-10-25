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
  WebsiteCommerceResource,
  WebsiteDataBridgeKey,
  WebsiteDataBridgeStatus,
  WebsiteDataResource,
  WebsitePaymentReportQuery,
} from "@greatstone/shared";
import { secretService } from "../secrets.js";
import type { WebsiteEnquiry, WebsiteEnquiryReader } from "./enquiries.js";
import {
  WebsiteBridgeError,
  createWebsiteBridgeClient,
  parseBridgeCredential,
  type WebsiteBridgeActor,
  type WebsiteBridgeClient,
} from "./data-bridge-client.js";

type BridgeSite = Pick<typeof websiteSite.$inferSelect,
  "id" | "companyId" | "domain" | "dataBridgeUrl" | "dataBridgeReadKeyId" | "dataBridgeReadSecretId">;

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

  async function client(site: BridgeSite) {
    if (!site.dataBridgeReadSecretId) throw new WebsiteBridgeError("not_configured");
    // Read for this site only, as a system consumer, so each use is an access event like the publish token's (ADR 4.4).
    const value = await secrets.resolveSecretValue(site.companyId, site.dataBridgeReadSecretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: `website-data-bridge:${site.id}`,
        configPath: "dataBridge.readKey",
        actorType: "system",
      },
    }).catch((error: unknown) => {
      throw new WebsiteBridgeError("not_configured", null, error instanceof Error ? error.message : "the read key is unavailable");
    });
    return clientFor(site, value);
  }

  /** Makes a new read key pair for the site. Returns the public half only; the private half goes to the vault. */
  async function createReadKey(site: BridgeSite, input: { environment: "stg" | "live"; url?: string | null }, userId: string | null): Promise<WebsiteDataBridgeKey> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const month = new Date(now()).toISOString().slice(0, 7);
    const kid = `${input.environment}-read-${month}-${randomBytes(3).toString("hex")}`;
    const value = JSON.stringify({ kid, privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString() });
    const existing = site.dataBridgeReadSecretId ? await secrets.getById(site.dataBridgeReadSecretId) : null;
    let secretId: string;
    if (existing && existing.status === "active" && existing.companyId === site.companyId) {
      await secrets.rotate(existing.id, { value }, { userId });
      secretId = existing.id;
    } else {
      const base = `Website data bridge read key ${site.id.slice(0, 8)}`;
      let name = base;
      for (let n = 2; await secrets.getByName(site.companyId, name); n += 1) name = `${base} ${n}`;
      const created = await secrets.create(site.companyId, {
        name,
        provider: "local_encrypted",
        value,
        description: `Ed25519 read key GSAM signs ${site.domain}'s admin bridge calls with (GRE-2323). Read only; never shared.`,
      }, { userId });
      secretId = created.id;
    }
    await db.update(websiteSite).set({
      dataBridgeReadKeyId: kid,
      dataBridgeReadSecretId: secretId,
      ...(input.url !== undefined ? { dataBridgeUrl: input.url } : {}),
      updatedAt: new Date(now()),
    }).where(eq(websiteSite.id, site.id));
    statusCache.delete(site.id);
    const raw = publicKey.export({ format: "jwk" }).x as string;
    return { keyId: kid, capability: "read", publicKey: raw, keysEntry: { kid, capability: "read", publicKey: raw } };
  }

  async function status(site: BridgeSite): Promise<WebsiteDataBridgeStatus> {
    const url = bridgeUrlOf(site);
    if (!site.dataBridgeReadSecretId || !site.dataBridgeReadKeyId) {
      return { state: "not_set_up", keyId: null, url, checkedAt: null, message: null, clockSkewSeconds: null };
    }
    const cached = statusCache.get(site.id);
    if (cached && cached.keyId === site.dataBridgeReadKeyId && now() - cached.at < STATUS_TTL_MS) return cached.value;
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
    return value;
  }

  async function list(site: BridgeSite, resource: WebsiteDataResource,
    filters: { customer?: string; updatedSince?: string; cursor?: string; limit?: number }, actor: WebsiteBridgeActor) {
    return (await client(site)).list(resource, filters, actor);
  }

  async function get(site: BridgeSite, resource: WebsiteDataResource, id: string, actor: WebsiteBridgeActor) {
    return (await client(site)).get(resource, id, actor);
  }

  /** Commerce reads (GRE-2354 2c(a)): the same read key and the same audit on the site. */
  const commerce = {
    async list(site: BridgeSite, resource: WebsiteCommerceResource, filters: WebsiteCommerceListQuery, actor: WebsiteBridgeActor) {
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

  return { createReadKey, status, list, get, commerce, enquiryReader };
}
export type WebsiteDataBridgeService = ReturnType<typeof websiteDataBridgeService>;
