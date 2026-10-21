import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import { accessService, heartbeatService, projectService, projectTreeService } from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoardOrAgent, getAccessibleResource, getActorInfo } from "./authz.js";
import { issueReadAccess } from "./issue-follows.js";

/**
 * The project tree (GET /projects/:id/tree): key tasks with their open work,
 * and the open work under none of them. `?finished=1` sends finished work
 * too, up to the size cap. POST /projects/:id/tidy asks the project lead to
 * place the unsorted tasks, at most one open tidy task per project.
 */
export function projectTreeRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; service?: ReturnType<typeof projectTreeService> } = {},
) {
  const router = Router();
  const projects = projectService(db);
  const access = accessService(db);
  const { canRead } = issueReadAccess(db);
  const service =
    options.service ??
    projectTreeService(db, { heartbeat: heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager }) });

  async function loadReadableProject(req: Request, res: Response) {
    const project = await getAccessibleResource(req, res, projects.getById(req.params.id as string), "Project not found");
    if (!project) return null;
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Project is outside this actor's authorization boundary" });
      return null;
    }
    return project;
  }

  router.get("/projects/:id/tree", async (req, res) => {
    const project = await loadReadableProject(req, res);
    if (!project) return;
    const finished = req.query.finished === "1" || req.query.finished === "true";
    const tree = await service.getTree(project.companyId, project.id, { finished, canRead: canRead(req) });
    if (!tree) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(tree);
  });

  router.post("/projects/:id/tidy", async (req, res) => {
    assertBoardOrAgent(req);
    const project = await loadReadableProject(req, res);
    if (!project) return;
    const actor = getActorInfo(req);
    const result = await service.requestTidy(project.companyId, project.id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    if (!result) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (result.status === "already_open") {
      res.status(409).json({ error: "A tidy for this project is already open", taskId: result.taskId });
      return;
    }
    if (result.status === "nothing_to_tidy") {
      res.status(409).json({ error: "Every open task in this project is already placed" });
      return;
    }
    if (result.status === "no_lead") {
      res.status(409).json({ error: "This project has no lead and the company has no lead agent" });
      return;
    }
    res.status(201).json(result);
  });

  return router;
}
