import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PipelineAccessLevel } from "@greatstone/shared";
import { pipelineAccessApi } from "@/api/pipelineAccess";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The agent × pipeline access matrix and the one write that changes it
 * (GRE-1073). The pipeline view, the agent view and the overview all use this,
 * so a change in one shows in the others.
 */
function usePipelineAccessQuery(companyId: string | null | undefined) {
  return useQuery({
    queryKey: companyId ? queryKeys.pipelineAccess(companyId) : ["pipeline-access", "__disabled__"],
    queryFn: () => pipelineAccessApi.matrix(companyId!),
    enabled: Boolean(companyId),
  });
}

export function usePipelineAccess(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const query = usePipelineAccessQuery(companyId);

  const setLevel = useMutation({
    mutationFn: (input: { agentId: string; level: PipelineAccessLevel; pipelineId?: string }) =>
      pipelineAccessApi.setLevel(companyId!, input.agentId, { level: input.level, pipelineId: input.pipelineId }),
    onSuccess: async (matrix) => {
      queryClient.setQueryData(queryKeys.pipelineAccess(companyId!), matrix);
      // The agent page lists raw grants too. Its key may hold a URL slug
      // rather than the id, so refresh every agent detail.
      await queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
    },
    onError: (error) => {
      pushToast({
        title: "Pipeline access not changed",
        body: error instanceof Error ? error.message : "Try again, or ask an owner to check your permissions.",
        tone: "error",
      });
    },
  });

  return { query, matrix: query.data ?? null, setLevel };
}

/**
 * The viewer's own pipeline admin rights (GRE-1073), from the same query, so
 * pipeline screens show create, rename, archive, stage and move controls only
 * to people who may use them. Hidden while loading; if the rights cannot be
 * read, the controls show and the server decides.
 */
export function usePipelineAdminRights(companyId: string | null | undefined) {
  const query = usePipelineAccessQuery(companyId);
  const matrix = query.data ?? null;
  const unknown = query.isError;
  return {
    canCreatePipelines: matrix ? matrix.canCreatePipelines : unknown,
    canAdministerPipeline: (pipelineId: string) =>
      matrix ? matrix.administerPipelineIds.includes(pipelineId) : unknown,
  };
}
