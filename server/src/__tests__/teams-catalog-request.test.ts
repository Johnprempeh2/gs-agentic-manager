import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getCatalogTeamOrThrow, teamsCatalogService } from "../services/teams-catalog.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres catalogue request tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Ask Greatstone to add a catalogue team (GRE-434)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-catalog-request-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Request fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    return companyId;
  }

  const actor = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };

  it("creates a board approval card that names the team and installs nothing", async () => {
    const companyId = await seedCompany();
    const team = await getCatalogTeamOrThrow("marketing-content");

    const { approval, created } = await teamsCatalogService(db).requestCatalogTeam(companyId, team, actor);

    expect(created).toBe(true);
    expect(approval).toMatchObject({
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByUserId: "board-user",
    });
    expect(approval.payload).toMatchObject({
      title: "Ask Greatstone to add the Marketing Content Team",
      source: "team_catalog",
      catalogTeamKey: team.key,
    });
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual([]);
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activity.map((row) => row.action)).toEqual(["company.team_catalog_add_requested"]);
  });

  it("reuses the open card for the same team and opens a new one after a decision", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const team = await getCatalogTeamOrThrow("marketing-content");
    const svc = teamsCatalogService(db);

    const first = await svc.requestCatalogTeam(companyId, team, actor);
    const again = await svc.requestCatalogTeam(companyId, team, actor);
    const otherCompany = await svc.requestCatalogTeam(otherCompanyId, team, actor);

    expect(again).toMatchObject({ created: false, approval: { id: first.approval.id } });
    expect(otherCompany.created).toBe(true);
    expect(otherCompany.approval.id).not.toBe(first.approval.id);

    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, first.approval.id));
    const afterDecision = await svc.requestCatalogTeam(companyId, team, actor);
    expect(afterDecision.created).toBe(true);
  });
});
