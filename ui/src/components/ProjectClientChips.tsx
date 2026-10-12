import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";

/**
 * "Client" chips on the project page: one per pipeline case linked to the
 * project, each opening that case (GRE-1047). Renders nothing when the
 * project has no linked case or pipelines are off.
 */
export function ProjectClientChips({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const { data } = useQuery({
    queryKey: queryKeys.pipelines.projectCases(projectId),
    queryFn: () => pipelinesApi.listProjectCases(projectId),
    enabled,
  });
  if (!enabled || !data || data.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {data.map((row) => (
        <Link
          key={row.case.id}
          to={`/pipelines/${row.case.pipelineId}/items/${row.case.id}`}
          title={`${row.pipeline.name} · ${row.stage.name}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-(length:--text-micro) font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span className="uppercase tracking-(--tracking-caps)">Client</span>
          <span className="truncate text-foreground">{row.case.title}</span>
        </Link>
      ))}
    </div>
  );
}
