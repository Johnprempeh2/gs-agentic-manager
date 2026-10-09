import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelines } from "@greatstone/db";
import {
  PIPELINE_ADMIN_PERMISSION_KEY,
  PIPELINE_CASES_PERMISSION_KEY,
  pipelineAccessGrantScope,
  resolvePipelineAccess,
  type PipelineAccess,
} from "@greatstone/shared";
import { unprocessable } from "../errors.js";
import { accessService } from "./access.js";

/**
 * Sets an agent's pipeline access level (GRE-1072). One level and one scope
 * per agent: View clears both grants, Work cases holds pipelines:cases,
 * Administer holds pipelines:write (which covers Work cases on its own).
 * Picked pipelines must belong to the agent's company.
 */
export async function setAgentPipelineAccess(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    access: PipelineAccess;
    grantedByUserId: string | null;
  },
): Promise<{ before: PipelineAccess; after: PipelineAccess }> {
  const access = accessService(db);
  const pipelineIds = input.access.level === "view" ? null : input.access.pipelineIds;

  if (pipelineIds && pipelineIds.length > 0) {
    const unique = [...new Set(pipelineIds)];
    const found = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, input.companyId), inArray(pipelines.id, unique)));
    if (found.length !== unique.length) {
      throw unprocessable("One or more pipelines were not found in this company", { code: "pipeline_not_found" });
    }
  }

  const before = resolvePipelineAccess(
    await access.listPrincipalGrants(input.companyId, "agent", input.agentId),
  );
  const scope = pipelineAccessGrantScope(pipelineIds);
  await access.setPrincipalPermission(
    input.companyId,
    "agent",
    input.agentId,
    PIPELINE_CASES_PERMISSION_KEY,
    input.access.level === "work_cases",
    input.grantedByUserId,
    scope,
  );
  await access.setPrincipalPermission(
    input.companyId,
    "agent",
    input.agentId,
    PIPELINE_ADMIN_PERMISSION_KEY,
    input.access.level === "administer",
    input.grantedByUserId,
    scope,
  );
  const after = resolvePipelineAccess(
    await access.listPrincipalGrants(input.companyId, "agent", input.agentId),
  );
  return { before, after };
}
