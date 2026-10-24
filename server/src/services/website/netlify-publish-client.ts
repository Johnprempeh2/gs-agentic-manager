// Netlify calls the website publish job makes (GRE-2108, ADR GRE-1914
// sections 4 and 5). One client per site, built with that site's own token.
// The job only sees this interface, so tests use a fake and count deploys.

export type NetlifyDeployState = "building" | "ready" | "error";

export interface NetlifyDeploy {
  id: string;
  state: NetlifyDeployState;
  /** Engine commit the deploy was built from. */
  commitRef: string | null;
  createdAt: string | null;
  errorMessage: string | null;
}

export interface WebsiteNetlifyClient {
  blobExists(key: string): Promise<boolean>;
  putBlob(key: string, body: Buffer | string, contentType: string): Promise<void>;
  /** Content-only rebuild of the production branch: one production deploy, about 15 credits. */
  startBuild(): Promise<{ deployId: string | null }>;
  /** `null` when Netlify no longer has the deploy (404). */
  getDeploy(deployId: string): Promise<NetlifyDeploy | null>;
  /** Newest production deploy created at or after `since`; finds a build whose id was lost in a restart. */
  findProductionDeploySince(since: Date): Promise<NetlifyDeploy | null>;
  /** The deploy production serves now. */
  publishedDeploy(): Promise<NetlifyDeploy | null>;
  /** Publish an earlier deploy again. Not a new build: 0 credits. */
  restoreDeploy(deployId: string): Promise<NetlifyDeploy>;
}

export class NetlifyApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "NetlifyApiError";
  }
}

const API = "https://api.netlify.com";
/** Builds, restores and `current` writes run with the site row locked (the fence), so no call may hang. */
const CALL_TIMEOUT_MS = 30_000;
const SITE_STORE_PREFIX = "site:";

const READY_STATES = new Set(["ready"]);
const ERROR_STATES = new Set(["error", "rejected", "cancelled", "canceled"]);

function deployState(state: unknown): NetlifyDeployState {
  const value = typeof state === "string" ? state : "";
  if (READY_STATES.has(value)) return "ready";
  if (ERROR_STATES.has(value)) return "error";
  return "building";
}

function toDeploy(raw: Record<string, unknown>): NetlifyDeploy {
  return {
    id: String(raw.id),
    state: deployState(raw.state),
    commitRef: typeof raw.commit_ref === "string" && raw.commit_ref ? raw.commit_ref : null,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    errorMessage: typeof raw.error_message === "string" ? raw.error_message : null,
  };
}

function encodeKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * The Netlify REST API, as `@netlify/blobs` uses it from outside Netlify
 * (Summit's GRE-1915 proof wrote Blobs this way): a site store is
 * `site:<name>`, and reads and writes go through a signed URL.
 */
export function createNetlifyPublishClient(input: {
  netlifySiteId: string;
  storeName: string;
  token: string;
  fetchImpl?: typeof fetch;
}): WebsiteNetlifyClient {
  const baseFetch = input.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (url, init) => baseFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const site = encodeURIComponent(input.netlifySiteId);
  const auth = { authorization: `Bearer ${input.token}` };
  const blobPath = (key: string) =>
    `${API}/api/v1/blobs/${site}/${encodeURIComponent(`${SITE_STORE_PREFIX}${input.storeName}`)}/${encodeKey(key)}`;

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetchImpl(`${API}/api/v1${path}`, {
      ...init,
      headers: { ...auth, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return res;
  }

  async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await api(path, init);
    if (!res.ok) throw new NetlifyApiError(`Netlify ${init.method ?? "GET"} ${path.split("?")[0]} answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  return {
    async blobExists(key) {
      const res = await fetchImpl(blobPath(key), { method: "HEAD", headers: auth });
      if (res.status === 404) return false;
      if (!res.ok) throw new NetlifyApiError(`Netlify Blobs HEAD answered ${res.status}`, res.status);
      return true;
    },

    async putBlob(key, body, contentType) {
      const signed = await fetchImpl(blobPath(key), {
        method: "PUT",
        headers: { ...auth, accept: "application/json;type=signed-url" },
      });
      if (signed.status !== 200) throw new NetlifyApiError(`Netlify Blobs sign answered ${signed.status}`, signed.status);
      const { url } = (await signed.json()) as { url?: string };
      if (!url) throw new NetlifyApiError("Netlify Blobs gave no upload URL", null);
      const put = await fetchImpl(url, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: typeof body === "string" ? body : new Uint8Array(body),
      });
      if (!put.ok) throw new NetlifyApiError(`Netlify Blobs upload answered ${put.status}`, put.status);
    },

    async startBuild() {
      const build = await apiJson<Record<string, unknown>>(`/sites/${site}/builds`, { method: "POST", body: "{}" });
      return { deployId: typeof build.deploy_id === "string" ? build.deploy_id : null };
    },

    async getDeploy(deployId) {
      const res = await api(`/deploys/${encodeURIComponent(deployId)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new NetlifyApiError(`Netlify GET deploy answered ${res.status}`, res.status);
      return toDeploy((await res.json()) as Record<string, unknown>);
    },

    async findProductionDeploySince(since) {
      const rows = await apiJson<Array<Record<string, unknown>>>(`/sites/${site}/deploys?per_page=10&production=true`);
      const found = rows
        .filter((row) => row.context === "production" || row.context === undefined)
        .filter((row) => typeof row.created_at === "string" && Date.parse(row.created_at) >= since.getTime() - 5_000)
        .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
      return found[0] ? toDeploy(found[0]) : null;
    },

    async publishedDeploy() {
      const row = await apiJson<Record<string, unknown>>(`/sites/${site}`);
      const published = row.published_deploy as Record<string, unknown> | null | undefined;
      return published && published.id ? toDeploy(published) : null;
    },

    async restoreDeploy(deployId) {
      const row = await apiJson<Record<string, unknown>>(`/sites/${site}/deploys/${encodeURIComponent(deployId)}/restore`, { method: "POST" });
      return toDeploy(row);
    },
  };
}
