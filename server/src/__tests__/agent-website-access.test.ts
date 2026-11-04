import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { setAgentWebsiteAccess } from "../services/agent-website-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent website access (GRE-2239)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-website-access-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithOtherGrants() {
    const company = await db
      .insert(companies)
      .values({ name: `Website Access ${randomUUID()}`, issuePrefix: `WA${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Lintel", role: "general", status: "idle", adapterType: "process" })
      .returning()
      .then((rows) => rows[0]!);
    const access = accessService(db);
    await access.ensureMembership(company.id, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(company.id, "agent", agent.id, "agents:configure", true, "board-user");
    await access.setPrincipalPermission(company.id, "agent", agent.id, "tasks:assign", true, "board-user");
    await access.setPrincipalPermission(
      company.id, "agent", agent.id, "pipelines:cases", true, "board-user", { pipelineIds: [randomUUID()] },
    );
    return { access, companyId: company.id, agentId: agent.id };
  }

  function grantSummary(grants: Array<{ permissionKey: string; scope: unknown }>) {
    return grants.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope }));
  }

  it("grants view, then edit, then sets back to none, leaving other grants unchanged", async () => {
    const { access, companyId, agentId } = await seedAgentWithOtherGrants();
    const otherGrants = grantSummary(await access.listPrincipalGrants(companyId, "agent", agentId));
    const websiteKeys = async () =>
      (await access.listPrincipalGrants(companyId, "agent", agentId))
        .map((grant) => grant.permissionKey)
        .filter((key) => key.startsWith("website:"));
    const nonWebsite = async () =>
      grantSummary(await access.listPrincipalGrants(companyId, "agent", agentId))
        .filter((grant) => !grant.permissionKey.startsWith("website:"));

    expect(await setAgentWebsiteAccess(access, { companyId, agentId, level: "view", grantedByUserId: "board-user" }))
      .toEqual({ before: { level: "none", siteIds: null }, after: { level: "view", siteIds: null } });
    expect(await websiteKeys()).toEqual(["website:view"]);
    expect(await nonWebsite()).toEqual(otherGrants);

    expect(await setAgentWebsiteAccess(access, { companyId, agentId, level: "edit", grantedByUserId: "board-user" }))
      .toEqual({ before: { level: "view", siteIds: null }, after: { level: "edit", siteIds: null } });
    expect(await websiteKeys()).toEqual(["website:edit", "website:view"]);
    expect(await nonWebsite()).toEqual(otherGrants);

    expect(await setAgentWebsiteAccess(access, { companyId, agentId, level: "none", grantedByUserId: "board-user" }))
      .toEqual({ before: { level: "edit", siteIds: null }, after: { level: "none", siteIds: null } });
    expect(await websiteKeys()).toEqual([]);
    expect(await nonWebsite()).toEqual(otherGrants);
  });

  it("lets an agent with edit work on drafts but never publish", async () => {
    const { access, companyId, agentId } = await seedAgentWithOtherGrants();
    await setAgentWebsiteAccess(access, { companyId, agentId, level: "edit", grantedByUserId: "board-user" });

    const decide = (action: "website:edit" | "website:publish") =>
      access.decide({ actor: { type: "agent", agentId, companyId, source: "agent_key" }, action, resource: { type: "company", companyId } });
    expect((await decide("website:edit")).allowed).toBe(true);
    expect((await decide("website:publish")).allowed).toBe(false);

    await expect(
      access.setPrincipalPermission(companyId, "agent", agentId, "website:publish", true, "board-user"),
    ).rejects.toMatchObject({ status: 422 });
    const keys = (await access.listPrincipalGrants(companyId, "agent", agentId)).map((grant) => grant.permissionKey);
    expect(keys).not.toContain("website:publish");
  });

  it("limits view to one chosen site, then removes it (GRE-3992)", async () => {
    const { access, companyId, agentId } = await seedAgentWithOtherGrants();
    const siteId = "33333333-3333-4333-8333-333333333333";
    const otherSiteId = "44444444-4444-4444-8444-444444444444";

    expect(await setAgentWebsiteAccess(access, { companyId, agentId, level: "view", siteId, grantedByUserId: "board-user" }))
      .toEqual({ before: { level: "none", siteIds: null }, after: { level: "view", siteIds: [siteId] } });
    const decide = (site: string | null) =>
      access.decide({
        actor: { type: "agent", agentId, companyId, source: "agent_key" },
        action: "website:view",
        resource: { type: "company", companyId },
        scope: site ? { siteId: site } : null,
      });
    expect((await decide(siteId)).allowed).toBe(true);
    expect((await decide(otherSiteId)).allowed).toBe(false);

    expect(await setAgentWebsiteAccess(access, { companyId, agentId, level: "none", grantedByUserId: "board-user" }))
      .toEqual({ before: { level: "view", siteIds: [siteId] }, after: { level: "none", siteIds: null } });
    expect((await decide(siteId)).allowed).toBe(false);
  });
});
