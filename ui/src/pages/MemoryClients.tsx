import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Building2, CheckCircle2, Clock, Lock, PowerOff, SearchX, Upload } from "lucide-react";
import type { MemoryGraphNode, MemoryScope } from "@greatstone/shared";
import { Link, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { ApiError } from "../api/client";
import { memoryGraphApi } from "../api/memoryGraph";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";
import { APPROVED_MEANING } from "../components/memory/memoryLabels";
import { isMemoryDisabled } from "./Memory";

/** The page for one client's memory. Other screens (the client pipeline) can link here. */
export function memoryClientPath(scopeId: string) {
  return `/memory/clients/${scopeId}`;
}

const retryUnlessRefused = (count: number, error: unknown) =>
  !(error instanceof ApiError && (error.status === 403 || isMemoryDisabled(error))) && count < 2;

const IMPORT_SOURCE: Record<string, string> = {
  claude_import: "From Claude",
  chatgpt_import: "From ChatGPT",
};

/** Confirmed first, then what still waits for a reviewer; replaced entries are left out. Newest first within each. */
export function groupClientMemory(nodes: MemoryGraphNode[], filter: string) {
  const needle = filter.trim().toLowerCase();
  const visible = nodes
    .filter((node) => node.status !== "superseded")
    .filter((node) => !needle || `${node.title ?? ""}\n${node.excerpt}`.toLowerCase().includes(needle))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    confirmed: visible.filter((node) => node.status === "approved"),
    waiting: visible.filter((node) => node.status === "unreviewed" || node.status === "disputed"),
  };
}

function MemoryStates({ error, header }: { error: unknown; header: ReactNode }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Lock} message="You do not have access to this client's memory." description="Ask the owner if you need to see it." />
      </div>
    );
  }
  if (isMemoryDisabled(error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={PowerOff} message="Memory is turned off for this organization." description="A board admin can turn it on in organization settings." />
      </div>
    );
  }
  return null;
}

/** Every client with its own memory, and a way to start one. */
export function MemoryClients() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory", href: "/memory" }, { label: "Clients" }]);
  }, [setBreadcrumbs]);

  const scopes = useQuery({
    queryKey: queryKeys.memoryGraph.scopes(selectedCompanyId ?? ""),
    queryFn: () => memoryGraphApi.scopes(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: retryUnlessRefused,
  });
  const clients = useMemo(
    () => (scopes.data ?? []).filter((scope) => scope.kind === "client").sort((a, b) => a.name.localeCompare(b.name)),
    [scopes.data],
  );

  const create = useMutation({
    mutationFn: () => memoryGraphApi.createScope(selectedCompanyId!, { kind: "client", name: name.trim() }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryGraph.scopes(selectedCompanyId ?? "") });
    },
  });

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  const header = <MemoryPageHeader tab="clients" />;
  const refused = <MemoryStates error={scopes.error} header={header} />;
  if (scopes.error && (scopes.error instanceof ApiError && scopes.error.status === 403 || isMemoryDisabled(scopes.error))) return refused;

  return (
    <div className="space-y-4">
      {header}
      <p className="text-sm text-muted-foreground">
        Each client has its own memory, kept apart from everything else. Only people working with that client see it.
      </p>
      {scopes.isLoading ? (
        <PageSkeleton variant="list" />
      ) : scopes.error ? (
        <ErrorState error={scopes.error} onRetry={() => void scopes.refetch()} />
      ) : clients.length === 0 ? (
        <EmptyState icon={Building2} message="No client has its own memory yet." description="Add a client below to start one." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card" aria-label="Clients">
          {clients.map((client) => (
            <li key={client.id}>
              <Link to={memoryClientPath(client.id)} className="flex items-center justify-between gap-2 px-4 py-3 text-sm hover:bg-accent/50">
                <span className="flex items-center gap-2 font-medium">
                  <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
                  {client.name}
                </span>
                <span className="text-xs text-muted-foreground">See what GSAM remembers</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !create.isPending) create.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Client name"
          aria-label="Client name"
          className="w-full sm:w-64"
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Adding..." : "Add client"}
        </Button>
      </form>
      {create.error ? (
        <p className="text-sm text-destructive">
          {create.error instanceof ApiError && create.error.status === 403
            ? "Only the owner or an admin can add a client."
            : create.error instanceof Error
              ? create.error.message
              : "Could not add the client. Try again."}
        </p>
      ) : null}
    </div>
  );
}

function EntryCard({ node }: { node: MemoryGraphNode }) {
  const from = node.source.kind ? IMPORT_SOURCE[node.source.kind] : undefined;
  return (
    <li className="space-y-1 px-4 py-3">
      {node.title ? <p className="text-sm font-medium break-words">{node.title}</p> : null}
      <p className="whitespace-pre-wrap text-sm break-words">{node.excerpt}</p>
      <p className="text-xs text-muted-foreground">
        {node.status === "disputed" ? "Disputed, " : ""}
        {from ? `${from}, ` : ""}
        updated {formatDate(node.updatedAt)}
      </p>
    </li>
  );
}

/** What GSAM remembers about one client, in plain words. */
export function MemoryClientDetail() {
  const { scopeId = "" } = useParams<{ scopeId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState("");

  const scopes = useQuery({
    queryKey: queryKeys.memoryGraph.scopes(selectedCompanyId ?? ""),
    queryFn: () => memoryGraphApi.scopes(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: retryUnlessRefused,
  });
  const client: MemoryScope | undefined = scopes.data?.find((scope) => scope.id === scopeId);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Memory", href: "/memory" },
      { label: "Clients", href: "/memory/clients" },
      { label: client?.name ?? "Client" },
    ]);
  }, [setBreadcrumbs, client?.name]);

  const graph = useQuery({
    queryKey: queryKeys.memoryGraph.graph(selectedCompanyId ?? "", { scopeId, limit: "500" }),
    queryFn: () => memoryGraphApi.graph(selectedCompanyId!, { scopeId, limit: 500 }),
    enabled: !!selectedCompanyId && !!client,
    retry: retryUnlessRefused,
  });
  const groups = useMemo(() => groupClientMemory(graph.data?.nodes ?? [], filter), [graph.data, filter]);

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  const header = <MemoryPageHeader tab="clients" />;
  const error = scopes.error ?? graph.error;
  if (error && (error instanceof ApiError && error.status === 403 || isMemoryDisabled(error))) {
    return <MemoryStates error={error} header={header} />;
  }
  if (scopes.isLoading) return <div className="space-y-4">{header}<PageSkeleton variant="list" /></div>;
  if (!client) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={SearchX} message="This client's memory was not found, or you cannot see it." description="Go back to Clients to pick another." />
      </div>
    );
  }

  const total = groups.confirmed.length + groups.waiting.length;
  return (
    <div className="space-y-4">
      {header}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">What GSAM remembers about {client.name}</h2>
          <p className="text-sm text-muted-foreground">
            Agents read the confirmed entries when they work for {client.name}. Entries still waiting are not used until someone confirms them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/memory/apps?scope=${client.id}`}>
              <Upload className="size-4" />
              Add from Claude or ChatGPT
            </Link>
          </Button>
          {groups.waiting.length > 0 ? (
            <Button asChild size="sm">
              <Link to={`/memory/review?scope=${client.id}`}>Review {groups.waiting.length} waiting</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {(graph.data?.nodes.length ?? 0) > 8 ? (
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Search ${client.name}'s memory`} aria-label="Search" />
      ) : null}

      {graph.isLoading ? (
        <PageSkeleton variant="list" />
      ) : graph.error ? (
        <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />
      ) : total === 0 ? (
        filter.trim() ? (
          <EmptyState icon={SearchX} message="Nothing matches that search." />
        ) : (
          <EmptyState
            icon={Building2}
            message={`GSAM does not remember anything about ${client.name} yet.`}
            description="Agents add what they learn as they work, or you can bring it in from Claude or ChatGPT."
          />
        )
      ) : (
        <>
          <section className="space-y-2" aria-label="Confirmed">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden="true" />
              Confirmed ({groups.confirmed.length})
            </h3>
            {groups.confirmed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing confirmed yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {groups.confirmed.map((node) => (
                  <EntryCard key={node.id} node={node} />
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{APPROVED_MEANING}</p>
          </section>
          {groups.waiting.length > 0 ? (
            <section className="space-y-2" aria-label="Waiting for review">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
                Waiting for review ({groups.waiting.length})
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {groups.waiting.map((node) => (
                  <EntryCard key={node.id} node={node} />
                ))}
              </ul>
            </section>
          ) : null}
          {graph.data?.truncated ? (
            <p className="text-xs text-muted-foreground">Showing the newest 500. Use search to find older entries.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
