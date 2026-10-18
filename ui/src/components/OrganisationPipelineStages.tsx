import type { OrganisationPipelineStage } from "@greatstone/shared";
import { Badge } from "@/components/ui/badge";

export function organisationStageLabel(stage: OrganisationPipelineStage, withPipeline: boolean) {
  const suffix = stage.terminalKind === "cancelled" ? " (cancelled)" : "";
  return withPipeline ? `${stage.pipelineName}: ${stage.stageName}${suffix}` : `${stage.stageName}${suffix}`;
}

/**
 * Where an organisation is in the pipelines (GRE-1540): one chip per live
 * case. Pass `pipelineId` to show only that pipeline's stages, without its name.
 */
export function OrganisationPipelineStages({
  stages,
  pipelineId,
}: {
  stages: OrganisationPipelineStage[];
  pipelineId?: string;
}) {
  const shown = pipelineId ? stages.filter((stage) => stage.pipelineId === pipelineId) : stages;
  if (shown.length === 0) return <span className="text-muted-foreground">Not in a pipeline</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((stage) => (
        <Badge
          key={stage.caseId}
          variant={stage.terminalKind ? "outline" : "secondary"}
          title={`${stage.pipelineName}: ${stage.stageName} (${stage.caseKey})`}
        >
          {organisationStageLabel(stage, !pipelineId)}
        </Badge>
      ))}
    </span>
  );
}
