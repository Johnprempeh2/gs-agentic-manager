// What the editor's "Deploy these changes" button would put live: the website main commits
// since the last guarded production deploy (a Netlify deploy titled gsam-source:prod:<sha>,
// as scripts/deploy-site.mjs writes it). Read only. Fails soft: the button works without it.
import type { WebsiteDeployChanges } from "@greatstone/shared";

export const WEBSITE_REPO = "Johnprempeh2/greatstone-website";
const PROD_MARKER = /^gsam-source:prod:([0-9a-f]{40})$/;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;

export type DeployChangesTokens = { netlifySiteId: string; netlifyToken: string; githubToken: string };

/** The newest ready deploy whose title names the commit it was built from. */
export function lastProdCommit(deploys: { state?: string; title?: string | null }[]): string | null {
  for (const deploy of deploys) {
    const sha = deploy.state === "ready" ? PROD_MARKER.exec(deploy.title ?? "")?.[1] : undefined;
    if (sha) return sha;
  }
  return null;
}

export async function loadDeployChanges(tokens: DeployChangesTokens, fetchImpl: typeof fetch = fetch): Promise<WebsiteDeployChanges> {
  const get = async (url: string, auth: string, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${auth}`, ...extra }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.json();
  };
  const deploys = await get(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(tokens.netlifySiteId)}/deploys?per_page=100`, tokens.netlifyToken);
  const base = lastProdCommit(deploys);
  if (!base) throw new Error("no guarded production deploy found");
  const compare = await get(`https://api.github.com/repos/${WEBSITE_REPO}/compare/${base}...main`, tokens.githubToken, {
    accept: "application/vnd.github+json",
    "user-agent": "GS Agentic Manager",
  });
  const commits = (compare.commits ?? []) as { sha: string; commit: { message: string } }[];
  return {
    liveCommit: base,
    mainCommit: commits.at(-1)?.sha ?? base,
    // Newest first, the first line of each message.
    commits: commits.map((c) => ({ sha: c.sha, title: c.commit.message.split("\n")[0]! })).reverse(),
  };
}

const cache = new Map<string, { at: number; value: Promise<WebsiteDeployChanges> }>();

/** `loadDeployChanges`, kept for a minute per site so an open editor does not hammer GitHub and Netlify. */
export function cachedDeployChanges(key: string, load: () => Promise<WebsiteDeployChanges>, now = Date.now()) {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = load();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}

/** The Website project: its GitHub grant is the one the website agents use. */
export const WEBSITE_PROJECT_ID = "91f12cf5-ac07-4f07-b68b-754d4c97257b";
