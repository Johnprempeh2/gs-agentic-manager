#!/usr/bin/env node
// Import a sitemap option from a nested JSON tree (GRE-2111).
//
// Usage:
//   node scripts/website-sitemap-import.mjs <file.json> --site <siteId> [--company <companyId>] [--api <url>]
//
// The file is the body of POST .../sitemap/options/import:
//   { "name": "Option A", "pages": [{ "title": "Home", "path": "/", "children": [...] }],
//     "journeys": [{ "name": "Leader", "paths": ["/", "/consultancy"] }] }
// Each page may also carry menu (header, footer, none), menuOrder, menuColumn,
// template, seoTitle, noindex, owner and notes.
//
// It uses GSAM_API_URL, GSAM_COMPANY_ID and GSAM_API_KEY (an agent's run
// environment) unless --api / --company are given. The option is a draft:
// only a person can approve it. Nothing here publishes.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const api = (flag("api") ?? process.env.GSAM_API_URL ?? "").replace(/\/+$/, "");
const companyId = flag("company") ?? process.env.GSAM_COMPANY_ID;
const siteId = flag("site");
if (!file || !api || !companyId || !siteId) {
  console.error("Usage: node scripts/website-sitemap-import.mjs <file.json> --site <siteId> [--company <id>] [--api <url>]");
  process.exit(2);
}

const body = readFileSync(file, "utf8");
JSON.parse(body); // fail early on a broken file
const headers = { "content-type": "application/json" };
if (process.env.GSAM_API_KEY) headers.authorization = `Bearer ${process.env.GSAM_API_KEY}`;
if (process.env.GSAM_RUN_ID) headers["x-paperclip-run-id"] = process.env.GSAM_RUN_ID;
const base = api.endsWith("/api") ? api : `${api}/api`;
const res = await fetch(`${base}/companies/${companyId}/website/sites/${siteId}/sitemap/options/import`, { method: "POST", headers, body });
const result = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`Import failed (${res.status}): ${result?.error ?? "no details"}`);
  for (const problem of result?.details?.problems ?? []) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`Imported "${result.name}" (${result.tree.nodes.length} pages, ${result.tree.journeys.length} journeys) as option ${result.id}.`);
