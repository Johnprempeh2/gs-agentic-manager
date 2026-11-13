// The lean Deploy (John, 11 Nov 2026). greatstoneint.com changes only when John presses Deploy or Roll back on the
// Website module. GSAM reads what staging serves and what is live, signs a 15-minute, single-use ticket for exactly
// that, and starts the website repo's production workflow (deploy-production.yml) with it. The workflow holds the
// public site's Netlify token in its protected `production` environment and runs deploy-site.mjs, which checks the
// ticket, builds that commit with that content release, checks the live site and puts the old one back on failure.
// GSAM never holds a token that is meant to deploy the public site, and no agent has a part in it.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type { WebsiteProductionRun, WebsiteProductionStatus } from "@greatstone/shared";
import { netlifyBlobUrl } from "./netlify-publish-client.js";
import { lastGuardedCommit, STAGING_NETLIFY_SITE_ID, WEBSITE_REPO } from "./deploy-changes.js";
import { deployBlockers } from "./deploy-readiness.js";
import type { secretService } from "../secrets.js";

export const PRODUCTION_WORKFLOW = "deploy-production.yml";
export const TICKET_LIFETIME_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 15_000;
// Netlify reads can stall while a sleeping site or its database wakes (credits fix, 12 Nov): allow longer, retry once.
const NETLIFY_TIMEOUT_MS = 30_000;
export async function retryOnce<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    return read();
  }
}

export type ProductionTokens = { netlifySiteId: string; netlifyToken: string; githubToken: string; storeName: string };

export type DeployTicket =
  | { action: "deploy"; sha: string; release: number; sha256: string }
  | { action: "rollback"; deployId: string };

/** A ticket as deploy-ticket.mjs checks it: `<base64url JSON>.<base64url Ed25519 signature over the first part>`. */
export function signDeployTicket(privateKey: KeyObject, fields: DeployTicket, by: string, now = Date.now()) {
  const id = randomUUID();
  const body = Buffer.from(JSON.stringify({ v: 1, site: "greatstone-home", id, exp: now + TICKET_LIFETIME_MS, by, ...fields })).toString("base64url");
  return { id, ticket: `${body}.${sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64url")}` };
}

/** The public half as the GitHub variable takes it: the raw 32-byte key, base64url. */
export function rawPublicKey(privateKey: KeyObject) {
  return createPublicKey(privateKey).export({ format: "jwk" }).x as string;
}

type Secrets = ReturnType<typeof secretService>;

export const SIGNING_KEY_SECRET = "Website deploy signing key";

/** GSAM's deploy signing key, made the first time John opens Deploy. The private half stays in the vault. */
export async function deploySigningKey(secrets: Secrets, companyId: string, userId: string): Promise<KeyObject> {
  let secret = await secrets.getByName(companyId, SIGNING_KEY_SECRET);
  if (!secret) {
    const { privateKey } = generateKeyPairSync("ed25519");
    secret = await secrets.create(companyId, {
      name: SIGNING_KEY_SECRET,
      provider: "local_encrypted",
      value: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      description: "Ed25519 key GSAM signs website Deploy and Roll back tickets with. Its public half is GSAM_DEPLOY_PUBLIC_KEY in the website repo's production environment. Never shared.",
    }, { userId });
  }
  const pem = await secrets.resolveSecretValue(companyId, secret.id, "latest", {
    accessContext: { consumerType: "system", consumerId: "website-production-deploy", configPath: "deploy.signingKey", actorType: "system" },
  });
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the deploy signing key is not Ed25519");
  return key;
}

type NetlifyDeploy = { id: string; state?: string; title?: string | null; context?: string; published_at?: string | null };

/** The live deploy before the current one: the newest other ready production deploy that was ever published. */
export function rollbackTarget(deploys: NetlifyDeploy[], liveId: string | null) {
  const earlier = deploys
    .filter((d) => d.id !== liveId && d.state === "ready" && d.context === "production" && d.published_at)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!))[0];
  if (!earlier) return null;
  return { deployId: earlier.id, commit: /^gsam-source:prod:([0-9a-f]{40})$/.exec(earlier.title ?? "")?.[1] ?? null, publishedAt: earlier.published_at ?? null };
}

/** A workflow run as the panel shows it; null for a run this workflow's run-name did not name. */
export function toProductionRun(run: { id: number; display_title?: string; status?: string; conclusion?: string | null; created_at: string; html_url: string }): WebsiteProductionRun | null {
  const named = /^Website (deploy|rollback) ([0-9a-f-]{36})$/.exec(run.display_title ?? "");
  if (!named) return null;
  const status = run.status === "completed" ? "completed" : run.status === "in_progress" ? "in_progress" : "queued";
  return { id: run.id, action: named[1] as "deploy" | "rollback", request: named[2]!, status, conclusion: run.conclusion ?? null, createdAt: run.created_at, url: run.html_url };
}

export function productionClient(tokens: ProductionTokens, fetchImpl: typeof fetch = fetch) {
  const github = async (path: string, init: RequestInit = {}) => fetchImpl(`https://api.github.com/repos/${WEBSITE_REPO}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tokens.githubToken}`, accept: "application/vnd.github+json", "user-agent": "GS Agentic Manager", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const netlify = async <T>(path: string): Promise<T> => {
    const res = await retryOnce(() => fetchImpl(`https://api.netlify.com/api/v1${path}`, { headers: { authorization: `Bearer ${tokens.netlifyToken}` }, signal: AbortSignal.timeout(NETLIFY_TIMEOUT_MS) }));
    if (!res.ok) throw new Error(`Netlify answered ${res.status}`);
    return res.json() as Promise<T>;
  };
  /** A store's `current` pointer: the content release and its sha256. */
  const pointer = async (siteId: string) => {
    const res = await retryOnce(() => fetchImpl(netlifyBlobUrl(siteId, tokens.storeName, "current"), { headers: { authorization: `Bearer ${tokens.netlifyToken}` }, signal: AbortSignal.timeout(NETLIFY_TIMEOUT_MS) }));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Netlify answered ${res.status} for a content pointer`);
    const body = await res.json() as { release?: unknown; sha256?: unknown };
    return typeof body.release === "number" && typeof body.sha256 === "string" ? { release: body.release, sha256: body.sha256 } : null;
  };

  async function runs(): Promise<{ ready: boolean; runs: WebsiteProductionRun[] }> {
    const res = await github(`/actions/workflows/${PRODUCTION_WORKFLOW}/runs?per_page=10`);
    if (res.status === 404) return { ready: false, runs: [] };
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the Deploy history`);
    const list = ((await res.json()) as { workflow_runs?: Parameters<typeof toProductionRun>[0][] }).workflow_runs ?? [];
    const mapped = list.map(toProductionRun).filter((run): run is WebsiteProductionRun => run !== null);
    const newest = mapped[0];
    if (newest) {
      const jobs = await github(`/actions/runs/${newest.id}/jobs`);
      if (jobs.ok) {
        const steps = ((await jobs.json()) as { jobs?: { steps?: { name: string; status: string; conclusion: string | null }[] }[] }).jobs?.[0]?.steps ?? [];
        newest.steps = steps.filter((step) => !/^(Set up job|Complete job|Post )/.test(step.name)).map(({ name, status, conclusion }) => ({ name, status, conclusion }));
      }
    }
    return { ready: true, runs: mapped };
  }

  async function status(): Promise<Omit<WebsiteProductionStatus, "canDeploy" | "publicKey">> {
    const problems: string[] = [];
    const soft = async <T>(what: string, work: () => Promise<T>, fallback: T) => {
      try { return await work(); } catch (err) {
        problems.push(`GSAM could not read ${what} (${err instanceof Error ? err.message : String(err)}).`);
        return fallback;
      }
    };
    const [prodDeploys, stagingDeploys, site, livePointer, stagingPointer, history] = await Promise.all([
      soft("the live site's deploys", () => netlify<NetlifyDeploy[]>(`/sites/${tokens.netlifySiteId}/deploys?per_page=100`), [] as NetlifyDeploy[]),
      soft("staging's deploys", () => netlify<NetlifyDeploy[]>(`/sites/${STAGING_NETLIFY_SITE_ID}/deploys?per_page=100`), [] as NetlifyDeploy[]),
      soft("the live site", () => netlify<{ published_deploy?: { id?: string; published_at?: string } | null }>(`/sites/${tokens.netlifySiteId}`), null),
      soft("the live content release", () => pointer(tokens.netlifySiteId), null),
      soft("staging's content release", () => pointer(STAGING_NETLIFY_SITE_ID), null),
      soft("the Deploy history from GitHub", runs, { ready: false, runs: [] as WebsiteProductionRun[] }),
    ]);
    const liveCommit = lastGuardedCommit(prodDeploys, "prod");
    const stagingCommit = lastGuardedCommit(stagingDeploys, "staging");
    let commits: { sha: string; title: string }[] = [];
    if (liveCommit && stagingCommit && liveCommit !== stagingCommit) {
      commits = await soft("the commit list from GitHub", async () => {
        const res = await github(`/compare/${liveCommit}...${stagingCommit}`);
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const list = ((await res.json()) as { commits?: { sha: string; commit: { message: string } }[] }).commits ?? [];
        return list.map((c) => ({ sha: c.sha, title: c.commit.message.split("\n")[0]! })).reverse();
      }, []);
    }
    const blockers = await deployBlockers(tokens.netlifyToken, tokens.storeName, fetchImpl);
    if (!stagingCommit) blockers.push("GSAM cannot tell which commit staging serves, so there is nothing safe to deploy.");
    const liveId = site?.published_deploy?.id ?? null;
    return {
      staging: { commit: stagingCommit, release: stagingPointer?.release ?? null },
      live: { commit: liveCommit, release: livePointer?.release ?? null, deployId: liveId, publishedAt: site?.published_deploy?.published_at ?? null },
      commits,
      blockers,
      rollback: rollbackTarget(prodDeploys, liveId),
      runs: history.runs,
      workflowReady: history.ready,
      problems,
    };
  }

  /** The staging pointer with its sha256, read again at the moment of Deploy. */
  const stagingPointer = () => pointer(STAGING_NETLIFY_SITE_ID);

  async function dispatch(action: "deploy" | "rollback", request: string, ticket: string) {
    const res = await github(`/actions/workflows/${PRODUCTION_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { action, request, ticket } }),
    });
    if (res.status !== 204) {
      throw new Error(res.status === 404
        ? "GitHub cannot find the production workflow on main yet, or GSAM's GitHub access cannot start it."
        : `GitHub did not start the workflow (it answered ${res.status}).`);
    }
  }

  return { status, stagingPointer, dispatch };
}
