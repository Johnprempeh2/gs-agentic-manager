// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/plan-copy.test.ts
// Two embedded Postgres databases stand in for the practice and the client instance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createDb } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";
import { PLAN_FIELDS, copyPlan, parentsFirst, planCopyLines, readPlan, type PlanGoal, type Sql } from "./plan-copy.js";

const support = await getEmbeddedPostgresTestSupport();
const skip = support.supported ? false : `embedded Postgres not supported: ${support.reason ?? "unknown"}`;

type TestDb = Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let practiceDb: TestDb | null = null;
let clientDb: TestDb | null = null;
let practice!: Sql;
let client!: Sql;
let practiceCompany!: string;
let clientCompany!: string;
const ids: Record<string, string> = {};

async function company(sql: Sql, name: string, prefix: string) {
  const id = randomUUID();
  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${id}, ${name}, ${prefix})`;
  return id;
}

async function user(sql: Sql, companyId: string, email: string) {
  const id = randomUUID();
  await sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (${id}, ${email}, ${email}, now(), now())`;
  await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
            VALUES (${companyId}, 'user', ${id}, 'active', 'member')`;
  return id;
}

async function goal(sql: Sql, companyId: string, key: string, values: Record<string, unknown>) {
  const id = randomUUID();
  ids[key] = id;
  await sql`INSERT INTO goals ${sql({ id, company_id: companyId, title: key, ...values })}`;
  return id;
}

/** Row count of every table, so a test can prove which tables changed. */
async function tableCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${name}"`);
    counts[name] = row!.n;
  }
  return counts;
}

before(async () => {
  if (skip) return;
  practiceDb = await startEmbeddedPostgresTestDatabase("plan-copy-practice-");
  clientDb = await startEmbeddedPostgresTestDatabase("plan-copy-client-");
  practice = createDb(practiceDb.connectionString).$client;
  client = createDb(clientDb.connectionString).$client;

  // Practice instance: the drafted plan, plus data that must not move.
  practiceCompany = await company(practice, "Workshop company", "WSP");
  const chair = await user(practice, practiceCompany, "Chair@Example.test");
  const cfo = await user(practice, practiceCompany, "cfo@example.test");
  const nobody = await user(practice, practiceCompany, "not-in-client@example.test");
  const agentId = randomUUID();
  await practice`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${practiceCompany}, 'Drafting agent')`;
  const plain = await goal(practice, practiceCompany, "plain goal", { level: "company" });

  await goal(practice, practiceCompany, "vision", { kind: "vision", level: "company", owner_user_id: chair, description: "Where we go" });
  await goal(practice, practiceCompany, "value", { kind: "value", level: "company" });
  await goal(practice, practiceCompany, "csf", { kind: "csf", level: "company", owner_user_id: chair });
  await goal(practice, practiceCompany, "pillar", { kind: "pillar", level: "team", parent_id: ids.csf, owner_user_id: cfo });
  await goal(practice, practiceCompany, "objective", {
    kind: "objective", level: "team", parent_id: ids.pillar, owner_agent_id: agentId, done_when: "Two new markets open",
  });
  await goal(practice, practiceCompany, "kpi", {
    kind: "kpi", level: "team", parent_id: ids.objective, owner_user_id: cfo, status: "active",
    target_value: 25, current_value: 12.5, unit: "%", baseline_value: 10, baseline_date: "2026-01-01",
    target_date: "2027-06-30", kpi_direction: "up", amber_threshold_pct: 5, red_threshold_pct: 15,
    benchmark_note: "Peers reach 20%",
  });
  await goal(practice, practiceCompany, "initiative", {
    kind: "initiative", level: "task", parent_id: ids.objective, owner_user_id: nobody,
    target_date: "2027-03-31", budget_planned_cents: 1_250_000, budget_spent_cents: 0, budget_currency: "USD",
  });
  // A plan goal under a plain goal: moves as a top-level goal.
  await goal(practice, practiceCompany, "loose objective", { kind: "objective", level: "team", parent_id: plain });

  const issueId = randomUUID();
  await practice`INSERT INTO issues (id, company_id, title, goal_id) VALUES (${issueId}, ${practiceCompany}, 'Draft workshop notes', ${ids.kpi})`;
  await practice`INSERT INTO issue_comments (company_id, issue_id, body) VALUES (${practiceCompany}, ${issueId}, 'note')`;
  await practice`INSERT INTO company_secrets (company_id, key, name) VALUES (${practiceCompany}, 'api', 'API key')`;
  await practice`INSERT INTO goal_check_ins (company_id, goal_id, body) VALUES (${practiceCompany}, ${ids.kpi}, 'on track')`;
  await practice`INSERT INTO goal_kpi_readings (company_id, goal_id, value, reading_date, source)
                 VALUES (${practiceCompany}, ${ids.kpi}, 12.5, '2026-09-30', 'owner_reported')`;

  // Client instance: the users F11 made (same people, other ids), one goal of its own.
  clientCompany = await company(client, "Client company", "CLI");
  ids.clientChair = await user(client, clientCompany, "chair@example.test");
  ids.clientCfo = await user(client, clientCompany, "CFO@example.test ");
  ids.clientOwnGoal = randomUUID();
  await client`INSERT INTO goals (id, company_id, title) VALUES (${ids.clientOwnGoal}, ${clientCompany}, 'Client own goal')`;
});

after(async () => {
  await practiceDb?.cleanup();
  await clientDb?.cleanup();
});

const opts = () => ({ sourceCompanyId: practiceCompany, targetCompanyId: clientCompany });

test("parents come before children", { skip: false }, () => {
  const g = (id: string, parent_id: string | null) => ({ id, parent_id }) as PlanGoal;
  assert.deepEqual(parentsFirst([g("c", "b"), g("b", "a"), g("a", null), g("x", "missing")]).map((r) => r.id), ["a", "x", "b", "c"]);
  assert.throws(() => parentsFirst([g("a", "b"), g("b", "a")]), /parent loop/);
});

test("a dry run reports and writes nothing", { skip }, async () => {
  const before = await tableCounts(client);
  const report = await copyPlan(practice, client, { ...opts(), apply: false });
  assert.equal(report.total, 8);
  assert.equal(report.created, 8);
  assert.deepEqual(await tableCounts(client), before);
});

test("the plan copies field by field; only plan data moves", { skip }, async () => {
  const practiceBefore = await tableCounts(practice);
  const clientBefore = await tableCounts(client);
  const report = await copyPlan(practice, client, { ...opts(), apply: true });

  assert.equal(report.total, 8);
  assert.deepEqual(report.byKind, { vision: 1, value: 1, csf: 1, pillar: 1, objective: 2, kpi: 1, initiative: 1 });
  assert.equal(report.created, 8);
  assert.equal(report.matchedOwners, 4);
  assert.deepEqual(
    report.unmatchedOwners.map((o) => [o.title, o.owner]),
    [["objective", "agent"], ["initiative", "person not-in-client@example.test"]],
  );
  assert.deepEqual(report.detachedFromParent, [ids["loose objective"]]);
  assert.ok(planCopyLines(report).some((line) => line.includes("not-in-client@example.test")));

  // Field by field.
  const source = await readPlan(practice, practiceCompany);
  const copied = new Map((await readPlan(client, clientCompany)).map((g) => [g.id, g]));
  assert.equal(copied.size, source.length);
  for (const goal of source) {
    const got = copied.get(goal.id);
    assert.ok(got, `goal ${goal.title} was copied`);
    for (const field of [...PLAN_FIELDS, "created_at"]) {
      assert.deepEqual(got[field], goal[field], `${goal.title}.${field}`);
    }
    assert.equal(got.company_id, clientCompany);
    assert.equal(got.parent_id, goal.title === "loose objective" ? null : goal.parent_id, `${goal.title}.parent_id`);
    assert.equal(got.owner_agent_id, null, `${goal.title}: agents do not move`);
  }
  const owner = (key: string) => copied.get(ids[key]!)!.owner_user_id;
  assert.equal(owner("vision"), ids.clientChair);
  assert.equal(owner("csf"), ids.clientChair);
  assert.equal(owner("pillar"), ids.clientCfo);
  assert.equal(owner("kpi"), ids.clientCfo);
  assert.equal(owner("initiative"), null);
  assert.equal(owner("value"), null);

  // Only goals changed in the client; the practice instance is untouched.
  const clientAfter = await tableCounts(client);
  for (const [table, count] of Object.entries(clientAfter)) {
    assert.equal(count, table === "goals" ? clientBefore.goals! + 8 : clientBefore[table], `client table ${table}`);
  }
  assert.deepEqual(await tableCounts(practice), practiceBefore);
});

test("a re-run makes no duplicates and changes nothing", { skip }, async () => {
  const before = await tableCounts(client);
  const report = await copyPlan(practice, client, { ...opts(), apply: true });
  assert.equal(report.created, 0);
  assert.equal(report.updated, 0);
  assert.equal(report.unchanged, 8);
  assert.deepEqual(await tableCounts(client), before);
  const [own] = await client`SELECT title FROM goals WHERE id = ${ids.clientOwnGoal}`;
  assert.equal(own!.title, "Client own goal");
});

test("a re-run after a workshop edit updates the goal and keeps a client-set owner", { skip }, async () => {
  await practice`UPDATE goals SET target_value = 30 WHERE id = ${ids.kpi}`;
  const clientOwner = await user(client, clientCompany, "late-owner@example.test");
  await client`UPDATE goals SET owner_user_id = ${clientOwner} WHERE id = ${ids.initiative}`;

  const report = await copyPlan(practice, client, { ...opts(), apply: true });
  assert.equal(report.created, 0);
  assert.equal(report.updated, 1);
  const [kpi] = await client`SELECT target_value FROM goals WHERE id = ${ids.kpi}`;
  assert.equal(kpi!.target_value, 30);
  const [initiative] = await client`SELECT owner_user_id FROM goals WHERE id = ${ids.initiative}`;
  assert.equal(initiative!.owner_user_id, clientOwner);
  const [{ n }] = await client`SELECT count(*)::int AS n FROM goals WHERE company_id = ${clientCompany}`;
  assert.equal(n, 9);
});

test("a goal id held by another company in the target stops the copy; nothing is written", { skip }, async () => {
  const other = await company(client, "Other company", "OTH");
  const clash = randomUUID();
  await practice`INSERT INTO goals (id, company_id, title, kind) VALUES (${clash}, ${practiceCompany}, 'clash', 'value')`;
  await client`INSERT INTO goals (id, company_id, title) VALUES (${clash}, ${other}, 'other')`;
  await practice`UPDATE goals SET title = 'vision renamed' WHERE id = ${ids.vision}`;
  const before = await tableCounts(client);
  await assert.rejects(copyPlan(practice, client, { ...opts(), apply: true }), /another company/);
  assert.deepEqual(await tableCounts(client), before);
  const [vision] = await client`SELECT title FROM goals WHERE id = ${ids.vision}`;
  assert.equal(vision!.title, "vision");
});
