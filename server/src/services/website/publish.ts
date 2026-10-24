import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { assets, documentRevisions, websiteEntry, websitePage, websiteRelease, websiteSite } from "@greatstone/db";
import type {
  WebsitePendingReason,
  WebsiteRelease,
  WebsiteReleaseActionPlan,
  WebsiteReleaseCheck,
  WebsiteReleaseDeploy,
  WebsiteReleaseKind,
  WebsiteReleaseStatus,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { getStorageService } from "../../storage/index.js";
import { secretService } from "../secrets.js";
import type { SiteRow } from "./module.js";
import { createNetlifyPublishClient, type NetlifyDeploy, type WebsiteNetlifyClient } from "./netlify-publish-client.js";

// Website Publish and rollback (GRE-2108; plan GRE-1831 rev 7 section 3.2;
// ADR GRE-1914 sections 4 and 5).
//
// Publish: build the release, run the checks, take the site's lease, upload
// new Blobs keys only, switch `current`, start ONE content-only rebuild, check
// the live pages and `/_release`, then mark Live. Anything that fails after the
// switch leaves the release Pending with a person-clicked Retry. Rollback takes
// the same path but restores the earlier Netlify deploy (0 credits) unless the
// engine changed or Netlify deleted that deploy, when it rebuilds.
//
// Only a person starts these. Every entry point takes a `WebsitePerson`; the
// routes build it only from a signed-in person's click (never an agent key, a
// board API key, an approval, a routine or a timer). Startup recovery never
// builds, restores or verifies; it only marks rows so a person can Retry.

export type ReleaseRow = typeof websiteRelease.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A person who clicked Publish, Retry or Rollback in GSAM. */
export interface WebsitePerson {
  userId: string;
}

export interface FetchedPage {
  status: number;
  headers: Headers;
  body: string;
}

export interface WebsitePublishOptions {
  netlifyFor?: (site: SiteRow) => Promise<WebsiteNetlifyClient>;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  readAsset?: (companyId: string, objectKey: string) => Promise<Buffer>;
  /** Runs the job after the route has answered. Tests pass a collector and await it. */
  runInBackground?: (job: () => Promise<void>) => void;
  timing?: Partial<PublishTiming>;
}

interface PublishTiming {
  leaseMs: number;
  leaseRenewMs: number;
  deployPollMs: number;
  deployTimeoutMs: number;
  verifyRounds: number;
  verifyDelayMs: number;
}

const DEFAULT_TIMING: PublishTiming = {
  leaseMs: 10 * 60_000,
  leaseRenewMs: 60_000,
  deployPollMs: 5_000,
  // Measured rebuild: 36 s (GRE-1915). Five minutes leaves room for a slow queue.
  deployTimeoutMs: 5 * 60_000,
  verifyRounds: 6,
  verifyDelayMs: 5_000,
};

/** The release file schema GSAM writes (task 0.3 contract). */
export const WEBSITE_RELEASE_SCHEMA = 1;
const CURRENT_KEY = "current";
const RELEASE_HEADER = "x-gsam-release";
const RELEASE_META_RE = /<meta[^>]+name=["']gsam-release["'][^>]*content=["']([^"']+)["']/i;
const RELEASE_META_REVERSED_RE = /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']gsam-release["']/i;

const MEDIA_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function asDeploy(value: unknown): WebsiteReleaseDeploy | null {
  return value && typeof value === "object" ? (value as WebsiteReleaseDeploy) : null;
}

export function toWebsiteRelease(row: ReleaseRow): WebsiteRelease {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    number: row.number,
    kind: row.kind as WebsiteReleaseKind,
    rollbackOfReleaseId: row.rollbackOfReleaseId,
    status: row.status as WebsiteReleaseStatus,
    pendingReason: (row.pendingReason as WebsitePendingReason | null) ?? null,
    blobsKey: row.blobsKey,
    releaseSha256: row.releaseSha256,
    checks: (row.checks ?? []) as WebsiteReleaseCheck[],
    deploy: asDeploy(row.deploy),
    publishedByUserId: row.publishedByUserId,
    switchedAt: row.switchedAt?.toISOString() ?? null,
    liveAt: row.liveAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The release number a live page reports: `x-gsam-release`, `<meta name="gsam-release">` or `/_release` JSON. */
export function reportedRelease(page: FetchedPage): string | null {
  const header = page.headers.get(RELEASE_HEADER);
  if (header) return header.trim();
  const meta = page.body.match(RELEASE_META_RE) ?? page.body.match(RELEASE_META_REVERSED_RE);
  if (meta) return meta[1].trim();
  try {
    const json = JSON.parse(page.body) as { release?: unknown };
    if (json && (typeof json.release === "number" || typeof json.release === "string")) return String(json.release);
  } catch {
    // not JSON
  }
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(body: string | Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function defaultFetchPage(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    headers: { "user-agent": "GSAM-website-publish-verify" },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function defaultRunInBackground(job: () => Promise<void>) {
  void job().catch((err) => logger.error({ err }, "website publish job failed"));
}

export function websitePublishService(db: Db, options: WebsitePublishOptions = {}) {
  const timing: PublishTiming = { ...DEFAULT_TIMING, ...options.timing };
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const runInBackground = options.runInBackground ?? defaultRunInBackground;
  const secrets = secretService(db);

  async function defaultNetlifyFor(site: SiteRow): Promise<WebsiteNetlifyClient> {
    if (!site.netlifyTokenSecretId) throw unprocessable("This site has no Netlify token. Add it in the site settings first.", { code: "website_netlify_token_missing" });
    // Only this site's own token, read for this company (ADR 4.4). Never the shared agent token.
    const token = await secrets.resolveSecretValue(site.companyId, site.netlifyTokenSecretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: `website-publish:${site.id}`,
        configPath: "netlify.token",
        actorType: "system",
      },
    });
    return createNetlifyPublishClient({ netlifySiteId: site.netlifySiteId, storeName: site.blobsStoreName, token });
  }
  const netlifyFor = options.netlifyFor ?? defaultNetlifyFor;

  async function defaultReadAsset(companyId: string, objectKey: string) {
    const object = await getStorageService().getObject(companyId, objectKey);
    return streamToBuffer(object.stream);
  }
  const readAsset = options.readAsset ?? defaultReadAsset;

  // ---- rows ----

  async function getSite(companyId: string, siteId: string) {
    const [row] = await db.select().from(websiteSite).where(and(eq(websiteSite.companyId, companyId), eq(websiteSite.id, siteId)));
    return row ?? null;
  }

  async function getRelease(companyId: string, siteId: string, releaseId: string) {
    const [row] = await db
      .select()
      .from(websiteRelease)
      .where(and(eq(websiteRelease.companyId, companyId), eq(websiteRelease.siteId, siteId), eq(websiteRelease.id, releaseId)));
    return row ?? null;
  }

  async function listReleases(companyId: string, siteId: string) {
    return db
      .select()
      .from(websiteRelease)
      .where(and(eq(websiteRelease.companyId, companyId), eq(websiteRelease.siteId, siteId)))
      .orderBy(desc(websiteRelease.number));
  }

  async function updateRelease(release: Pick<ReleaseRow, "id" | "companyId">, patch: Partial<typeof websiteRelease.$inferInsert>) {
    const [row] = await db
      .update(websiteRelease)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(websiteRelease.companyId, release.companyId), eq(websiteRelease.id, release.id)))
      .returning();
    return row!;
  }

  async function nextNumber(tx: Tx, site: SiteRow) {
    const [row] = await tx
      .select({ max: sql<number>`coalesce(max(${websiteRelease.number}), 0)` })
      .from(websiteRelease)
      .where(and(eq(websiteRelease.companyId, site.companyId), eq(websiteRelease.siteId, site.id)));
    return Number(row?.max ?? 0) + 1;
  }

  // ---- lease and fence (ADR 4.3) ----

  /** Short transaction; `null` when another publish or rollback holds a live lease. */
  async function takeLease(tx: Tx, site: SiteRow, leaseId: string, kind: WebsiteReleaseKind): Promise<number | null> {
    const [row] = await tx
      .update(websiteSite)
      .set({
        publishLeaseId: leaseId,
        publishLeaseKind: kind,
        publishLeaseExpiresAt: sql`now() + ${`${timing.leaseMs} milliseconds`}::interval`,
        publishFence: sql`${websiteSite.publishFence} + 1`,
      })
      .where(
        and(
          eq(websiteSite.companyId, site.companyId),
          eq(websiteSite.id, site.id),
          or(isNull(websiteSite.publishLeaseId), sql`${websiteSite.publishLeaseExpiresAt} < now()`),
        ),
      )
      .returning({ fence: websiteSite.publishFence });
    return row ? Number(row.fence) : null;
  }

  async function busy(site: SiteRow): Promise<never> {
    const fresh = await getSite(site.companyId, site.id);
    throw conflict("A publish is running for this site. Wait for it to finish.", {
      code: "website_publish_running",
      runningReleaseId: fresh?.publishLeaseId ?? null,
      runningKind: fresh?.publishLeaseKind ?? null,
    });
  }

  async function renewLease(site: SiteRow, leaseId: string) {
    await db
      .update(websiteSite)
      .set({ publishLeaseExpiresAt: sql`now() + ${`${timing.leaseMs} milliseconds`}::interval` })
      .where(and(eq(websiteSite.companyId, site.companyId), eq(websiteSite.id, site.id), eq(websiteSite.publishLeaseId, leaseId)));
  }

  /** Releases the lease only if it is still ours: a stale job never frees a newer job's lease. */
  async function releaseLease(site: Pick<SiteRow, "companyId" | "id">, leaseId: string) {
    await db
      .update(websiteSite)
      .set({ publishLeaseId: null, publishLeaseKind: null, publishLeaseExpiresAt: null })
      .where(and(eq(websiteSite.companyId, site.companyId), eq(websiteSite.id, site.id), eq(websiteSite.publishLeaseId, leaseId)));
  }

  class LostLeaseError extends Error {
    constructor() {
      super("This job lost the site's publish lease to a newer publish or rollback.");
    }
  }

  /**
   * Runs `act` (a write to `current`, a build or a restore) only while this job
   * still holds its lease and fence, with the site row locked, so no other
   * job can take the lease and write in between.
   */
  async function fenced<T>(site: SiteRow, leaseId: string, fence: number, act: () => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ leaseId: websiteSite.publishLeaseId, fence: websiteSite.publishFence, expiresAt: websiteSite.publishLeaseExpiresAt })
        .from(websiteSite)
        .where(and(eq(websiteSite.companyId, site.companyId), eq(websiteSite.id, site.id)))
        .for("update");
      if (!row || row.leaseId !== leaseId || Number(row.fence) !== fence || !row.expiresAt || row.expiresAt.getTime() < Date.now()) {
        throw new LostLeaseError();
      }
      return act();
    });
  }

  /** Keeps the lease alive while the job runs; the returned function stops it. */
  function keepLease(site: SiteRow, leaseId: string) {
    const timer = setInterval(() => {
      void renewLease(site, leaseId).catch((err) => logger.warn({ err, siteId: site.id }, "website publish lease renewal failed"));
    }, timing.leaseRenewMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ---- build and checks ----

  interface BuiltRelease {
    manifest: Record<string, unknown>;
    file: string;
    sha256: string;
    checks: WebsiteReleaseCheck[];
    media: Array<{ key: string; objectKey: string; contentType: string }>;
  }

  async function buildRelease(site: SiteRow, number: number): Promise<BuiltRelease> {
    const checks: WebsiteReleaseCheck[] = [];
    const pages = await db
      .select()
      .from(websitePage)
      .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id), isNull(websitePage.archivedAt)))
      .orderBy(asc(websitePage.slug));
    const entries = await db
      .select()
      .from(websiteEntry)
      .where(and(eq(websiteEntry.companyId, site.companyId), eq(websiteEntry.siteId, site.id), isNull(websiteEntry.archivedAt)))
      .orderBy(asc(websiteEntry.collection), sql`${websiteEntry.sortOrder} asc nulls last`, asc(websiteEntry.entryKey));

    // The approved revision; a page with none keeps what is live now; a page with neither is not in the release.
    const releasedPages = pages.flatMap((page) => {
      const revisionId = page.approvedRevisionId ?? page.publishedRevisionId;
      return revisionId ? [{ page, revisionId }] : [];
    });
    const releasedEntries = entries.flatMap((entry) => {
      const revisionId = entry.approvedRevisionId ?? entry.publishedRevisionId;
      return revisionId ? [{ entry, revisionId }] : [];
    });

    const revisionIds = [...releasedPages.map((p) => p.revisionId), ...releasedEntries.map((e) => e.revisionId)];
    const revisions = revisionIds.length
      ? await db
          .select({ id: documentRevisions.id, body: documentRevisions.body })
          .from(documentRevisions)
          .where(and(eq(documentRevisions.companyId, site.companyId), inArray(documentRevisions.id, revisionIds)))
      : [];
    const bodyById = new Map(revisions.map((r) => [r.id, r.body]));
    const badJson: string[] = [];
    const parse = (id: string, label: string) => {
      const body = bodyById.get(id);
      if (body === undefined) {
        badJson.push(label);
        return null;
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        badJson.push(label);
        return null;
      }
    };

    const pageFiles = releasedPages.map(({ page, revisionId }) => ({
      id: page.id,
      slug: page.slug,
      title: page.title,
      parentPageId: page.parentPageId,
      menu: page.menu,
      menuOrder: page.menuOrder,
      navOrder: page.navOrder,
      seo: page.seo ?? {},
      content: parse(revisionId, page.slug),
    }));

    const collections: Record<string, unknown[]> = {};
    const redirects: unknown[] = [];
    const mediaAssetIds: string[] = [];
    for (const { entry, revisionId } of releasedEntries) {
      const fields = parse(revisionId, `${entry.collection}/${entry.entryKey}`);
      const item = { id: entry.id, key: entry.entryKey, orgId: entry.orgId, sortOrder: entry.sortOrder, fields };
      (collections[entry.collection] ??= []).push(item);
      if (entry.collection === "redirect") redirects.push(fields);
      if (entry.collection === "media" && fields && typeof (fields as { assetId?: unknown }).assetId === "string") {
        mediaAssetIds.push((fields as { assetId: string }).assetId);
      }
    }

    const mediaRows = mediaAssetIds.length
      ? await db
          .select({ id: assets.id, objectKey: assets.objectKey, contentType: assets.contentType, sha256: assets.sha256, originalFilename: assets.originalFilename })
          .from(assets)
          .where(and(eq(assets.companyId, site.companyId), inArray(assets.id, mediaAssetIds)))
      : [];
    const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
    const media: Record<string, string> = {};
    const mediaUploads: BuiltRelease["media"] = [];
    const missingMedia: string[] = [];
    for (const assetId of new Set(mediaAssetIds)) {
      const row = mediaById.get(assetId);
      if (!row) {
        missingMedia.push(assetId);
        continue;
      }
      const fromName = row.originalFilename?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
      const ext = MEDIA_EXT[row.contentType] ?? fromName ?? "bin";
      const key = `media/${row.sha256}.${ext}`;
      media[assetId] = key;
      mediaUploads.push({ key, objectKey: row.objectKey, contentType: row.contentType });
    }

    // Hard checks before anything is uploaded. Broken links, SEO, accessibility
    // and voice checks join this list in Phase 3.6.
    checks.push(
      site.releaseSchemaVersion === WEBSITE_RELEASE_SCHEMA
        ? { kind: "check", name: "release_schema", ok: true }
        : { kind: "check", name: "release_schema", ok: false, message: `GSAM writes release schema ${WEBSITE_RELEASE_SCHEMA}; this site's engine expects ${site.releaseSchemaVersion}.` },
    );
    checks.push(
      pageFiles.length > 0
        ? { kind: "check", name: "has_pages", ok: true }
        : { kind: "check", name: "has_pages", ok: false, message: "No page is approved yet, so there is nothing to publish." },
    );
    checks.push(
      badJson.length === 0
        ? { kind: "check", name: "content_json", ok: true }
        : { kind: "check", name: "content_json", ok: false, message: `These items have content that is not valid JSON: ${badJson.join(", ")}.` },
    );
    checks.push(
      missingMedia.length === 0
        ? { kind: "check", name: "media_assets", ok: true }
        : { kind: "check", name: "media_assets", ok: false, message: `${missingMedia.length} image(s) are not in this company's files.` },
    );
    const badPaths = site.checkPaths.filter((p) => typeof p !== "string" || !p.startsWith("/"));
    checks.push(
      site.checkPaths.length > 0 && badPaths.length === 0
        ? { kind: "check", name: "check_paths", ok: true }
        : { kind: "check", name: "check_paths", ok: false, message: "The site needs check pages (paths that start with /) before it can publish." },
    );

    const theme = site.theme ?? {};
    const file = stableJson({
      schema: WEBSITE_RELEASE_SCHEMA,
      siteId: site.id,
      orgId: null,
      release: number,
      theme,
      pages: pageFiles,
      collections,
      redirects,
      media,
    });
    const manifest = {
      pages: releasedPages.map(({ page, revisionId }) => ({ pageId: page.id, revisionId })),
      entries: releasedEntries.map(({ entry, revisionId }) => ({ entryId: entry.id, revisionId })),
      themeHash: sha256(stableJson(theme)),
      mediaKeys: mediaUploads.map((m) => m.key),
    };
    return { manifest, file, sha256: sha256(file), checks, media: mediaUploads };
  }

  // ---- serve (build or restore) and verify ----

  async function waitForDeploy(release: ReleaseRow, netlify: WebsiteNetlifyClient, deploy: WebsiteReleaseDeploy): Promise<ReleaseRow> {
    const started = Date.now();
    let current = deploy;
    let row = release;
    for (;;) {
      let found: NetlifyDeploy | null = null;
      try {
        found = current.deployId ? await netlify.getDeploy(current.deployId) : await netlify.findProductionDeploySince(new Date(current.requestedAt));
      } catch (err) {
        logger.warn({ err, releaseId: release.id }, "website publish could not read the Netlify deploy; trying again");
      }
      if (found) {
        current = { ...current, deployId: found.id, commitRef: found.commitRef, state: found.state, errorMessage: found.errorMessage };
        row = await updateRelease(row, { deploy: current as unknown as Record<string, unknown> });
        if (found.state !== "building") return row;
      }
      if (Date.now() - started >= timing.deployTimeoutMs) return row;
      await sleep(timing.deployPollMs);
    }
  }

  async function expectedReleaseNumber(release: ReleaseRow) {
    if (release.kind !== "rollback" || !release.rollbackOfReleaseId) return release.number;
    const target = await getRelease(release.companyId, release.siteId, release.rollbackOfReleaseId);
    return target?.number ?? release.number;
  }

  async function verify(site: SiteRow, expected: number) {
    const paths = [...site.checkPaths, "/_release"];
    let results: WebsiteReleaseCheck[] = [];
    for (let round = 0; round < timing.verifyRounds; round += 1) {
      if (round > 0) await sleep(timing.verifyDelayMs);
      results = await Promise.all(
        paths.map(async (path): Promise<WebsiteReleaseCheck> => {
          try {
            const page = await fetchPage(`https://${site.domain}${path}`);
            const seen = reportedRelease(page);
            if (page.status >= 400) return { kind: "verify", name: path, ok: false, message: `${path} answered ${page.status}.` };
            if (seen !== String(expected)) return { kind: "verify", name: path, ok: false, message: `${path} shows release ${seen ?? "unknown"}, not ${expected}.` };
            return { kind: "verify", name: path, ok: true };
          } catch {
            return { kind: "verify", name: path, ok: false, message: `${path} did not answer.` };
          }
        }),
      );
      if (results.every((r) => r.ok)) return { ok: true, results };
    }
    return { ok: false, results };
  }

  /** One transaction: this release Live, the old Live superseded, pages and entries marked published. */
  async function goLive(site: SiteRow, release: ReleaseRow, checks: WebsiteReleaseCheck[]) {
    const manifest = release.manifest as { pages?: Array<{ pageId: string; revisionId: string }>; entries?: Array<{ entryId: string; revisionId: string }> };
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(websiteRelease)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(websiteRelease.companyId, site.companyId),
            eq(websiteRelease.siteId, site.id),
            ne(websiteRelease.id, release.id),
            inArray(websiteRelease.status, ["live", "pending", "switched"]),
          ),
        );
      await tx
        .update(websiteRelease)
        .set({ status: "live", liveAt: now, pendingReason: null, checks, updatedAt: now })
        .where(and(eq(websiteRelease.companyId, site.companyId), eq(websiteRelease.id, release.id)));
      await tx.update(websiteSite).set({ liveReleaseId: release.id, updatedAt: now }).where(and(eq(websiteSite.companyId, site.companyId), eq(websiteSite.id, site.id)));

      const pageRevs = manifest.pages ?? [];
      const entryRevs = manifest.entries ?? [];
      await tx
        .update(websitePage)
        .set({ publishedRevisionId: null, updatedAt: now })
        .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id)));
      for (const { pageId, revisionId } of pageRevs) {
        await tx
          .update(websitePage)
          .set({
            publishedRevisionId: revisionId,
            // Only a page still approved at the revision we shipped becomes published; newer edits keep their status.
            status: sql`case when ${websitePage.status} = 'approved' and ${websitePage.approvedRevisionId} = ${revisionId} then 'published' else ${websitePage.status} end`,
            updatedAt: now,
          })
          .where(and(eq(websitePage.companyId, site.companyId), eq(websitePage.siteId, site.id), eq(websitePage.id, pageId)));
      }
      await tx
        .update(websiteEntry)
        .set({ publishedRevisionId: null, updatedAt: now })
        .where(and(eq(websiteEntry.companyId, site.companyId), eq(websiteEntry.siteId, site.id)));
      for (const { entryId, revisionId } of entryRevs) {
        await tx
          .update(websiteEntry)
          .set({
            publishedRevisionId: revisionId,
            status: sql`case when ${websiteEntry.status} = 'approved' and ${websiteEntry.approvedRevisionId} = ${revisionId} then 'published' else ${websiteEntry.status} end`,
            updatedAt: now,
          })
          .where(and(eq(websiteEntry.companyId, site.companyId), eq(websiteEntry.siteId, site.id), eq(websiteEntry.id, entryId)));
      }
    });
  }

  async function pending(release: ReleaseRow, reason: WebsitePendingReason, checks?: WebsiteReleaseCheck[]) {
    return updateRelease(release, { status: "pending", pendingReason: reason, ...(checks ? { checks } : {}) });
  }

  /**
   * After the switch: make Netlify serve the release (`build`, `restore`, or
   * `verify` = wait for the deploy already made), then check the live pages.
   * Ends Live or Pending, never with no next step.
   */
  async function serveAndVerify(input: {
    site: SiteRow;
    release: ReleaseRow;
    leaseId: string;
    fence: number;
    action: WebsiteReleaseActionPlan["action"];
    restoreDeployId?: string | null;
  }) {
    const { site, leaseId, fence } = input;
    let release = input.release;
    const netlify = await netlifyFor(site);
    const priorChecks = ((release.checks ?? []) as WebsiteReleaseCheck[]).filter((c) => c.kind === "check");

    if (input.action === "build") {
      // Record the request before the call: after a crash, Retry finds this build instead of starting a second one.
      let deploy: WebsiteReleaseDeploy = { method: "build", requestedAt: new Date().toISOString(), deployId: null, commitRef: null, state: "requested" };
      release = await updateRelease(release, { deploy: deploy as unknown as Record<string, unknown> });
      const started = await fenced(site, leaseId, fence, () => netlify.startBuild());
      deploy = { ...deploy, deployId: started.deployId, state: "building" };
      release = await updateRelease(release, { deploy: deploy as unknown as Record<string, unknown> });
    } else if (input.action === "restore") {
      const deployId = input.restoreDeployId;
      if (!deployId) throw new Error("restore needs a deploy id");
      const requestedAt = new Date().toISOString();
      const restored = await fenced(site, leaseId, fence, () => netlify.restoreDeploy(deployId));
      const deploy: WebsiteReleaseDeploy = { method: "restore", requestedAt, deployId: restored.id, commitRef: restored.commitRef, state: restored.state };
      release = await updateRelease(release, { deploy: deploy as unknown as Record<string, unknown> });
    }

    const deploy = asDeploy(release.deploy);
    if (!deploy) return pending(release, "build_not_started");
    if (deploy.state !== "ready") {
      release = await waitForDeploy(release, netlify, deploy);
      const after = asDeploy(release.deploy);
      if (after?.state === "error") return pending(release, "build_failed");
      if (after?.state !== "ready") return pending(release, "build_timeout");
    }

    const expected = await expectedReleaseNumber(release);
    const result = await verify(site, expected);
    const checks = [...priorChecks, ...result.results];
    if (!result.ok) return pending(release, "verify_failed", checks);
    await goLive(site, release, checks);
    return (await getRelease(release.companyId, release.siteId, release.id))!;
  }

  // ---- the publish job ----

  async function writeCurrent(site: SiteRow, netlify: WebsiteNetlifyClient, leaseId: string, fence: number, target: { number: number; blobsKey: string; sha256: string }) {
    const current = {
      schema: 1,
      release: target.number,
      key: target.blobsKey,
      sha256: target.sha256,
      switchedAt: new Date().toISOString(),
      fence,
    };
    await fenced(site, leaseId, fence, () => netlify.putBlob(CURRENT_KEY, JSON.stringify(current), "application/json"));
  }

  /** At the switch, an older Pending release can no longer go live. */
  async function supersedeOtherPending(site: SiteRow, releaseId: string) {
    await db
      .update(websiteRelease)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(websiteRelease.companyId, site.companyId),
          eq(websiteRelease.siteId, site.id),
          ne(websiteRelease.id, releaseId),
          inArray(websiteRelease.status, ["pending", "switched"]),
        ),
      );
  }

  async function runPublish(site: SiteRow, releaseId: string, fence: number) {
    const stop = keepLease(site, releaseId);
    let release = (await getRelease(site.companyId, site.id, releaseId))!;
    try {
      let netlify: WebsiteNetlifyClient;
      try {
        const built = await buildRelease(site, release.number);
        release = await updateRelease(release, { manifest: built.manifest, checks: built.checks, releaseSha256: built.sha256 });
        if (built.checks.some((c) => !c.ok)) {
          await updateRelease(release, { status: "checks_failed", failedAt: new Date() });
          return;
        }
        release = await updateRelease(release, { status: "uploading" });
        netlify = await netlifyFor(site);
        // New keys only: media by content hash, then the release file. A half-done upload changes nothing.
        for (const item of built.media) {
          if (await netlify.blobExists(item.key)) continue;
          await netlify.putBlob(item.key, await readAsset(site.companyId, item.objectKey), item.contentType);
        }
        const blobsKey = `releases/${release.number}.json`;
        if (!(await netlify.blobExists(blobsKey))) await netlify.putBlob(blobsKey, built.file, "application/json");
        await writeCurrent(site, netlify, releaseId, fence, { number: release.number, blobsKey, sha256: built.sha256 });
        release = await updateRelease(release, { status: "switched", blobsKey, switchedAt: new Date() });
        await supersedeOtherPending(site, releaseId);
      } catch (err) {
        // Before the switch nothing live changed; the person publishes again.
        logger.warn({ err, releaseId }, "website publish failed before the switch");
        await updateRelease(release, { status: "failed", failedAt: new Date(), pendingReason: null });
        return;
      }
      await afterSwitch(site, release, releaseId, fence, "build");
    } finally {
      stop();
      await releaseLease(site, releaseId);
    }
  }

  /** After `current` moved, every error ends Pending (with Retry), except a lost lease, which ends failed. */
  async function afterSwitch(site: SiteRow, release: ReleaseRow, leaseId: string, fence: number, action: WebsiteReleaseActionPlan["action"], restoreDeployId?: string | null) {
    try {
      await serveAndVerify({ site, release, leaseId, fence, action, restoreDeployId });
    } catch (err) {
      const fresh = (await getRelease(release.companyId, release.siteId, release.id)) ?? release;
      if (err instanceof LostLeaseError) {
        logger.warn({ releaseId: release.id }, "website publish job lost its lease; stopping");
        await updateRelease(fresh, { status: "failed", failedAt: new Date() });
        return;
      }
      logger.warn({ err, releaseId: release.id }, "website publish could not finish after the switch");
      const deploy = asDeploy(fresh.deploy);
      await pending(fresh, deploy?.state === "ready" ? "verify_failed" : deploy ? "build_failed" : "build_not_started");
    }
  }

  // ---- entry points (a person's click only) ----

  async function startPublish(site: SiteRow, person: WebsitePerson) {
    if (!site.netlifyTokenSecretId) throw unprocessable("This site has no Netlify token. Add it in the site settings first.", { code: "website_netlify_token_missing" });
    if (site.archivedAt) throw unprocessable("This site is archived.", { code: "website_site_archived" });
    const releaseId = randomUUID();
    const started = await db.transaction(async (tx) => {
      const fence = await takeLease(tx, site, releaseId, "publish");
      if (fence === null) return null;
      const number = await nextNumber(tx, site);
      const [row] = await tx
        .insert(websiteRelease)
        .values({
          id: releaseId,
          companyId: site.companyId,
          siteId: site.id,
          number,
          kind: "publish",
          manifest: {},
          status: "building",
          requestedByUserId: person.userId,
          publishedByUserId: person.userId,
        })
        .returning();
      return { row: row!, fence };
    });
    if (!started) return busy(site);
    runInBackground(() => runPublish(site, releaseId, started.fence));
    return started.row;
  }

  /** Reads the deploy's latest state from Netlify (a build may have finished since). */
  async function refreshDeploy(site: SiteRow, release: ReleaseRow) {
    const deploy = asDeploy(release.deploy);
    if (!deploy || deploy.state === "ready" || deploy.state === "error") return release;
    const netlify = await netlifyFor(site);
    const found = deploy.deployId ? await netlify.getDeploy(deploy.deployId) : await netlify.findProductionDeploySince(new Date(deploy.requestedAt));
    if (!found) return release;
    const next: WebsiteReleaseDeploy = { ...deploy, deployId: found.id, commitRef: found.commitRef, state: found.state, errorMessage: found.errorMessage };
    return updateRelease(release, { deploy: next as unknown as Record<string, unknown> });
  }

  /** Retry case A (the build worked: check again, free) or case B (the build failed: one new build, about 15 credits). */
  async function retryPlan(site: SiteRow, release: ReleaseRow): Promise<{ plan: WebsiteReleaseActionPlan; release: ReleaseRow }> {
    if (release.status !== "pending") throw conflict("Only a Pending release can be retried.", { code: "website_release_not_pending", status: release.status });
    const fresh = await refreshDeploy(site, release);
    const deploy = asDeploy(fresh.deploy);
    if (deploy && deploy.state !== "error" && (deploy.deployId || deploy.state === "ready")) {
      return { release: fresh, plan: { action: "verify", costsCredits: false, reason: deploy.state === "ready" ? "The rebuild worked. Retry checks the live pages again." : "The rebuild is still running. Retry waits for it, then checks the live pages." } };
    }
    return {
      release: fresh,
      plan: { action: "build", costsCredits: true, reason: deploy ? "The rebuild failed. Retry starts one new rebuild." : "The rebuild did not start. Retry starts it." },
    };
  }

  async function retry(site: SiteRow, release: ReleaseRow, person: WebsitePerson, confirmRebuild: boolean) {
    const { plan, release: fresh } = await retryPlan(site, release);
    if (plan.costsCredits && !confirmRebuild) {
      throw conflict("Retry would start a new rebuild (about 15 credits). Confirm the rebuild to go on.", { code: "website_rebuild_needs_confirm", plan });
    }
    const fence = await db.transaction((tx) => takeLease(tx, site, fresh.id, fresh.kind as WebsiteReleaseKind));
    if (fence === null) return busy(site);
    const row = await updateRelease(fresh, { publishedByUserId: fresh.publishedByUserId ?? person.userId });
    runInBackground(async () => {
      const stop = keepLease(site, fresh.id);
      try {
        await afterSwitch(site, row, fresh.id, fence, plan.action);
      } finally {
        stop();
        await releaseLease(site, fresh.id);
      }
    });
    return { release: row, plan };
  }

  /** The release a rollback can go back to: once Live, with its file in Blobs. */
  async function assertRollbackTarget(site: SiteRow, target: ReleaseRow) {
    if (!target.liveAt || !target.blobsKey || !target.releaseSha256) {
      throw conflict("Only a release that was Live can be brought back.", { code: "website_rollback_target_invalid" });
    }
    if (target.id === site.liveReleaseId) {
      const [newer] = await db
        .select({ id: websiteRelease.id })
        .from(websiteRelease)
        .where(and(eq(websiteRelease.companyId, site.companyId), eq(websiteRelease.siteId, site.id), inArray(websiteRelease.status, ["pending", "switched"])))
        .limit(1);
      if (!newer) throw conflict("This release is already Live.", { code: "website_rollback_target_live" });
    }
  }

  /** Restore the earlier deploy (0 credits) unless the engine changed since or Netlify deleted it. */
  async function rollbackPlan(site: SiteRow, target: ReleaseRow): Promise<{ plan: WebsiteReleaseActionPlan; restoreDeployId: string | null }> {
    await assertRollbackTarget(site, target);
    const deploy = asDeploy(target.deploy);
    const rebuild = (reason: string) => ({ plan: { action: "build" as const, costsCredits: true, reason }, restoreDeployId: null });
    if (!deploy?.deployId || deploy.state !== "ready") return rebuild("GSAM has no finished deploy for that release, so it must rebuild it.");
    const netlify = await netlifyFor(site);
    const kept = await netlify.getDeploy(deploy.deployId);
    if (!kept || kept.state !== "ready") return rebuild("Netlify no longer keeps that deploy, so GSAM must rebuild it.");
    const live = await netlify.publishedDeploy();
    const keptCommit = kept.commitRef ?? deploy.commitRef;
    if (!live?.commitRef || !keptCommit || live.commitRef !== keptCommit) {
      return rebuild("The site's code changed since that release. Putting the old deploy back would undo code fixes, so GSAM rebuilds it with today's code.");
    }
    return { plan: { action: "restore", costsCredits: false, reason: "GSAM puts that release's deploy back. This takes a few seconds and uses no credits." }, restoreDeployId: kept.id };
  }

  async function rollback(site: SiteRow, target: ReleaseRow, person: WebsitePerson, confirmRebuild: boolean) {
    const { plan, restoreDeployId } = await rollbackPlan(site, target);
    if (plan.costsCredits && !confirmRebuild) {
      throw conflict("This rollback needs a rebuild (about 15 credits). Confirm the rebuild to go on.", { code: "website_rebuild_needs_confirm", plan });
    }
    const netlify = await netlifyFor(site);
    // The release file is kept for ever; this guards the case it is not.
    if (!(await netlify.blobExists(target.blobsKey!))) {
      throw conflict(`GSAM cannot find the file for release ${target.number}, so it cannot bring it back.`, { code: "website_rollback_file_missing" });
    }
    const releaseId = randomUUID();
    const started = await db.transaction(async (tx) => {
      const fence = await takeLease(tx, site, releaseId, "rollback");
      if (fence === null) return null;
      const number = await nextNumber(tx, site);
      const [row] = await tx
        .insert(websiteRelease)
        .values({
          id: releaseId,
          companyId: site.companyId,
          siteId: site.id,
          number,
          kind: "rollback",
          rollbackOfReleaseId: target.id,
          manifest: target.manifest,
          blobsKey: target.blobsKey,
          releaseSha256: target.releaseSha256,
          status: "building",
          requestedByUserId: person.userId,
          publishedByUserId: person.userId,
        })
        .returning();
      return { row: row!, fence };
    });
    if (!started) return busy(site);

    runInBackground(async () => {
      const stop = keepLease(site, releaseId);
      let release = started.row;
      try {
        try {
          await writeCurrent(site, netlify, releaseId, started.fence, { number: target.number, blobsKey: target.blobsKey!, sha256: target.releaseSha256! });
        } catch (err) {
          logger.warn({ err, releaseId }, "website rollback could not switch current");
          await updateRelease(release, { status: "failed", failedAt: new Date() });
          return;
        }
        release = await updateRelease(release, { status: "switched", switchedAt: new Date() });
        await supersedeOtherPending(site, releaseId);
        await afterSwitch(site, release, releaseId, started.fence, plan.action, restoreDeployId);
      } finally {
        stop();
        await releaseLease(site, releaseId);
      }
    });
    return { release: started.row, plan };
  }

  /**
   * ADR 4.2, on server start: nothing is rebuilt, restored or checked here.
   * `building`/`uploading` → failed (nothing live changed); `switched` →
   * Pending "server restarted" so a person can Retry; their leases are freed.
   */
  async function recoverOnStartup(input: { untouchedSince?: Date } = {}) {
    // The listener is up before this runs, so only rows the previous process
    // last wrote are recovered; a Publish clicked since boot is left alone.
    const untouchedSince = input.untouchedSince ?? new Date(Date.now() - process.uptime() * 1000);
    const rows = await db
      .select()
      .from(websiteRelease)
      .where(
        and(
          inArray(websiteRelease.status, ["building", "uploading", "switched", "pending"]),
          sql`${websiteRelease.updatedAt} < ${untouchedSince.toISOString()}::timestamptz`,
        ),
      );
    let failed = 0;
    let pendingCount = 0;
    for (const row of rows) {
      if (row.status === "building" || row.status === "uploading") {
        await updateRelease(row, { status: "failed", failedAt: new Date() });
        failed += 1;
      } else if (row.status === "switched") {
        await updateRelease(row, { status: "pending", pendingReason: "server_restarted" });
        pendingCount += 1;
      }
      await releaseLease({ companyId: row.companyId, id: row.siteId }, row.id);
    }
    return { failed, pending: pendingCount };
  }

  return {
    getSite,
    getRelease,
    listReleases,
    startPublish,
    retryPlan,
    retry,
    rollbackPlan,
    rollback,
    recoverOnStartup,
  };
}
