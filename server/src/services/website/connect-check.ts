// The check when a site is connected or its token, Netlify site ID or live
// address changes (GRE-2137, copy GRE-2107 section 3). Nothing is saved
// unless it passes: the token opens the Netlify site, the live address is one
// of that site's addresses, and the site's `/_release` reports an engine GSAM
// can publish to. The engine version it reports is stored on the site.

import { HttpError } from "../../errors.js";
import { WEBSITE_RELEASE_SCHEMA } from "./publish.js";

/** The oldest site engine GSAM publishes to (`engine.version` in `/_release`). */
export const WEBSITE_MIN_ENGINE_VERSION = "0.1.0";

export type WebsiteConnectProblem = "netlify_not_found" | "token" | "token_scope" | "domain" | "no_release_route" | "engine_old";

export type WebsiteConnectResult =
  | { ok: true; engineVersion: string }
  | { ok: false; problem: WebsiteConnectProblem; engineVersion?: string | null };

export interface WebsiteConnectInput {
  netlifySiteId: string;
  domain: string;
  token: string;
}

export type WebsiteConnectionChecker = (input: WebsiteConnectInput) => Promise<WebsiteConnectResult>;

const API = "https://api.netlify.com/api/v1";
const CALL_TIMEOUT_MS = 15_000;

/** Copy section 3, "Results and errors". */
export const WEBSITE_CONNECT_MESSAGES: Record<WebsiteConnectProblem, string> = {
  netlify_not_found: "Netlify cannot find that site ID. Check it in Netlify under Site configuration.",
  token: "Netlify refused the token. Make a new token in Netlify and paste it here.",
  token_scope: "The token works but cannot reach this site. Use a token from the team that owns the site.",
  domain: "That address does not reach this Netlify site. Check the live address.",
  no_release_route: "This site is not set up for GSAM yet. Ask your website team to set it up, then connect again.",
  engine_old: "This site needs an update before it can connect. Ask your website team to update it.",
};

/** The `connect.err.*` refusal as the API returns it: the copy, its key, and the details line when the copy has one. */
export function websiteConnectRefusal(result: Extract<WebsiteConnectResult, { ok: false }>) {
  const detail =
    result.problem === "no_release_route"
      ? "Details: no answer at /_release."
      : result.problem === "engine_old"
        ? `Details: site version ${result.engineVersion ?? "unknown"}. GSAM needs ${WEBSITE_MIN_ENGINE_VERSION} or later.`
        : null;
  return new HttpError(422, WEBSITE_CONNECT_MESSAGES[result.problem], {
    code: `website_connect_${result.problem}`,
    messageKey: `connect.err.${result.problem}`,
    detail,
    engineVersion: result.engineVersion ?? null,
  });
}

function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `version` is at least `required`; an unreadable version is too old. */
export function engineVersionAtLeast(version: string, required = WEBSITE_MIN_ENGINE_VERSION): boolean {
  const have = versionParts(version);
  const need = versionParts(required);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The live address belongs to the Netlify site when it is the custom domain, an alias,
 * the `.netlify.app` name, or a branch address of it. Netlify serves the www and bare
 * forms of a custom domain together, so either form matches.
 */
export function domainBelongsToSite(domain: string, site: Record<string, unknown>): boolean {
  const name = typeof site.name === "string" ? site.name.toLowerCase() : null;
  const hosts = new Set<string>();
  for (const value of [site.custom_domain, ...(Array.isArray(site.domain_aliases) ? site.domain_aliases : [])]) {
    if (typeof value === "string" && value) hosts.add(value.toLowerCase());
  }
  for (const url of [site.url, site.ssl_url]) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  if (name) hosts.add(`${name}.netlify.app`);
  const bare = (host: string) => host.replace(/^www\./, "");
  const wanted = domain.toLowerCase();
  if ([...hosts].some((host) => host === wanted || bare(host) === bare(wanted))) return true;
  return Boolean(name && wanted.endsWith(`--${name}.netlify.app`));
}

/** Netlify did not answer in a way that says yes or no. Nothing is saved; the person can try again. */
function netlifyUnavailable(status: number | null) {
  return new HttpError(502, "Netlify did not answer. Nothing was saved. Try again in a minute.", {
    code: "website_connect_netlify_unavailable",
    status,
  });
}

export async function checkWebsiteConnection(
  input: WebsiteConnectInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<WebsiteConnectResult> {
  const baseFetch = options.fetchImpl ?? fetch;
  const call = (url: string, init: RequestInit = {}) => baseFetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });

  // 1. The token and the site id, in one call. Netlify answers 401 for a bad token, 403 when the token's
  //    account may not open the site, and 404 for a site id it does not know (or hides from this token).
  let res: Response;
  try {
    res = await call(`${API}/sites/${encodeURIComponent(input.netlifySiteId)}`, {
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
    });
  } catch {
    throw netlifyUnavailable(null);
  }
  if (res.status === 401) return { ok: false, problem: "token" };
  if (res.status === 403) return { ok: false, problem: "token_scope" };
  if (res.status === 404) return { ok: false, problem: "netlify_not_found" };
  if (!res.ok) throw netlifyUnavailable(res.status);
  const site = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!site || typeof site !== "object") throw netlifyUnavailable(res.status);

  // 2. The live address must be this Netlify site's.
  if (!domainBelongsToSite(input.domain, site)) return { ok: false, problem: "domain" };

  // 3. The site's own answer at /_release: the engine version and the release schemas it reads.
  let release: Record<string, unknown> | null = null;
  try {
    const answer = await call(`https://${input.domain}/_release`, {
      redirect: "follow",
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "GSAM-website-connect-check" },
    });
    if (answer.ok) release = (await answer.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    // The address did not answer at all.
    return { ok: false, problem: "domain" };
  }
  const engine = release && typeof release.engine === "object" ? (release.engine as Record<string, unknown> | null) : null;
  const engineVersion = typeof engine?.version === "string" && engine.version.trim() ? engine.version.trim() : null;
  if (!engineVersion) return { ok: false, problem: "no_release_route" };

  const schemas = Array.isArray(release?.supportedReleaseSchemas) ? release.supportedReleaseSchemas : null;
  const readsOurSchema = schemas === null || schemas.includes(WEBSITE_RELEASE_SCHEMA);
  if (!engineVersionAtLeast(engineVersion) || !readsOurSchema) return { ok: false, problem: "engine_old", engineVersion };
  return { ok: true, engineVersion };
}
