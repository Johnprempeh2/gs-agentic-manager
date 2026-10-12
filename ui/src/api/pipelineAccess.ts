import type { PipelineAccessLevel, PipelineAccessMatrix } from "@greatstone/shared";
import { api } from "./client";

/** Agent pipeline access (GRE-1073). One read and one write for every view. */
export const pipelineAccessApi = {
  matrix: (companyId: string) =>
    api.get<PipelineAccessMatrix>(`/companies/${encodeURIComponent(companyId)}/pipeline-access`),
  /** Omit pipelineId to set the level for all pipelines. */
  setLevel: (companyId: string, agentId: string, body: { level: PipelineAccessLevel; pipelineId?: string }) =>
    api.put<PipelineAccessMatrix>(
      `/companies/${encodeURIComponent(companyId)}/pipeline-access/agents/${encodeURIComponent(agentId)}`,
      body,
    ),
};
