import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryScope } from "@greatstone/shared";
import { ApiError } from "../../api/client";
import { memoryGraphApi } from "../../api/memoryGraph";
import { queryKeys } from "../../lib/queryKeys";
import { groupClientMemory, memoryClientPath } from "../../pages/MemoryClients";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

const SHOWN = 5;

const normalise = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** The client memory whose name matches the client, if there is one. */
export function findClientScope(scopes: MemoryScope[] | undefined, clientName: string): MemoryScope | null {
  const wanted = normalise(clientName);
  if (!wanted) return null;
  return scopes?.find((scope) => scope.kind === "client" && normalise(scope.name) === wanted) ?? null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section data-testid="client-memory-panel">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">What we remember</h2>
      <div className="space-y-2 border-y border-border py-3 text-sm">{children}</div>
    </section>
  );
}

/**
 * "What we remember" on a client's page: the newest confirmed memory about
 * this client, from the client memory of the same name. Hidden when memory is
 * off or the reader cannot read it.
 */
export function ClientMemoryPanel({ companyId, clientName }: { companyId: string; clientName: string }) {
  const queryClient = useQueryClient();
  const scopes = useQuery({
    queryKey: queryKeys.memoryGraph.scopes(companyId),
    queryFn: () => memoryGraphApi.scopes(companyId),
    retry: false,
  });
  const scope = findClientScope(scopes.data, clientName);
  const graph = useQuery({
    queryKey: queryKeys.memoryGraph.graph(companyId, { scopeId: scope?.id, limit: "500" }),
    queryFn: () => memoryGraphApi.graph(companyId, { scopeId: scope!.id, limit: 500 }),
    enabled: !!scope,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => memoryGraphApi.createScope(companyId, { kind: "client", name: clientName.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.memoryGraph.scopes(companyId) }),
  });

  if (scopes.error || !scopes.data || graph.error) return null;

  if (!scope) {
    const refused = start.error instanceof ApiError && start.error.status === 403;
    return (
      <Shell>
        <p className="text-muted-foreground">GSAM does not keep a memory for {clientName} yet.</p>
        {refused ? (
          <p className="text-muted-foreground">Only the owner or an admin can start one.</p>
        ) : (
          <Button size="sm" variant="outline" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Starting..." : `Start remembering ${clientName}`}
          </Button>
        )}
        {start.error && !refused ? <p className="text-destructive">Could not start it. Try again.</p> : null}
      </Shell>
    );
  }

  const groups = groupClientMemory(graph.data?.nodes ?? [], "");
  return (
    <Shell>
      {graph.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : groups.confirmed.length === 0 ? (
        <p className="text-muted-foreground">Nothing confirmed about {clientName} yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {groups.confirmed.slice(0, SHOWN).map((node) => (
            <li key={node.id} className="line-clamp-2 text-foreground">
              {node.title ?? node.excerpt}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4 text-muted-foreground">
        <Link to={memoryClientPath(scope.id)} className="hover:text-foreground hover:underline">
          {groups.confirmed.length > SHOWN ? `See all ${groups.confirmed.length}` : "Open client memory"}
        </Link>
        {groups.waiting.length > 0 ? (
          <Link to={`/memory/review?scope=${scope.id}`} className="hover:text-foreground hover:underline">
            {groups.waiting.length} waiting for review
          </Link>
        ) : null}
      </div>
    </Shell>
  );
}
