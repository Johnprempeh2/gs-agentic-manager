#!/usr/bin/env node
// One-off import of the Greatstone Animation Lab into GS Studio's Motion
// section (GRE-2212). Reads the live gallery: index.html holds the ANIMS
// array, and each study page is anims/<slug>.html. A Notion catalogue export
// (JSON rows with "No.", Notes, Status, Decision) adds the notes; without it,
// every study arrives New and Undecided.
//
//   node scripts/import-animation-lab.mjs --company <companyId> [--catalogue rows.json] [--dry-run out.json]
//
// Uses GSAM_API_URL and GSAM_API_KEY. Matching is by slug on the server, so
// running it again refreshes files and fields and keeps decisions made since.

import { readFile, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

export const DEFAULT_GALLERY_URL = "https://greatstone-animation-lab.netlify.app/";

const STATUSES = new Set(["new", "reviewed", "approved", "implemented", "archived"]);
const DECISIONS = new Set(["undecided", "implement", "maybe", "pass"]);

/** Pulls the ANIMS array literal out of the gallery page and evaluates it with no globals. */
export function parseAnims(indexHtml) {
  const start = indexHtml.indexOf("const ANIMS");
  if (start < 0) throw new Error("The gallery page has no ANIMS array");
  const open = indexHtml.indexOf("[", start);
  let depth = 0;
  let quote = null;
  for (let index = open; index < indexHtml.length; index += 1) {
    const char = indexHtml[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        const literal = indexHtml.slice(open, index + 1);
        const anims = runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
        if (!Array.isArray(anims)) throw new Error("ANIMS is not an array");
        // Plain data back in this realm, not objects tied to the sandbox context.
        return JSON.parse(JSON.stringify(anims));
      }
    }
  }
  throw new Error("The ANIMS array is not closed");
}

/** Notion rows keyed by study number, for example "021". */
export function catalogueByNumber(rows) {
  const byNumber = new Map();
  for (const row of rows ?? []) {
    const number = String(row["No."] ?? "").trim();
    if (number) byNumber.set(number.padStart(3, "0"), row);
  }
  return byNumber;
}

function lower(value, allowed, fallback) {
  const normalised = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalised) ? normalised : fallback;
}

/** A study page that loads code from elsewhere cannot run in the sandbox; say so on its record. */
export function externalScriptNote(html) {
  const external = /<script[^>]+src=["']https?:|"imports"\s*:\s*\{[^}]*https?:|import[^;]+from\s+["']https?:/i.test(html);
  return external
    ? "In GSAM: this study loads code from the internet, which the Motion sandbox blocks, so its preview stays dark until that code is bundled into the page."
    : null;
}

/**
 * The sandbox has no network, so images a study links by relative path (the
 * Greatstone logo) are fetched once and written into the page as data URIs.
 */
export async function inlineRelativeImages(html, pageUrl, fetchBytes) {
  const sources = new Set();
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const source = match[1];
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) sources.add(source);
  }
  let inlined = html;
  for (const source of sources) {
    const { bytes, contentType } = await fetchBytes(new URL(source, pageUrl));
    const dataUri = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    inlined = inlined.split(`"${source}"`).join(`"${dataUri}"`).split(`'${source}'`).join(`'${dataUri}'`);
  }
  return inlined;
}

/** One import entry: title, concept, theme and tech from ANIMS; notes and decisions from Notion when given. */
export function toImportStudy(anim, html, galleryUrl, catalogue) {
  const number = String(anim.no).padStart(3, "0");
  const row = catalogue?.get(number) ?? null;
  const notes = [row?.Notes?.trim() || null, externalScriptNote(html)].filter(Boolean).join("\n\n") || null;
  return {
    number,
    slug: anim.slug,
    title: anim.title,
    concept: anim.concept ?? "",
    theme: Array.isArray(anim.theme) ? anim.theme : [],
    tech: anim.tech || row?.Tech || "",
    notes,
    studyDate: anim.date ?? null,
    sourceUrl: new URL(`anims/${anim.slug}.html`, galleryUrl).toString(),
    html,
    status: lower(row?.Status, STATUSES, "new"),
    decision: lower(row?.Decision, DECISIONS, "undecided"),
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}

async function main(args) {
  const galleryUrl = argValue(args, "--gallery") ?? DEFAULT_GALLERY_URL;
  const companyId = argValue(args, "--company") ?? process.env.GSAM_COMPANY_ID;
  const cataloguePath = argValue(args, "--catalogue");
  const dryRun = argValue(args, "--dry-run");
  if (!companyId && !dryRun) throw new Error("Give --company <companyId> or set GSAM_COMPANY_ID");

  const anims = parseAnims(await fetchText(galleryUrl));
  const catalogue = cataloguePath ? catalogueByNumber(JSON.parse(await readFile(cataloguePath, "utf8"))) : null;
  const studies = [];
  for (const anim of anims) {
    const pageUrl = new URL(`anims/${anim.slug}.html`, galleryUrl);
    const html = await inlineRelativeImages(await fetchText(pageUrl), pageUrl, fetchBytes);
    studies.push(toImportStudy(anim, html, galleryUrl, catalogue));
  }
  console.log(`Read ${studies.length} studies from ${galleryUrl}${catalogue ? ` with ${catalogue.size} catalogue rows` : ""}`);

  if (dryRun) {
    await writeFile(dryRun, JSON.stringify({ studies }, null, 2));
    console.log(`Wrote the import to ${dryRun}; nothing was sent`);
    return;
  }

  const base = (process.env.GSAM_API_URL ?? "http://localhost:3100").replace(/\/+$/, "").replace(/\/api$/, "");
  const response = await fetch(`${base}/api/companies/${companyId}/motion-studies/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.GSAM_API_KEY ? { Authorization: `Bearer ${process.env.GSAM_API_KEY}` } : {}),
      ...(process.env.GSAM_RUN_ID ? { "X-Paperclip-Run-Id": process.env.GSAM_RUN_ID } : {}),
    },
    body: JSON.stringify({ studies }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Import answered ${response.status}: ${JSON.stringify(body)}`);
  console.log(`Imported: ${body.created} new, ${body.updated} refreshed`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
