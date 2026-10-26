#!/usr/bin/env node
// Client users live in the website's database, not in GSAM's (GRE-2623, GRE-2658).
// Every table in packages/db/src/schema that has an email or password column must
// either reference the website user (a website_user_id column plus a check that a
// linked row holds no email copy) or be listed in ALLOWED with the reason it may
// keep one. A new CRM contact or organisation-member table with a raw email fails
// here until it gets the reference or a reviewed reason. Mirrors greatstone-website's
// scripts/check-org-scoping.mjs. Dependency-free so the always-on CI guard job can run it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Table name to the reason it may hold an email or password with no website user reference. */
export const ALLOWED = {
  user: "GSAM's own sign-in users (Greatstone staff and board members), not client users.",
  account: "Better Auth credentials for GSAM's own sign-in users; the password is a hash.",
  organisations: "The organisation's general inbox from the CRM, not a person.",
  strategy_board_emails: "Send log of board emails to GSAM members (recipient_user_id is a GSAM user).",
  join_requests: "Snapshot of a GSAM member's email at the time they asked to join.",
  client_acceptance_links: "Signed record of acceptance: the email exactly as the person typed it on the page.",
  client_deliverable_publications: "Signed record of acceptance: the email exactly as the person typed it on the page.",
};

const IDENTITY_COLUMN = /(^|_)(email|password)(_|$)/;

/** The text between the brace at `open` and its matching close. */
function braceBody(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error("unbalanced braces after pgTable(");
}

/** Every pgTable in a schema file: its name, SQL column names (all, and text ones) and the text of its extra config. */
export function parseTables(source) {
  const tables = [];
  for (const match of source.matchAll(/pgTable\(\s*"([a-z0-9_]+)"\s*,\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const columnsBody = braceBody(source, open);
    const rest = source.slice(open + columnsBody.length + 2);
    const nextTable = rest.search(/pgTable\(/);
    const config = nextTable < 0 ? rest : rest.slice(0, nextTable);
    const declared = [...columnsBody.matchAll(/^\s*\w+:\s*(\w+)\(\s*"([a-z0-9_]+)"/gm)];
    const columns = declared.map((m) => m[2]);
    // Only text can hold an email or password; this skips ids and flags such as email_endpoint_id.
    const textColumns = declared.filter((m) => /^(text|varchar|citext)$/.test(m[1])).map((m) => m[2]);
    tables.push({ name: match[1], columns, textColumns, config });
  }
  return tables;
}

/** A problem string for each table that stores an email or password it should not. */
export function findViolations(tables, allowed = ALLOWED) {
  const problems = [];
  for (const table of tables) {
    const identity = table.textColumns.filter((column) => IDENTITY_COLUMN.test(column));
    if (identity.length === 0 || allowed[table.name]) continue;
    const passwords = identity.filter((column) => column.includes("password"));
    if (passwords.length > 0) {
      problems.push(`${table.name}: stores ${passwords.join(", ")}. Client passwords belong to the website only.`);
      continue;
    }
    if (!table.columns.includes("website_user_id")) {
      problems.push(`${table.name}: stores ${identity.join(", ")} with no website_user_id reference.`);
      continue;
    }
    const unchecked = identity.filter((column) =>
      !table.config.includes(`\${table.websiteUserId} is null or \${table.${camel(column)}} is null`));
    if (unchecked.length > 0) {
      problems.push(`${table.name}: has website_user_id but no check that a linked row holds no ${unchecked.join(", ")}.`);
    }
  }
  return problems;
}

function camel(column) {
  return column.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function scanSchemaDir(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => parseTables(readFileSync(join(dir, file), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tables = scanSchemaDir(fileURLToPath(new URL("../packages/db/src/schema/", import.meta.url)));
  if (tables.length < 50) throw new Error(`only ${tables.length} tables found in the schema; the parser needs updating`);
  const stale = Object.keys(ALLOWED).filter((name) => !tables.some((table) => table.name === name));
  const problems = [
    ...findViolations(tables),
    ...stale.map((name) => `${name}: listed in ALLOWED but no such table; remove it.`),
  ];
  if (problems.length) {
    console.error("Client identity stored outside the website (GRE-2623):");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Add a website_user_id column and a \"website_user_id is null or <email> is null\" check,");
    console.error("or add the table to ALLOWED in scripts/check-contact-identity.mjs with the reason it may keep the value.");
    process.exit(1);
  }
  console.log(`Contact identity OK: ${tables.length} tables, none hold a client email or password without a website user reference.`);
}
