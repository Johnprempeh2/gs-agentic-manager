// The one contract between GSAM and the website (GRE-2633). Its canonical copy
// is `contracts/` at the root of this repo; `contracts/manifest.json` holds the
// version and a hash of every file. The website vendors that folder unchanged.
// These constants are GSAM's reading of the manifest; a test keeps them equal.
//
// The site reports the contract it speaks as `siteContract` in three answers:
// the bridge health (`/api/admin/v1/health`), the editor `hello-ack`, and
// `/_release`. GSAM checks it on every connection, and the release queue and
// the website deploy guard refuse when it is too old.

export const SITE_CONTRACT_NAME = "gs-site-contract" as const;

/** The contract this GSAM speaks. A change that adds to the contract raises it. */
export const SITE_CONTRACT_VERSION = 2;

/**
 * The oldest site contract this GSAM works with. A change that breaks an older
 * site raises it, and then the website must deploy first: the release gate
 * refuses GSAM until every connected site reports at least this version.
 */
export const SITE_CONTRACT_MIN_SITE_VERSION = 1;

/** What GSAM shows when the site speaks an older contract, instead of failing silently. */
export const SITE_CONTRACT_OUT_OF_DATE_MESSAGE = "Out of date: update the website.";

/** The `siteContract` a site answer reports, or null when it reports none (a site from before GRE-2633). */
export function siteContractOf(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { siteContract?: unknown }).siteContract;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** True when the site speaks a contract this GSAM works with. No version is too old. */
export function isSiteContractCurrent(answer: unknown, minimum = SITE_CONTRACT_MIN_SITE_VERSION): boolean {
  const version = siteContractOf(answer);
  return version !== null && version >= minimum;
}

/** The details line under the out-of-date message. */
export function siteContractDetail(answer: unknown, minimum = SITE_CONTRACT_MIN_SITE_VERSION): string {
  const version = siteContractOf(answer);
  return `The website speaks contract ${version ?? "none"}; GSAM needs ${minimum} or later.`;
}
