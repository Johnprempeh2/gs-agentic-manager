import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findViolations, parseTables, scanSchemaDir } from "./check-contact-identity.mjs";

const table = (columns, config = "") => `
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
${columns.map((c) => `    ${c}`).join("\n")}
  },
  (table) => ({${config}}),
);
`;

const LINKED_CHECK = 'check("people_linked_no_email_check", sql`${table.websiteUserId} is null or ${table.email} is null`)';

test("a contact table with a raw email and no website_user_id fails", () => {
  const problems = findViolations(parseTables(table(['email: text("email"),'])), {});
  assert.deepEqual(problems, ["people: stores email with no website_user_id reference."]);
});

test("website_user_id without the linked-no-email check fails", () => {
  const source = table(['websiteUserId: text("website_user_id"),', 'email: text("email"),']);
  assert.match(findViolations(parseTables(source), {})[0], /no check that a linked row holds no email/);
});

test("website_user_id plus the linked-no-email check passes", () => {
  const source = table(['websiteUserId: text("website_user_id"),', 'email: text("email"),'], LINKED_CHECK);
  assert.deepEqual(findViolations(parseTables(source), {}), []);
});

test("a password column fails even with website_user_id", () => {
  const source = table(['websiteUserId: text("website_user_id"),', 'passwordHash: text("password_hash"),']);
  assert.match(findViolations(parseTables(source), {})[0], /stores password_hash/);
});

test("an allowed table and a table with no identity column pass", () => {
  assert.deepEqual(findViolations(parseTables(table(['email: text("email"),'])), { people: "reason" }), []);
  assert.deepEqual(findViolations(parseTables(table(['name: text("name"),'])), {}), []);
});

test("the real schema passes, and both CRM contact tables carry the reference", () => {
  const tables = scanSchemaDir(fileURLToPath(new URL("../packages/db/src/schema/", import.meta.url)));
  assert.deepEqual(findViolations(tables), []);
  for (const name of ["organisation_contacts", "pipeline_case_contacts"]) {
    assert.ok(tables.find((t) => t.name === name)?.columns.includes("website_user_id"), name);
  }
});
