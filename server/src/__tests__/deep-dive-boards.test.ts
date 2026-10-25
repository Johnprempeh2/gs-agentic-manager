import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  deepDiveHandoffs,
  deepDiveOfferings,
  deepDiveOrgUnits,
  deepDivePeople,
  deepDivePersonTasks,
  deepDiveProcesses,
  instanceSettings,
} from "@greatstone/db";
import { deepDiveProcessArrows, deepDiveTargetState, deepDiveUnplacedPeople } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveBoardsRoutes } from "../routes/deep-dive-boards.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive boards tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause;
    return (cause ?? error) as { code?: string; message?: string };
  }
  throw new Error("The database accepted a write it should refuse");
}

describeEmbeddedPostgres("Deep Dive boards (GRE-2369)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-boards-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveHandoffs);
    await db.delete(deepDiveProcesses);
    await db.delete(deepDiveOfferings);
    await db.delete(deepDivePersonTasks);
    await db.update(deepDiveOrgUnits).set({ leadPersonId: null });
    await db.delete(deepDivePeople);
    await db.delete(deepDiveOrgUnits);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const person: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", deepDiveBoardsRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(prefix: string) {
    await instanceSettingsService(db).updateExperimental({ enableDeepDive: true });
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return company!;
  }

  async function seedAgentActor(companyId: string): Promise<Express.Request["actor"]> {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Deep Dive Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Express.Request["actor"];
  }

  const api = (actor: Express.Request["actor"] = person) => request(app(actor));

  describe("organisation board", () => {
    it("saves units, people, unplaced people and tasks, and reloads them as saved", async () => {
      const company = await seedCompany("DBO");
      let board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "Operations", unitType: "division", headcount: 3 }).expect(201)).body;
      const ops = board.units[0];
      expect(ops).toMatchObject({ name: "Operations", unitType: "division", headcount: 3, parentId: null, visibility: "internal" });

      board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "Field team", parentId: ops.id }).expect(201)).body;
      const field = board.units.find((u: { name: string }) => u.name === "Field team");
      expect(field).toMatchObject({ parentId: ops.id, unitType: "team", position: 1 });

      board = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Ama", role: "Field supervisor", unitId: field.id }).expect(201)).body;
      board = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Kofi" }).expect(201)).body;
      const ama = board.people.find((p: { name: string }) => p.name === "Ama");
      const kofi = board.people.find((p: { name: string }) => p.name === "Kofi");
      expect(deepDiveUnplacedPeople(board.people, board.units).map((p: { name: string }) => p.name)).toEqual(["Kofi"]);

      // Placing Kofi (the drag on the board) and naming the lead are saved.
      await api().patch(`/api/deep-dive/people/${kofi.id}`).send({ unitId: field.id, reportsToId: ama.id }).expect(200);
      await api().patch(`/api/deep-dive/org-units/${field.id}`).send({ leadPersonId: ama.id }).expect(200);

      // Target state: 40 hours freed of 60 recorded is one whole person, rounded down.
      await api().post(`/api/deep-dive/people/${ama.id}/tasks`).send({ what: "Schedule visits", hoursPerWeek: 20, fate: "automated" }).expect(201);
      await api().post(`/api/deep-dive/people/${ama.id}/tasks`).send({ what: "Check reports", hoursPerWeek: 20, fate: "agentic" }).expect(201);
      board = (await api().post(`/api/deep-dive/people/${kofi.id}/tasks`).send({ what: "Hand over shifts", hoursPerWeek: 20, fate: "moves" }).expect(201)).body;

      const reloaded = (await api().get(`/api/companies/${company.id}/deep-dive/organisation`).expect(200)).body;
      expect(reloaded).toEqual(board);
      expect(reloaded.people.find((p: { id: string }) => p.id === kofi.id)).toMatchObject({ unitId: field.id, reportsToId: ama.id });
      expect(reloaded.units.find((u: { id: string }) => u.id === field.id).leadPersonId).toBe(ama.id);
      expect(deepDiveUnplacedPeople(reloaded.people, reloaded.units)).toEqual([]);
      expect(deepDiveTargetState(reloaded)).toMatchObject({ headcountNow: 3, hoursFreed: 40, hoursMoved: 20, peopleFreed: 1, headcountAfter: 2 });
    });

    it("removing a unit moves the units under it to the top and leaves its people unplaced", async () => {
      const company = await seedCompany("DBR");
      let board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "Top" }).expect(201)).body;
      const top = board.units[0];
      board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "Under", parentId: top.id }).expect(201)).body;
      await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Esi", unitId: top.id }).expect(201);
      board = (await api().delete(`/api/deep-dive/org-units/${top.id}`).expect(200)).body;
      expect(board.units).toHaveLength(1);
      expect(board.units[0]).toMatchObject({ name: "Under", parentId: null });
      expect(deepDiveUnplacedPeople(board.people, board.units).map((p: { name: string }) => p.name)).toEqual(["Esi"]);
    });

    it("refuses a unit inside itself and a reporting loop", async () => {
      const company = await seedCompany("DBC");
      let board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "A" }).expect(201)).body;
      const a = board.units[0];
      board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "B", parentId: a.id }).expect(201)).body;
      const b = board.units.find((u: { name: string }) => u.name === "B");
      const loop = await api().patch(`/api/deep-dive/org-units/${a.id}`).send({ parentId: b.id }).expect(422);
      expect(loop.body.error).toMatch(/inside itself/);

      board = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Boss" }).expect(201)).body;
      const boss = board.people[0];
      board = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Report", reportsToId: boss.id }).expect(201)).body;
      const report = board.people.find((p: { name: string }) => p.name === "Report");
      await api().patch(`/api/deep-dive/people/${boss.id}`).send({ reportsToId: report.id }).expect(422);
      await api().patch(`/api/deep-dive/people/${boss.id}`).send({ reportsToId: boss.id }).expect(422);
    });
  });

  describe("process board", () => {
    async function seedBoard(companyId: string) {
      let board = (await api().post(`/api/companies/${companyId}/deep-dive/offerings`).send({ name: "Field surveys" }).expect(201)).body;
      const lane = board.offerings[0];
      for (const name of ["Plan the wave", "Run interviews", "Clean the data"]) {
        board = (await api().post(`/api/companies/${companyId}/deep-dive/processes`).send({ name, offeringId: lane.id }).expect(201)).body;
      }
      const byName = (name: string) => board.processes.find((p: { name: string }) => p.name === name);
      return { lane, plan: byName("Plan the wave"), run: byName("Run interviews"), clean: byName("Clean the data") };
    }

    it("saves and reloads card positions, lanes and handoffs", async () => {
      const company = await seedCompany("DBP");
      const { lane, plan, run } = await seedBoard(company.id);
      expect(plan).toMatchObject({ offeringId: lane.id, x: null, y: null, visibility: "internal" });

      await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`)
        .send({ positions: [{ processId: plan.id, x: 40, y: 20 }, { processId: run.id, x: 320, y: 20 }] }).expect(200);
      const saved = (await api().post(`/api/companies/${company.id}/deep-dive/handoffs`)
        .send({ fromProcessId: plan.id, toProcessId: run.id, what: "The wave plan" }).expect(201)).body;

      const reloaded = (await api().get(`/api/companies/${company.id}/deep-dive/process-board`).expect(200)).body;
      expect(reloaded).toEqual(saved);
      expect(reloaded.processes.find((p: { id: string }) => p.id === plan.id)).toMatchObject({ x: 40, y: 20 });
      expect(reloaded.handoffs).toEqual([
        expect.objectContaining({ fromProcessId: plan.id, toProcessId: run.id, what: "The wave plan", visibility: "internal" }),
      ]);

      // Tidy up: null puts a card back in its automatic place.
      const tidy = (await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`)
        .send({ positions: [{ processId: plan.id, x: null, y: null }] }).expect(200)).body;
      expect(tidy.processes.find((p: { id: string }) => p.id === plan.id)).toMatchObject({ x: null, y: null });
      await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`)
        .send({ positions: [{ processId: plan.id, x: 10, y: null }] }).expect(422);

      // Moving a process to another lane places it automatically there.
      const moved = (await api().patch(`/api/deep-dive/processes/${run.id}`).send({ offeringId: null }).expect(200)).body;
      expect(moved.processes.find((p: { id: string }) => p.id === run.id)).toMatchObject({ offeringId: null, x: null, y: null });
    });

    it("draws an arrow only where a handoff is recorded", async () => {
      const company = await seedCompany("DBA");
      const { plan, run, clean } = await seedBoard(company.id);

      // Cards laid out left to right in a row: position is layout, never an arrow.
      let board = (await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`).send({
        positions: [
          { processId: plan.id, x: 0, y: 0 },
          { processId: run.id, x: 300, y: 0 },
          { processId: clean.id, x: 600, y: 0 },
        ],
      }).expect(200)).body;
      expect(board.handoffs).toEqual([]);
      expect(deepDiveProcessArrows(board)).toEqual([]);

      // A handoff with nothing named is not recorded, and a process cannot hand off to itself.
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`).send({ fromProcessId: plan.id, toProcessId: run.id }).expect(400);
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`).send({ fromProcessId: plan.id, toProcessId: run.id, what: "  " }).expect(400);
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`).send({ fromProcessId: plan.id, toProcessId: plan.id, what: "x" }).expect(422);
      // Neither a layout nor a process can carry an arrow.
      await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`)
        .send({ positions: [{ processId: plan.id, x: 0, y: 0, feeds: [run.id] }] }).expect(400);
      await api().patch(`/api/deep-dive/processes/${plan.id}`).send({ feeds: [run.id] }).expect(400);
      board = (await api().get(`/api/companies/${company.id}/deep-dive/process-board`).expect(200)).body;
      expect(deepDiveProcessArrows(board)).toEqual([]);

      board = (await api().post(`/api/companies/${company.id}/deep-dive/handoffs`)
        .send({ fromProcessId: plan.id, toProcessId: run.id, what: "The wave plan" }).expect(201)).body;
      const handoff = board.handoffs[0];
      expect(deepDiveProcessArrows(board)).toEqual([
        { handoffId: handoff.id, fromProcessId: plan.id, toProcessId: run.id, what: "The wave plan" },
      ]);
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`)
        .send({ fromProcessId: plan.id, toProcessId: run.id, what: "Again" }).expect(409);

      // Removing the handoff removes the arrow; removing a process removes its handoffs.
      board = (await api().delete(`/api/deep-dive/handoffs/${handoff.id}`).expect(200)).body;
      expect(deepDiveProcessArrows(board)).toEqual([]);
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`).send({ fromProcessId: run.id, toProcessId: clean.id, what: "Interviews" }).expect(201);
      board = (await api().delete(`/api/deep-dive/processes/${clean.id}`).expect(200)).body;
      expect(board.handoffs).toEqual([]);
      expect(deepDiveProcessArrows(board)).toEqual([]);
    });

    it("keeps a handoff inside one company and on its two processes, for any writer", async () => {
      const company = await seedCompany("DBH");
      const other = await seedCompany("DBX");
      const { plan, run } = await seedBoard(company.id);
      const theirs = await seedBoard(other.id);

      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`)
        .send({ fromProcessId: plan.id, toProcessId: theirs.plan.id, what: "Leak" }).expect(422);
      expect((await refused(db.insert(deepDiveHandoffs).values({
        companyId: company.id, fromProcessId: plan.id, toProcessId: theirs.run.id, what: "Leak",
      }))).code).toBe("23514");
      expect((await refused(db.insert(deepDiveHandoffs).values({
        companyId: company.id, fromProcessId: plan.id, toProcessId: plan.id, what: "Self",
      }))).code).toBe("23514");
      expect((await refused(db.insert(deepDiveHandoffs).values({
        companyId: company.id, fromProcessId: plan.id, toProcessId: run.id, what: " ",
      }))).code).toBe("23514");

      const [handoff] = await db.insert(deepDiveHandoffs).values({
        companyId: company.id, fromProcessId: plan.id, toProcessId: run.id, what: "Plan",
      }).returning();
      expect((await refused(
        db.update(deepDiveHandoffs).set({ toProcessId: theirs.run.id }).where(eq(deepDiveHandoffs.id, handoff!.id)),
      )).code).toBe("23514");
      // A process cannot be placed in another company's lane.
      await api().patch(`/api/deep-dive/processes/${plan.id}`).send({ offeringId: theirs.lane.id }).expect(422);
      await api().put(`/api/companies/${company.id}/deep-dive/process-board/layout`)
        .send({ positions: [{ processId: theirs.plan.id, x: 0, y: 0 }] }).expect(422);
    });
  });

  describe("access", () => {
    it("keeps another company out, makes items Internal, and lets only a person share", async () => {
      const company = await seedCompany("DBS");
      const other = await seedCompany("DBT");
      const outsider = await seedAgentActor(other.id);
      const insider = await seedAgentActor(company.id);

      await api(outsider).get(`/api/companies/${company.id}/deep-dive/organisation`).expect(403);
      await api(outsider).get(`/api/companies/${company.id}/deep-dive/process-board`).expect(403);
      const board = (await api(insider).post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Yaw" }).expect(201)).body;
      const yaw = board.people[0];
      expect(yaw.visibility).toBe("internal");
      await api(outsider).patch(`/api/deep-dive/people/${yaw.id}`).send({ name: "x" }).expect(403);
      await api(outsider).delete(`/api/deep-dive/people/${yaw.id}`).expect(403);

      await api(insider).patch(`/api/deep-dive/people/${yaw.id}`).send({ visibility: "shared" }).expect(403);
      const shared = (await api().patch(`/api/deep-dive/people/${yaw.id}`).send({ visibility: "shared" }).expect(200)).body;
      expect(shared.people[0].visibility).toBe("shared");

      // Nothing is created Shared, even by a direct write.
      expect((await refused(db.insert(deepDiveOfferings).values({ companyId: company.id, name: "x", visibility: "shared" }))).code).toBe("23514");
      await api().post(`/api/companies/${company.id}/deep-dive/offerings`).send({ name: "x", visibility: "shared" }).expect(400);
      await api().delete(`/api/deep-dive/processes/${randomUUID()}`).expect(404);
    });

    it("removes a company with both boards filled in", async () => {
      const company = await seedCompany("DBZ");
      let board = (await api().post(`/api/companies/${company.id}/deep-dive/org-units`).send({ name: "Top" }).expect(201)).body;
      board = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Lead", unitId: board.units[0].id }).expect(201)).body;
      await api().patch(`/api/deep-dive/org-units/${board.units[0].id}`).send({ leadPersonId: board.people[0].id }).expect(200);
      const lane = (await api().post(`/api/companies/${company.id}/deep-dive/offerings`).send({ name: "Lane" }).expect(201)).body.offerings[0];
      await api().post(`/api/companies/${company.id}/deep-dive/processes`).send({ name: "A", offeringId: lane.id, runsPersonId: board.people[0].id }).expect(201);
      const processes = (await api().post(`/api/companies/${company.id}/deep-dive/processes`).send({ name: "B" }).expect(201)).body.processes;
      await api().post(`/api/companies/${company.id}/deep-dive/handoffs`).send({ fromProcessId: processes[0].id, toProcessId: processes[1].id, what: "x" }).expect(201);

      await companyService(db).remove(company.id);
      expect(await db.select().from(deepDiveProcesses).where(eq(deepDiveProcesses.companyId, company.id))).toEqual([]);
      expect(await db.select().from(deepDivePeople).where(eq(deepDivePeople.companyId, company.id))).toEqual([]);
    });
  });
});
