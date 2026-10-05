import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { Link } from "@/lib/router";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { PropertyRow } from "./primitives";

/** Enough to say "some"; the Memory page shows the full list. */
const PREVIEW_LIMIT = 20;

/**
 * "Memories from this task" link for the task page (GRE-929). It asks the
 * same graph route as the Memory page, so the server decides what the caller
 * may read. No access, memory off, an error or no records: it renders nothing.
 */
export function IssueMemoryRow({
  companyId,
  issueId,
  issueKey,
}: {
  companyId: string;
  issueId: string;
  issueKey?: string | null;
}) {
  const graph = useQuery({
    queryKey: queryKeys.memoryGraph.graph(companyId, { q: issueId, limit: String(PREVIEW_LIMIT) }),
    queryFn: () => memoryGraphApi.graph(companyId, { q: issueId, limit: PREVIEW_LIMIT }),
    retry: false,
    staleTime: 60_000,
  });

  const count = graph.data?.nodes.length ?? 0;
  if (graph.error || count === 0) return null;
  const countLabel = graph.data?.truncated ? `${count}+` : String(count);

  return (
    <PropertyRow label="Memory">
      <Link
        to={`/memory?q=${encodeURIComponent(issueKey || issueId)}`}
        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground hover:underline"
      >
        <Brain className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">Memories from this task</span>
        <span className="shrink-0 text-muted-foreground">({countLabel})</span>
      </Link>
    </PropertyRow>
  );
}
