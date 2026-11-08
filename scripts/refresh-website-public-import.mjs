#!/usr/bin/env node
// Refreshes server/src/services/website/public-import-v1.json, the data behind "Import public drafts" (GRE-4698).
// Input is the website repo's catalogue export, which pages through every published product and checks each row
// against the release schema:
//   NEXT_CATALOGUE_API=https://greatstoneint.com/api/catalogue node next-proof/scripts/export-catalogue.mjs <export.json>
// Then, from this repo:
//   node scripts/refresh-website-public-import.mjs <export.json>
// People and forms are not in the catalogue, so they are kept from the current snapshot.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../server/src/services/website/public-import-v1.json", import.meta.url));

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/refresh-website-public-import.mjs <catalogue-export.json>");

const exported = JSON.parse(await readFile(input, "utf8"));
const current = JSON.parse(await readFile(target, "utf8"));
const rows = (key) => {
  const entries = exported.collections?.[key]?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${key}: the export has no entries`);
  return entries.map((entry) => entry.fields.data);
};

const next = {
  capturedAt: new Date().toISOString().slice(0, 10),
  vendors: rows("vendors"),
  categories: rows("categories"),
  products: rows("offerings"),
  people: current.people,
  forms: current.forms,
};
// One row per line: the file stays near 1.2 MB and a refresh diffs product by product.
const body = Object.entries(next).map(([key, value]) => Array.isArray(value)
  ? `  ${JSON.stringify(key)}: [\n${value.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  ]`
  : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
await writeFile(target, `{\n${body.join(",\n")}\n}\n`);
console.log(JSON.stringify({ capturedAt: next.capturedAt, vendors: next.vendors.length, categories: next.categories.length, products: next.products.length, people: next.people.length, forms: next.forms.length }));
