// The pre-Deploy safety check (John, 8 Nov, GRE-2115): Deploy promotes staging's code and content release to
// greatstoneint.com, so it is refused while staging's release has no products or a key staging page is broken.
// Fails closed: if GSAM cannot read the release or a page, that is a reason to refuse, not to go ahead.
import { netlifyBlobUrl } from "./netlify-publish-client.js";
import { contentPointer, STAGING_DOMAIN, STAGING_NETLIFY_SITE_ID } from "./deploy-changes.js";

const TIMEOUT_MS = 15_000;
export const DEPLOY_KEY_PATHS = ["/", "/shop", "/consultancy", "/contact"] as const;

type Item = { key?: string; fields?: { slug?: unknown } | null };

/** Every reason Deploy must not run now, in plain words; empty when it may. */
export async function deployBlockers(netlifyToken: string, storeName = "gsam-content", fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const problems: string[] = [];
  let sample: string | null = null;
  try {
    const release = await contentPointer(STAGING_NETLIFY_SITE_ID, storeName, netlifyToken, fetchImpl);
    if (release === null) {
      problems.push("Staging has no content release, so there is nothing safe to deploy.");
    } else {
      const res = await fetchImpl(netlifyBlobUrl(STAGING_NETLIFY_SITE_ID, storeName, `releases/${release}.json`), {
        headers: { authorization: `Bearer ${netlifyToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const offerings = (((await res.json()) as { collections?: Record<string, unknown> }).collections?.offerings ?? []) as Item[];
      if (!Array.isArray(offerings) || offerings.length === 0) {
        problems.push(`Staging's content release ${release} has 0 products, so the shop would be empty on greatstoneint.com.`);
      } else {
        const first = offerings[0]!;
        sample = typeof first.fields?.slug === "string" ? first.fields.slug : first.key ?? null;
      }
    }
  } catch (err) {
    problems.push(`GSAM could not read staging's content release (${err instanceof Error ? err.message : String(err)}).`);
  }
  const paths: string[] = [...DEPLOY_KEY_PATHS, ...(sample ? [`/product/${encodeURIComponent(sample)}`] : [])];
  await Promise.all(paths.map(async (path) => {
    try {
      const res = await fetchImpl(`https://${STAGING_DOMAIN}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 200) problems.push(`Staging page ${path} answers ${res.status}, not 200.`);
    } catch {
      problems.push(`Staging page ${path} did not answer.`);
    }
  }));
  return problems;
}

export function deployRefusal(problems: string[]) {
  return `Deploy stopped: staging is not ready, so greatstoneint.com was not changed. ${problems.join(" ")}`;
}
