#!/usr/bin/env node
// The release gate for the GSAM and website contract (GRE-2633). Before a
// release, greatstone-release.sh pipes the candidate's contracts/manifest.json
// in; this asks live GSAM for every connected site, reads each site's
// `/_release` (its live address and its editor host), or `/_contract.json`
// when `/_release` is not JSON, and refuses when one speaks less than the
// candidate's `minSiteVersion`. Then the website deploys first, and the
// release goes again.
//
//   git show <commit>:contracts/manifest.json | node greatstone-site-contract-gate.mjs <live-url> <board-key-file>
//
// Exit 0: every site is current (or none is connected). Exit 1: refused; the
// reason is on stdout, one line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CALL_TIMEOUT_MS = 10_000;

/** The origins to ask: each site's live address and its editor host, once each. */
export function siteOrigins(sites) {
  const origins = new Set();
  for (const site of sites) {
    if (typeof site?.domain === "string" && site.domain.trim()) origins.add(`https://${site.domain.trim().toLowerCase()}`);
    if (typeof site?.editorFrameOrigin === "string" && site.editorFrameOrigin.trim()) {
      try {
        origins.add(new URL(site.editorFrameOrigin.trim()).origin);
      } catch {
        // not a URL: the editor check reports it
      }
    }
  }
  return [...origins].sort();
}

/** What one origin's `path` says: its `siteContract`, or null with the reason. */
async function readSiteContract(origin, path, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      headers: { accept: "application/json", "user-agent": "GSAM-release-site-contract-gate" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    return { siteContract: null, reason: "did not answer" };
  }
  if (!res.ok) return { siteContract: null, reason: `answered ${res.status} at ${path}` };
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") return { siteContract: null, reason: `has no ${path} (not JSON)` };
  const value = body.siteContract;
  return Number.isInteger(value) && value > 0 ? { siteContract: value, reason: null } : { siteContract: null, reason: `reports no siteContract at ${path}` };
}

/**
 * The contract one origin speaks. `/_release` first; when it is not JSON or has
 * no `siteContract` (a host that serves the app shell for every path), the
 * static `/_contract.json`. A host that does not answer at all is not asked twice.
 */
export async function reportedSiteContract(origin, fetchImpl = fetch) {
  const release = await readSiteContract(origin, "/_release", fetchImpl);
  if (release.siteContract !== null) return release;
  if (release.reason === "did not answer") return release;
  const file = await readSiteContract(origin, "/_contract.json", fetchImpl);
  if (file.siteContract !== null) return file;
  return { siteContract: null, reason: `${release.reason}, and ${file.reason}` };
}

/** The verdict for one release: `{ ok, line }`. */
export async function siteContractGate({ manifest, origins, fetchImpl = fetch }) {
  const minimum = manifest?.minSiteVersion;
  if (!Number.isInteger(minimum)) return { ok: false, line: "the release's contracts/manifest.json has no minSiteVersion." };
  if (origins.length === 0) return { ok: true, line: `no connected site to ask; this release needs site contract ${minimum} or later.` };
  const old = [];
  const current = [];
  for (const origin of origins) {
    const { siteContract, reason } = await reportedSiteContract(origin, fetchImpl);
    if (siteContract !== null && siteContract >= minimum) current.push(`${origin} v${siteContract}`);
    else old.push(siteContract === null ? `${origin} ${reason}` : `${origin} speaks v${siteContract}`);
  }
  if (old.length) {
    return {
      ok: false,
      line: `Out of date: update the website. This release needs site contract ${minimum} or later, but ${old.join("; ")}. Deploy the website first, then release again. Only in an emergency: greatstone-release.sh --skip-site-contract "<reason>" <tag>. Nothing was changed.`,
    };
  }
  return { ok: true, line: `every connected site speaks contract ${minimum} or later (${current.join(", ")}).` };
}

/** Every connected site of every company on live GSAM. */
export async function connectedSites(base, key, fetchImpl = fetch) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const get = async (path) => {
    const res = await fetchImpl(base + path, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return res.json();
  };
  const sites = [];
  for (const company of (await get("/api/companies")) ?? []) {
    const list = await get(`/api/companies/${encodeURIComponent(company.id)}/website/sites`);
    if (Array.isArray(list)) sites.push(...list);
  }
  return sites;
}

async function main([base, keyFile]) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.log("the release's contracts/manifest.json cannot be read.");
    process.exit(1);
  }
  let key = "";
  try {
    key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
  } catch {
    // no board key: local_trusted
  }
  let sites;
  try {
    sites = await connectedSites(base, key);
  } catch (error) {
    console.log(`cannot list the connected sites on ${base}: ${error instanceof Error ? error.message : error}. Only in an emergency: greatstone-release.sh --skip-site-contract "<reason>" <tag>. Nothing was changed.`);
    process.exit(1);
  }
  const verdict = await siteContractGate({ manifest, origins: siteOrigins(sites) });
  console.log(verdict.line);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
