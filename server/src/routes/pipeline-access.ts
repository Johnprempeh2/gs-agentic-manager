import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents } from "@greatstone/db";
import { setAgentPipelineLevelSchema, type PipelineAccessMatrix } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { requireEntitlement } from "../services/entitlements.js";
import {
  PIPELINE_ACCESS_UPDATED_ACTION,
  loadPipelineAccessMatrix,
  setAgentPipelineAccess,
  setAgentPipelineLevel,
} from "../services/agent-pipeline-access.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Agent pipeline access for the internal management screens (GRE-1073): the
 * agent × pipeline matrix, and one write route used by the pipeline view, the
 * agent view and the matrix. Grants live in principal_permission_grants, the
 * same rows the authorization service checks.
 */
export function pipelineAccessRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.use("/companies/:companyId/pipeline-access", requireEntitlement(db, "enablePipelines"));

  async function canManage(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    const decision = await access.decide({
      actor: req.actor,
      action: "users:manage_permissions",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function matrixFor(req: Request, companyId: string): Promise<PipelineAccessMatrix> {
    const [matrix, manage] = await Promise.all([loadPipelineAccessMatrix(db, companyId), canManage(req, companyId)]);
    return { ...matrix, canManage: manage };
  }

  router.get("/companies/:companyId/pipeline-access", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await matrixFor(req, companyId));
  });

  router.put(
    "/companies/:companyId/pipeline-access/agents/:agentId",
    validate(setAgentPipelineLevelSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        throw forbidden("Only board users with users:manage_permissions can change pipeline access");
      }
      const decision = await access.decide({
        actor: req.actor,
        action: "users:manage_permissions",
        resource: { type: "company", companyId },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));

      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");

      const grantedByUserId = req.actor.userId ?? null;
      const { level, pipelineId } = req.body as { level: "view" | "work_cases" | "administer"; pipelineId?: string };
      const details = pipelineId
        ? {
            pipelineId,
            ...(await setAgentPipelineLevel(db, { companyId, agentId, pipelineId, level, grantedByUserId })),
          }
        : {
            pipelineId: null,
            ...(await setAgentPipelineAccess(db, {
              companyId,
              agentId,
              access: { level, pipelineIds: null },
              grantedByUserId,
            })),
          };

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: PIPELINE_ACCESS_UPDATED_ACTION,
        entityType: "agent",
        entityId: agentId,
        details,
      });
      res.json(await matrixFor(req, companyId));
    },
  );

  return router;
}
