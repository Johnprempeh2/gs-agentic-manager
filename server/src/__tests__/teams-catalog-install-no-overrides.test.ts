import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, routineTriggers, routines } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamsCatalogService } from "../services/teams-catalog.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres teams catalog no-overrides install tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("teams catalog install with no caller adapter overrides", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome: string | null = null;
  let oldPaperclipHome: string | undefined;

  beforeAll(async () => {
    oldPaperclipHome = process.env.GSAM_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-teams-catalog-no-overrides-"));
    process.env.GSAM_HOME = tempHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-catalog-no-overrides-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.GSAM_HOME;
    else process.env.GSAM_HOME = oldPaperclipHome;
    if (tempHome) await fs.rm(tempHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedEmptyCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Clean install company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function listAdapterTypesByName(companyId: string) {
    const rows = await db
      .select({
        name: agents.name,
        role: agents.role,
        adapterType: agents.adapterType,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    return new Map(rows.map((row) => [row.name, row]));
  }

  it("installs core-exec-team end-to-end with no caller overrides and creates 3 claude_local agents", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(3);

    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["claude_local", "claude_local", "claude_local"]);
    expect(adapterTypes).not.toContain("process");
    expect(adapterTypes).not.toContain("http");
  });

  it("installs product-design end-to-end with no caller overrides and uses claude_local", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "product-design", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(1);
    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["claude_local"]);
    expect(adapterTypes).not.toContain("process");
  });

  it("installs product-engineering end-to-end with no caller overrides and uses claude_local for every agent", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "product-engineering", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(3);
    const adapterTypes = Array.from(byName.values()).map((row) => row.adapterType);
    expect(adapterTypes).toEqual(["claude_local", "claude_local", "claude_local"]);
    expect(adapterTypes).not.toContain("process");
    expect(byName.get("CTO")?.permissions).toMatchObject({ canCreateAgents: true });
  });

  it.each([
    {
      slug: "research-and-reporting",
      agents: 3,
      schedules: ["0 9 1 * *"],
      starterTasks: ["Plan the first study"],
      maxDailyRuns: {},
    },
    {
      slug: "executive-assistant",
      agents: 1,
      schedules: ["0 15 * * 5", "0 8 * * 1-5"],
      starterTasks: ["Learn the owner's priorities and templates"],
      maxDailyRuns: {},
    },
    {
      slug: "marketing-content",
      agents: 4,
      schedules: ["0 9 * * 1", "0 11 * * 1-5", "30 9 * * 1-5", "0 12 * * 5", "0 9 1 * *"],
      starterTasks: ["Set the results baseline", "Write the brand voice guide"],
      maxDailyRuns: { "Marketing Lead": 6, "Content Writer": 10, "Social Media Coordinator": 8, "Marketing Analyst": 2 },
    },
    {
      slug: "operations-team",
      agents: 4,
      schedules: ["0 8 * * 1-5", "0 16 * * 1-5", "0 14 * * 5", "0 9 1 * *", "0 11 1 * *"],
      starterTasks: ["Agree the status report template", "Map meetings, reports and owners"],
      maxDailyRuns: { "Operations Coordinator": 8, "Minutes Taker": 8, "Operations Reporter": 4, "Policy Writer": 4 },
    },
  ])("installs the Greatstone $slug team with its routines paused on schedule", async ({
    slug,
    agents: agentCount,
    schedules,
    starterTasks,
    maxDailyRuns,
  }) => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    // Routines need a responsible user; in the product that is the board user
    // installing the team, which is the team's one human overseer.
    await svc.installCatalogTeam(companyId, slug, {
      collisionStrategy: "rename",
      actor: { actorType: "user", actorId: "overseer-1", userId: "overseer-1" },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(agentCount);
    expect(Array.from(byName.values()).every((row) => row.adapterType === "claude_local")).toBe(true);

    const installedRoutines = await db
      .select({
        status: routines.status,
        responsibleUserId: routines.responsibleUserId,
        cronExpression: routineTriggers.cronExpression,
        timezone: routineTriggers.timezone,
      })
      .from(routines)
      .innerJoin(routineTriggers, eq(routineTriggers.routineId, routines.id))
      .where(eq(routines.companyId, companyId));
    expect(installedRoutines.map((row) => row.status)).toEqual(schedules.map(() => "paused"));
    expect(installedRoutines.map((row) => row.cronExpression).sort()).toEqual([...schedules].sort());
    expect(installedRoutines.every((row) => row.timezone === "Europe/London")).toBe(true);
    expect(installedRoutines.every((row) => row.responsibleUserId === "overseer-1")).toBe(true);

    // Starter tasks (GRE-434) land in the backlog, assigned, so nothing runs until the overseer moves them.
    const installedTasks = await db
      .select({ title: issues.title, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(installedTasks.map((row) => row.title).sort()).toEqual(starterTasks);
    expect(installedTasks.every((row) => row.status === "backlog" && row.assigneeAgentId)).toBe(true);

    // Daily run limits from the template's sidecar.
    const runLimits = await db
      .select({ name: agents.name, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    for (const [name, limit] of Object.entries(maxDailyRuns)) {
      const row = runLimits.find((entry) => entry.name === name);
      expect((row?.runtimeConfig as { heartbeat?: { maxDailyRuns?: number } })?.heartbeat?.maxDailyRuns, name).toBe(limit);
    }
  });

  it("honors an explicit caller adapter override for a single slug while defaulting the rest to claude_local", async () => {
    const companyId = await seedEmptyCompany();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
      adapterOverrides: {
        cto: { adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-opus-4" } },
      },
    });

    const byName = await listAdapterTypesByName(companyId);
    expect(byName.size).toBe(3);
    const ctoRow = Array.from(byName.values()).find((row) => row.role === "engineering-manager" || row.name === "CTO");
    expect(ctoRow?.adapterType).toBe("opencode_local");
    const otherAdapters = Array.from(byName.values())
      .filter((row) => row !== ctoRow)
      .map((row) => row.adapterType);
    expect(otherAdapters).toEqual(["claude_local", "claude_local"]);
  });
});
