import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { agents, type Db } from "@greatstone/db";
import {
  createWorkflowTemplateSchema,
  startWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  type WorkflowTemplateDefinition,
} from "@greatstone/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, heartbeatService, logActivity, workflowTemplateService } from "../services/index.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { WorkflowTemplateActor } from "../services/workflow-templates.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

export function workflowTemplateRoutes(
  db: Db,
  options: { heartbeat?: IssueAssignmentWakeupDeps; pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = workflowTemplateService(db);
  const access = accessService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  function templateActor(req: Request): WorkflowTemplateActor {
    const actor = getActorInfo(req);
    return {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
      responsibleUserId: req.actor.type === "agent" ? (req.actor.onBehalfOfUserId ?? null) : undefined,
    };
  }

  /** Templates set who gets assigned, so editing one needs a board member who may assign tasks. */
  async function assertCanEditTemplates(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw forbidden("Only board members can edit workflow templates");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (!(await access.canUser(companyId, req.actor.userId, "tasks:assign"))) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  /** Every agent named in the template must belong to this company. */
  async function assertTemplateAgentsInCompany(companyId: string, definition: WorkflowTemplateDefinition) {
    const agentIds = new Set<string>();
    if (definition.coordinator.assigneeAgentId) agentIds.add(definition.coordinator.assigneeAgentId);
    for (const step of definition.steps) if (step.assigneeAgentId) agentIds.add(step.assigneeAgentId);
    for (const review of definition.reviews) {
      for (const participant of review.participants) if (participant.agentId) agentIds.add(participant.agentId);
    }
    if (agentIds.size === 0) return;
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])));
    if (found.length !== agentIds.size) throw unprocessable("The template names an agent that is not in this company");
  }

  router.get("/companies/:companyId/workflow-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, { includeArchived: req.query.includeArchived === "true" }));
  });

  router.post("/companies/:companyId/workflow-templates", validate(createWorkflowTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanEditTemplates(req, companyId);
    await assertTemplateAgentsInCompany(companyId, req.body.definition);
    const template = await svc.create(companyId, req.body, templateActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.created",
      entityType: "workflow_template",
      entityId: template.id,
      details: { key: template.key, name: template.name },
    });
    res.status(201).json(template);
  });

  router.get("/workflow-templates/:id", async (req, res) => {
    const template = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Workflow template not found");
    if (!template) return;
    res.json(template);
  });

  router.patch("/workflow-templates/:id", validate(updateWorkflowTemplateSchema), async (req, res) => {
    const existing = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Workflow template not found");
    if (!existing) return;
    await assertCanEditTemplates(req, existing.companyId);
    if (req.body.definition) await assertTemplateAgentsInCompany(existing.companyId, req.body.definition);
    const template = await svc.update(existing.id, req.body, templateActor(req));
    if (!template) throw notFound("Workflow template not found");
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: template.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.updated",
      entityType: "workflow_template",
      entityId: template.id,
      details: { key: template.key, changed: Object.keys(req.body) },
    });
    res.json(template);
  });

  router.post("/workflow-templates/:id/start", validate(startWorkflowTemplateSchema), async (req, res) => {
    const template = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Workflow template not found");
    if (!template) return;
    const companyId = template.companyId;
    assertCompanyAccess(req, companyId);

    // Same rule as creating an assigned issue by hand, once per assignee in the pack.
    const definition = template.definition;
    const assigneeAgentIds = new Set<string | null>([
      definition.coordinator.assigneeAgentId ?? null,
      ...definition.steps.map((step) => step.assigneeAgentId ?? null),
    ]);
    for (const assigneeAgentId of assigneeAgentIds) {
      if (!assigneeAgentId) continue;
      const decision = await access.decide({
        actor: req.actor,
        action: "tasks:assign",
        resource: {
          type: "issue",
          companyId,
          issueId: null,
          projectId: req.body.projectId ?? null,
          parentIssueId: req.body.parentId ?? null,
          assigneeAgentId,
          assigneeUserId: null,
        },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    if (req.body.reviewerUserId) {
      const membership = await access.getMembership(companyId, "user", req.body.reviewerUserId);
      if (membership?.status !== "active") throw unprocessable("The reviewer is not an active member of this company");
    }

    const result = await svc.start(template, req.body, templateActor(req));

    const actor = getActorInfo(req);
    const created = [result.coordinator, ...result.steps];
    for (const issue of created) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: { title: issue.title, identifier: issue.identifier, workflowTemplateId: template.id },
      });
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.started",
      entityType: "workflow_template",
      entityId: template.id,
      details: { key: template.key, coordinatorIssueId: result.coordinator.id, stepCount: result.steps.length },
    });
    // Blocked steps wake when their blockers are done, through the normal unblock path.
    for (const issue of created) {
      if (issue.status !== "todo") continue;
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "workflow_template.start",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }
    res.status(201).json(result);
  });

  return router;
}
