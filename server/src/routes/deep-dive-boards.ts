import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  createDeepDiveOfferingSchema,
  createDeepDivePersonSchema,
  createDeepDiveProcessSchema,
  createDeepDiveTaskSchema,
  createDeepDiveUnitSchema,
  recordDeepDiveHandoffSchema,
  saveDeepDiveProcessLayoutSchema,
  updateDeepDiveHandoffSchema,
  updateDeepDiveOfferingSchema,
  updateDeepDivePersonSchema,
  updateDeepDiveProcessSchema,
  updateDeepDiveTaskSchema,
  updateDeepDiveUnitSchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { deepDiveBoardsService, type DeepDiveBoardActor, type DeepDiveBoardKind } from "../services/deep-dive-boards.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive boards (GRE-2369): Screens 5 and 6 of the GRE-2327 plan.
// Anyone with access to the company may build either board; only a person
// shares an item. Every write answers with the whole board it changed.

function boardActor(req: Request): DeepDiveBoardActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

export function deepDiveBoardsRoutes(db: Db) {
  const router = Router();
  const boards = deepDiveBoardsService(db);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function companyInScope(req: Request) {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function itemInScope(req: Request, kind: DeepDiveBoardKind, param: string) {
    await assertEnabled();
    const companyId = await boards.companyOf(kind, req.params[param] as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_board",
      entityId,
      details,
    });
  }

  function changed(req: Request) {
    return { changed: Object.keys(req.body ?? {}) };
  }

  function reply(res: Response, status: number, board: unknown) {
    res.status(status).json(board);
  }

  // Organisation board ------------------------------------------------------

  router.get("/companies/:companyId/deep-dive/organisation", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await boards.orgBoard(companyId));
  });

  router.post("/companies/:companyId/deep-dive/org-units", validate(createDeepDiveUnitSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await boards.createUnit(companyId, req.body);
    await log(req, companyId, "deep_dive_board.unit_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/org-units/:unitId", validate(updateDeepDiveUnitSchema), async (req, res) => {
    const companyId = await itemInScope(req, "unit", "unitId");
    const board = await boards.updateUnit(req.params.unitId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.unit_changed", req.params.unitId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/org-units/:unitId", async (req, res) => {
    const companyId = await itemInScope(req, "unit", "unitId");
    const board = await boards.deleteUnit(req.params.unitId as string);
    await log(req, companyId, "deep_dive_board.unit_removed", req.params.unitId as string);
    reply(res, 200, board);
  });

  router.post("/companies/:companyId/deep-dive/people", validate(createDeepDivePersonSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await boards.createPerson(companyId, req.body);
    await log(req, companyId, "deep_dive_board.person_added", companyId);
    reply(res, 201, board);
  });

  router.patch("/deep-dive/people/:personId", validate(updateDeepDivePersonSchema), async (req, res) => {
    const companyId = await itemInScope(req, "person", "personId");
    const board = await boards.updatePerson(req.params.personId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.person_changed", req.params.personId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/people/:personId", async (req, res) => {
    const companyId = await itemInScope(req, "person", "personId");
    const board = await boards.deletePerson(req.params.personId as string);
    await log(req, companyId, "deep_dive_board.person_removed", req.params.personId as string);
    reply(res, 200, board);
  });

  router.post("/deep-dive/people/:personId/tasks", validate(createDeepDiveTaskSchema), async (req, res) => {
    const companyId = await itemInScope(req, "person", "personId");
    const board = await boards.createTask(req.params.personId as string, req.body);
    await log(req, companyId, "deep_dive_board.task_added", req.params.personId as string);
    reply(res, 201, board);
  });

  router.patch("/deep-dive/person-tasks/:taskId", validate(updateDeepDiveTaskSchema), async (req, res) => {
    const companyId = await itemInScope(req, "task", "taskId");
    const board = await boards.updateTask(req.params.taskId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.task_changed", req.params.taskId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/person-tasks/:taskId", async (req, res) => {
    const companyId = await itemInScope(req, "task", "taskId");
    const board = await boards.deleteTask(req.params.taskId as string);
    await log(req, companyId, "deep_dive_board.task_removed", req.params.taskId as string);
    reply(res, 200, board);
  });

  // Process board -----------------------------------------------------------

  router.get("/companies/:companyId/deep-dive/process-board", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await boards.processBoard(companyId));
  });

  router.put(
    "/companies/:companyId/deep-dive/process-board/layout",
    validate(saveDeepDiveProcessLayoutSchema),
    async (req, res) => {
      const companyId = await companyInScope(req);
      const board = await boards.saveLayout(companyId, req.body);
      await log(req, companyId, "deep_dive_board.layout_saved", companyId, { cards: req.body.positions.length });
      reply(res, 200, board);
    },
  );

  router.post("/companies/:companyId/deep-dive/offerings", validate(createDeepDiveOfferingSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await boards.createOffering(companyId, req.body);
    await log(req, companyId, "deep_dive_board.offering_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/offerings/:offeringId", validate(updateDeepDiveOfferingSchema), async (req, res) => {
    const companyId = await itemInScope(req, "offering", "offeringId");
    const board = await boards.updateOffering(req.params.offeringId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.offering_changed", req.params.offeringId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/offerings/:offeringId", async (req, res) => {
    const companyId = await itemInScope(req, "offering", "offeringId");
    const board = await boards.deleteOffering(req.params.offeringId as string);
    await log(req, companyId, "deep_dive_board.offering_removed", req.params.offeringId as string);
    reply(res, 200, board);
  });

  router.post("/companies/:companyId/deep-dive/processes", validate(createDeepDiveProcessSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await boards.createProcess(companyId, req.body);
    await log(req, companyId, "deep_dive_board.process_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/processes/:processId", validate(updateDeepDiveProcessSchema), async (req, res) => {
    const companyId = await itemInScope(req, "process", "processId");
    const board = await boards.updateProcess(req.params.processId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.process_changed", req.params.processId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/processes/:processId", async (req, res) => {
    const companyId = await itemInScope(req, "process", "processId");
    const board = await boards.deleteProcess(req.params.processId as string);
    await log(req, companyId, "deep_dive_board.process_removed", req.params.processId as string);
    reply(res, 200, board);
  });

  router.post("/companies/:companyId/deep-dive/handoffs", validate(recordDeepDiveHandoffSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await boards.recordHandoff(companyId, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.handoff_recorded", companyId, {
      fromProcessId: req.body.fromProcessId,
      toProcessId: req.body.toProcessId,
    });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/handoffs/:handoffId", validate(updateDeepDiveHandoffSchema), async (req, res) => {
    const companyId = await itemInScope(req, "handoff", "handoffId");
    const board = await boards.updateHandoff(req.params.handoffId as string, req.body, boardActor(req));
    await log(req, companyId, "deep_dive_board.handoff_changed", req.params.handoffId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/handoffs/:handoffId", async (req, res) => {
    const companyId = await itemInScope(req, "handoff", "handoffId");
    const board = await boards.deleteHandoff(req.params.handoffId as string);
    await log(req, companyId, "deep_dive_board.handoff_removed", req.params.handoffId as string);
    reply(res, 200, board);
  });

  return router;
}
