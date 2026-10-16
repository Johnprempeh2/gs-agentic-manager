import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Briefcase, FileText, MessageSquareText, Repeat } from "lucide-react";
import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";
import { searchApi } from "../../api/search";
import { pipelinesApi } from "../../api/pipelines";
import { routinesApi } from "../../api/routines";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { rankByText } from "../../lib/global-search";

const PER_GROUP = 5;

/**
 * The palette's extra sources beyond tasks, projects and agents: clients
 * (pipeline items), documents, routines and memory. Each group loads only
 * while the person is typing and hides itself when it has nothing, so a
 * source that fails or is switched off never blocks the rest.
 */
export function GlobalSearchSources({
  companyId,
  query,
  onGo,
  excludeIssueIds,
}: {
  companyId: string;
  query: string;
  onGo: (path: string) => void;
  /** Tasks already listed by title, so they are not repeated here. */
  excludeIssueIds?: ReadonlySet<string>;
}) {
  const q = query.trim();
  const active = q.length >= 2;

  const { data: pipelines = [] } = useQuery({
    queryKey: queryKeys.pipelines.list(companyId),
    queryFn: () => pipelinesApi.list(companyId),
    enabled: active,
    retry: false,
  });
  const pipelineIds = useMemo(
    () => pipelines.filter((pipeline) => !pipeline.archivedAt).map((pipeline) => pipeline.id).slice(0, 6),
    [pipelines],
  );
  const { data: clientRows = [] } = useQuery({
    queryKey: ["global-search", companyId, "pipeline-items", pipelineIds],
    queryFn: async () => {
      const lists = await Promise.all(
        pipelineIds.map((id) => pipelinesApi.listCases(id).catch(() => [])),
      );
      return lists.flat();
    },
    enabled: active && pipelineIds.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const pipelineName = useMemo(
    () => new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name])),
    [pipelines],
  );
  const clients = useMemo(
    () => (active
      ? rankByText(
        clientRows,
        q,
        (row) => [row.case.title, row.case.caseKey, row.case.summary, row.stage?.name],
        PER_GROUP,
      )
      : []),
    [active, clientRows, q],
  );

  const { data: documents } = useQuery({
    queryKey: ["global-search", companyId, "documents", q],
    queryFn: () => searchApi.search(companyId, { q, scope: "artifacts", limit: PER_GROUP }),
    enabled: active,
    retry: false,
  });
  const documentResults = documents?.results.filter((result) => result.type === "artifact") ?? [];

  // Words inside comments and document text, not only titles. Tasks whose
  // title already matches are left to the Tasks group above.
  const { data: insideComments } = useQuery({
    queryKey: ["global-search", companyId, "comments", q],
    queryFn: () => searchApi.search(companyId, { q, scope: "comments", limit: PER_GROUP }),
    enabled: active,
    retry: false,
  });
  const { data: insideDocuments } = useQuery({
    queryKey: ["global-search", companyId, "document-text", q],
    queryFn: () => searchApi.search(companyId, { q, scope: "documents", limit: PER_GROUP }),
    enabled: active,
    retry: false,
  });
  const insideMatches = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ id: string; title: string; href: string; identifier: string | null; label: string; text: string }> = [];
    for (const result of [...(insideComments?.results ?? []), ...(insideDocuments?.results ?? [])]) {
      if (result.type !== "issue" || seen.has(result.id)) continue;
      if (excludeIssueIds?.has(result.issue?.id ?? result.id)) continue;
      const snippet = result.snippets.find((entry) => entry.field === "comment" || entry.field === "document");
      if (!snippet) continue;
      seen.add(result.id);
      rows.push({
        id: result.id,
        title: result.title,
        href: result.href,
        identifier: result.issue?.identifier ?? null,
        label: snippet.field === "comment" ? "Comment" : snippet.label,
        text: snippet.text,
      });
    }
    return rows.slice(0, PER_GROUP);
  }, [insideComments, insideDocuments, excludeIssueIds]);

  const { data: routines = [] } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    enabled: active,
    retry: false,
  });
  const matchedRoutines = useMemo(
    () => (active ? rankByText(routines.filter((routine) => routine.status !== "archived"), q, (routine) => [routine.title, routine.description], PER_GROUP) : []),
    [active, routines, q],
  );

  const { data: memory } = useQuery({
    queryKey: ["global-search", companyId, "memory", q],
    queryFn: () => memoryGraphApi.graph(companyId, { q, limit: PER_GROUP }),
    enabled: active,
    retry: false,
  });
  const memoryNodes = memory?.nodes.slice(0, PER_GROUP) ?? [];

  if (!active) return null;

  return (
    <>
      {clients.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Clients">
            {clients.map((row) => (
              <CommandItem
                key={row.case.id}
                value={`${q} client ${row.case.id} ${row.case.title}`}
                onSelect={() => onGo(`/pipelines/${row.case.pipelineId}/items/${row.case.id}`)}
                data-testid="global-search-client"
              >
                <Briefcase className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{row.case.title}</span>
                <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                  {[row.stage?.name, pipelineName.get(row.case.pipelineId)].filter(Boolean).join(" · ")}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}

      {documentResults.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Documents and files">
            {documentResults.map((result) => (
              <CommandItem
                key={result.id}
                value={`${q} document ${result.id} ${result.title}`}
                onSelect={() => onGo(result.href)}
                data-testid="global-search-document"
              >
                <FileText className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{result.title}</span>
                {result.artifact ? (
                  <span className="ml-auto min-w-0 shrink truncate pl-2 text-xs text-muted-foreground">
                    in {result.artifact.issueTitle}
                  </span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}

      {insideMatches.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Mentioned in comments and documents">
            {insideMatches.map((row) => (
              <CommandItem
                key={row.id}
                value={`${q} inside ${row.id} ${row.title}`}
                onSelect={() => onGo(row.href)}
                data-testid="global-search-inside"
              >
                <MessageSquareText className="mr-2 h-4 w-4 shrink-0 self-start" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {row.identifier ? (
                      <span className="mr-2 font-mono text-xs text-muted-foreground">{row.identifier}</span>
                    ) : null}
                    {row.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.label}: {row.text}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}

      {matchedRoutines.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Routines">
            {matchedRoutines.map((routine) => (
              <CommandItem
                key={routine.id}
                value={`${q} routine ${routine.id} ${routine.title}`}
                onSelect={() => onGo(`/routines/${routine.id}`)}
                data-testid="global-search-routine"
              >
                <Repeat className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{routine.title}</span>
                <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                  {routine.status === "active" ? "On" : "Paused"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}

      {memoryNodes.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="Memory">
            {memoryNodes.map((node) => (
              <CommandItem
                key={node.id}
                value={`${q} memory ${node.id} ${node.title ?? node.excerpt}`}
                onSelect={() => onGo(`/memory?view=list&q=${encodeURIComponent(q)}&node=${encodeURIComponent(node.id)}`)}
                data-testid="global-search-memory"
              >
                <Brain className="mr-2 h-4 w-4 shrink-0" />
                <span className="min-w-0 truncate">{node.title || node.excerpt}</span>
                <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{node.scopeName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : null}
    </>
  );
}
