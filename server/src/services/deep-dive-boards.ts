import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  deepDiveHandoffs,
  deepDiveOfferings,
  deepDiveOrgUnits,
  deepDivePeople,
  deepDivePersonTasks,
  deepDiveProcesses,
} from "@greatstone/db";
import type {
  CreateDeepDiveOffering,
  CreateDeepDivePerson,
  CreateDeepDiveProcess,
  CreateDeepDiveTask,
  CreateDeepDiveUnit,
  DeepDiveOrgBoard,
  DeepDivePersonSide,
  DeepDiveProcessBoard,
  DeepDiveTaskFate,
  DeepDiveUnitType,
  DeepDiveVisibility,
  RecordDeepDiveHandoff,
  SaveDeepDiveProcessLayout,
  UpdateDeepDiveHandoff,
  UpdateDeepDiveOffering,
  UpdateDeepDivePerson,
  UpdateDeepDiveProcess,
  UpdateDeepDiveTask,
  UpdateDeepDiveUnit,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { inRecord, scopeOfRow, type DeepDiveScope } from "./deep-dive-scope.js";
import type { DeepDiveFindingActor } from "./deep-dive-findings.js";

// Deep Dive boards (GRE-2369): Screens 5 and 6 of the GRE-2327 plan. Every
// write returns the whole board it changed, so the page reloads exactly what
// was saved. The deep_dive_board_guard trigger in migration 0399 keeps every
// link inside the company and refuses cycles for any writer; this service
// turns its refusals into 422s. Arrows on the process board are handoff rows:
// saving a layout touches only x and y and cannot draw one.

export type DeepDiveBoardActor = DeepDiveFindingActor;

export const DEEP_DIVE_BOARD_KINDS = {
  unit: { table: deepDiveOrgUnits, label: "Unit" },
  person: { table: deepDivePeople, label: "Person" },
  task: { table: deepDivePersonTasks, label: "Task" },
  offering: { table: deepDiveOfferings, label: "Offering" },
  process: { table: deepDiveProcesses, label: "Process" },
  handoff: { table: deepDiveHandoffs, label: "Handoff" },
} as const;
export type DeepDiveBoardKind = keyof typeof DEEP_DIVE_BOARD_KINDS;

function asBoardError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string; constraint_name?: string };
  if (cause?.constraint_name === "deep_dive_kpis_owner_person_id_deep_dive_people_id_fk") {
    return conflict("This person owns a KPI. Give the KPI another owner first");
  }
  if (cause?.code === "23505") return conflict("This handoff is already recorded");
  if (cause?.code === "23503") return unprocessable("That link points at something that is not on this board");
  if (cause?.code === "23514" && cause.message) return unprocessable(cause.message);
  return error;
}

async function write<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw asBoardError(error);
  });
}

function onlyPersonShares(input: { visibility?: DeepDiveVisibility }, actor: DeepDiveBoardActor) {
  if (input.visibility !== undefined && actor.type !== "user") {
    throw forbidden("Only a person can share or unshare a Deep Dive item");
  }
}

/** Drop keys the caller did not send, so a PATCH never blanks what it did not name. */
function sent<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function deepDiveBoardsService(db: Db) {
  /** The Deep Dive a row belongs to. Tasks and handoffs belong to their person's and process's. */
  async function scopeOf(kind: DeepDiveBoardKind, id: string): Promise<DeepDiveScope> {
    const { label } = DEEP_DIVE_BOARD_KINDS[kind];
    const owner = kind === "task"
      ? db.select({ companyId: deepDivePeople.companyId, recordCaseId: deepDivePeople.recordCaseId }).from(deepDivePersonTasks)
        .innerJoin(deepDivePeople, eq(deepDivePeople.id, deepDivePersonTasks.personId)).where(eq(deepDivePersonTasks.id, id))
      : kind === "handoff"
        ? db.select({ companyId: deepDiveProcesses.companyId, recordCaseId: deepDiveProcesses.recordCaseId }).from(deepDiveHandoffs)
          .innerJoin(deepDiveProcesses, eq(deepDiveProcesses.id, deepDiveHandoffs.fromProcessId)).where(eq(deepDiveHandoffs.id, id))
        : (() => {
          const table = DEEP_DIVE_BOARD_KINDS[kind].table as typeof deepDiveOrgUnits;
          return db.select({ companyId: table.companyId, recordCaseId: table.recordCaseId }).from(table).where(eq(table.id, id));
        })();
    const row = await owner.then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`${label} not found`);
    return scopeOfRow(row, label);
  }

  async function nextPosition(table: typeof deepDiveOrgUnits | typeof deepDiveOfferings, scope: DeepDiveScope) {
    const [row] = await db
      .select({ max: sql<number | null>`max(${table.position})` })
      .from(table)
      .where(inRecord(table, scope));
    return (row?.max ?? -1) + 1;
  }

  async function orgBoard(scope: DeepDiveScope): Promise<DeepDiveOrgBoard> {
    const [units, people, allTasks] = await Promise.all([
      db.select().from(deepDiveOrgUnits).where(inRecord(deepDiveOrgUnits, scope))
        .orderBy(asc(deepDiveOrgUnits.position), asc(deepDiveOrgUnits.createdAt)),
      db.select().from(deepDivePeople).where(inRecord(deepDivePeople, scope))
        .orderBy(asc(deepDivePeople.name), asc(deepDivePeople.createdAt)),
      db.select().from(deepDivePersonTasks).where(eq(deepDivePersonTasks.companyId, scope.companyId))
        .orderBy(asc(deepDivePersonTasks.createdAt)),
    ]);
    const personIds = new Set(people.map((p) => p.id));
    const tasks = allTasks.filter((t) => personIds.has(t.personId));
    return {
      companyId: scope.companyId,
      units: units.map((u) => ({
        id: u.id,
        name: u.name,
        unitType: u.unitType as DeepDiveUnitType,
        parentId: u.parentId,
        leadPersonId: u.leadPersonId,
        headcount: u.headcount,
        position: u.position,
        visibility: u.visibility as DeepDiveVisibility,
      })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        side: p.side as DeepDivePersonSide,
        unitId: p.unitId,
        reportsToId: p.reportsToId,
        visibility: p.visibility as DeepDiveVisibility,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        personId: t.personId,
        what: t.what,
        hoursPerWeek: t.hoursPerWeek === null ? null : Number(t.hoursPerWeek),
        fate: t.fate as DeepDiveTaskFate,
        why: t.why,
        visibility: t.visibility as DeepDiveVisibility,
      })),
    };
  }

  async function processBoard(scope: DeepDiveScope): Promise<DeepDiveProcessBoard> {
    const [offerings, processes, allHandoffs, people, units] = await Promise.all([
      db.select().from(deepDiveOfferings).where(inRecord(deepDiveOfferings, scope))
        .orderBy(asc(deepDiveOfferings.position), asc(deepDiveOfferings.createdAt)),
      db.select().from(deepDiveProcesses).where(inRecord(deepDiveProcesses, scope))
        .orderBy(asc(deepDiveProcesses.createdAt)),
      db.select().from(deepDiveHandoffs).where(eq(deepDiveHandoffs.companyId, scope.companyId))
        .orderBy(asc(deepDiveHandoffs.createdAt)),
      db.select({ id: deepDivePeople.id, name: deepDivePeople.name }).from(deepDivePeople)
        .where(inRecord(deepDivePeople, scope)).orderBy(asc(deepDivePeople.name)),
      db.select({ id: deepDiveOrgUnits.id, name: deepDiveOrgUnits.name }).from(deepDiveOrgUnits)
        .where(inRecord(deepDiveOrgUnits, scope)).orderBy(asc(deepDiveOrgUnits.name)),
    ]);
    const processIds = new Set(processes.map((p) => p.id));
    const handoffs = allHandoffs.filter((h) => processIds.has(h.fromProcessId));
    return {
      companyId: scope.companyId,
      offerings: offerings.map((o) => ({
        id: o.id,
        name: o.name,
        position: o.position,
        visibility: o.visibility as DeepDiveVisibility,
      })),
      processes: processes.map((p) => ({
        id: p.id,
        name: p.name,
        offeringId: p.offeringId,
        runsPersonId: p.runsPersonId,
        unitId: p.unitId,
        x: p.x,
        y: p.y,
        visibility: p.visibility as DeepDiveVisibility,
      })),
      handoffs: handoffs.map((h) => ({
        id: h.id,
        fromProcessId: h.fromProcessId,
        toProcessId: h.toProcessId,
        what: h.what,
        visibility: h.visibility as DeepDiveVisibility,
      })),
      people,
      units,
    };
  }

  return {
    scopeOf,
    companyOf: async (kind: DeepDiveBoardKind, id: string) => (await scopeOf(kind, id)).companyId,
    orgBoard,
    processBoard,

    // Organisation board ----------------------------------------------------

    createUnit: async (scope: DeepDiveScope, input: CreateDeepDiveUnit) => {
      const position = await nextPosition(deepDiveOrgUnits, scope);
      await write(db.insert(deepDiveOrgUnits).values({ ...scope, position, ...input }));
      return orgBoard(scope);
    },

    updateUnit: async (unitId: string, input: UpdateDeepDiveUnit, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("unit", unitId);
      await write(db.update(deepDiveOrgUnits).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDiveOrgUnits.id, unitId)));
      return orgBoard(scope);
    },

    /** Units under it move to the top level and its people become unplaced: nothing vanishes with it. */
    deleteUnit: async (unitId: string) => {
      const scope = await scopeOf("unit", unitId);
      await write(db.delete(deepDiveOrgUnits).where(eq(deepDiveOrgUnits.id, unitId)));
      return orgBoard(scope);
    },

    createPerson: async (scope: DeepDiveScope, input: CreateDeepDivePerson) => {
      await write(db.insert(deepDivePeople).values({ ...scope, ...input }));
      return orgBoard(scope);
    },

    updatePerson: async (personId: string, input: UpdateDeepDivePerson, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("person", personId);
      await write(db.update(deepDivePeople).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDivePeople.id, personId)));
      return orgBoard(scope);
    },

    /** Their tasks go with them; units they led and processes they ran keep going without a name. */
    deletePerson: async (personId: string) => {
      const scope = await scopeOf("person", personId);
      await write(db.delete(deepDivePeople).where(eq(deepDivePeople.id, personId)));
      return orgBoard(scope);
    },

    createTask: async (personId: string, input: CreateDeepDiveTask) => {
      const scope = await scopeOf("person", personId);
      await write(db.insert(deepDivePersonTasks).values({ companyId: scope.companyId, personId, ...input }));
      return orgBoard(scope);
    },

    updateTask: async (taskId: string, input: UpdateDeepDiveTask, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("task", taskId);
      await write(db.update(deepDivePersonTasks).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDivePersonTasks.id, taskId)));
      return orgBoard(scope);
    },

    deleteTask: async (taskId: string) => {
      const scope = await scopeOf("task", taskId);
      await write(db.delete(deepDivePersonTasks).where(eq(deepDivePersonTasks.id, taskId)));
      return orgBoard(scope);
    },

    // Process board ---------------------------------------------------------

    createOffering: async (scope: DeepDiveScope, input: CreateDeepDiveOffering) => {
      const position = await nextPosition(deepDiveOfferings, scope);
      await write(db.insert(deepDiveOfferings).values({ ...scope, position, name: input.name }));
      return processBoard(scope);
    },

    updateOffering: async (offeringId: string, input: UpdateDeepDiveOffering, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("offering", offeringId);
      await write(db.update(deepDiveOfferings).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDiveOfferings.id, offeringId)));
      return processBoard(scope);
    },

    /** Its processes move to the lane of processes no offering names, placed automatically. */
    deleteOffering: async (offeringId: string) => {
      const scope = await scopeOf("offering", offeringId);
      await write(db.transaction(async (tx) => {
        await tx.update(deepDiveProcesses).set({ x: null, y: null, updatedAt: new Date() }).where(eq(deepDiveProcesses.offeringId, offeringId));
        await tx.delete(deepDiveOfferings).where(eq(deepDiveOfferings.id, offeringId));
      }));
      return processBoard(scope);
    },

    createProcess: async (scope: DeepDiveScope, input: CreateDeepDiveProcess) => {
      await write(db.insert(deepDiveProcesses).values({ ...scope, ...input }));
      return processBoard(scope);
    },

    /** A process moved to another lane is placed automatically there. */
    updateProcess: async (processId: string, input: UpdateDeepDiveProcess, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("process", processId);
      const current = await db.select({ offeringId: deepDiveProcesses.offeringId }).from(deepDiveProcesses)
        .where(eq(deepDiveProcesses.id, processId)).then((rows) => rows[0]!);
      const changesLane = input.offeringId !== undefined && input.offeringId !== current.offeringId;
      await write(db.update(deepDiveProcesses).set({
        ...sent(input),
        ...(changesLane ? { x: null, y: null } : {}),
        updatedAt: new Date(),
      }).where(eq(deepDiveProcesses.id, processId)));
      return processBoard(scope);
    },

    /** Its handoffs go with it, and so do their arrows. */
    deleteProcess: async (processId: string) => {
      const scope = await scopeOf("process", processId);
      await write(db.delete(deepDiveProcesses).where(eq(deepDiveProcesses.id, processId)));
      return processBoard(scope);
    },

    /** Saves where cards sit. Only x and y change; no arrow is drawn or removed. */
    saveLayout: async (scope: DeepDiveScope, input: SaveDeepDiveProcessLayout) => {
      for (const position of input.positions) {
        if ((position.x === null) !== (position.y === null)) throw unprocessable("Give both x and y, or neither");
      }
      const ids = [...new Set(input.positions.map((position) => position.processId))];
      const found = await db.select({ id: deepDiveProcesses.id }).from(deepDiveProcesses)
        .where(and(inRecord(deepDiveProcesses, scope), inArray(deepDiveProcesses.id, ids)));
      if (found.length !== ids.length) throw unprocessable("A process in this layout is not on this board");
      await write(db.transaction(async (tx) => {
        const now = new Date();
        for (const position of input.positions) {
          await tx.update(deepDiveProcesses)
            .set({ x: position.x, y: position.y, updatedAt: now })
            .where(and(eq(deepDiveProcesses.id, position.processId), inRecord(deepDiveProcesses, scope)));
        }
      }));
      return processBoard(scope);
    },

    /** An arrow appears on the board only through this: a handoff with what is handed over. */
    recordHandoff: async (scope: DeepDiveScope, input: RecordDeepDiveHandoff, actor: DeepDiveBoardActor) => {
      if (input.fromProcessId === input.toProcessId) throw unprocessable("A process cannot hand off to itself");
      const ends = await db.select({ id: deepDiveProcesses.id }).from(deepDiveProcesses)
        .where(and(inRecord(deepDiveProcesses, scope), inArray(deepDiveProcesses.id, [input.fromProcessId, input.toProcessId])));
      if (ends.length !== 2) throw unprocessable("Both processes must be on this Deep Dive's board");
      await write(db.insert(deepDiveHandoffs).values({
        companyId: scope.companyId,
        fromProcessId: input.fromProcessId,
        toProcessId: input.toProcessId,
        what: input.what,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
      }));
      return processBoard(scope);
    },

    updateHandoff: async (handoffId: string, input: UpdateDeepDiveHandoff, actor: DeepDiveBoardActor) => {
      onlyPersonShares(input, actor);
      const scope = await scopeOf("handoff", handoffId);
      await write(db.update(deepDiveHandoffs).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDiveHandoffs.id, handoffId)));
      return processBoard(scope);
    },

    /** Removing the handoff removes its arrow. */
    deleteHandoff: async (handoffId: string) => {
      const scope = await scopeOf("handoff", handoffId);
      await write(db.delete(deepDiveHandoffs).where(eq(deepDiveHandoffs.id, handoffId)));
      return processBoard(scope);
    },
  };
}
