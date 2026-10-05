import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryReviewEventAction, MemorySourceRef } from "@greatstone/shared";
import { X } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { memoryGraphApi } from "../../api/memoryGraph";
import { MemoryEdgeKindTag, MemoryStatusBadge } from "./MemoryStatusBadge";
import { actorLabel, edgeLabel, scopeKindLabel, sourceRef } from "./memoryLabels";
import { nodeHeading } from "./MemoryRecordList";

const ACTION_LABEL: Record<MemoryReviewEventAction, string> = {
  contribute: "Contributed",
  approve: "Approved",
  dispute: "Disputed",
  supersede: "Replaced an older entry",
  superseded_by: "Replaced by a newer entry",
  conflict_flagged: "Flagged a possible conflict",
  conflict_resolved: "Settled a conflict",
  delete: "Deleted",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm break-words">{children}</span>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

export function MemorySourceLink({ source }: { source: MemorySourceRef | null | undefined }) {
  const ref = sourceRef(source);
  if (!ref) return <span className="text-muted-foreground">Not recorded</span>;
  return ref.href ? (
    <Link to={ref.href} className="underline underline-offset-2 hover:text-foreground">
      {ref.label}
    </Link>
  ) : (
    <span>{ref.label}</span>
  );
}

function EntryButton({ node, onSelect }: { node: Pick<MemoryGraphNode, "id" | "title" | "excerpt">; onSelect: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onSelect(node.id)} className="text-left underline underline-offset-2 hover:text-foreground">
      {nodeHeading(node)}
    </button>
  );
}

function contributorActivityHref(node: MemoryGraphNode) {
  if (node.contributor.agentId) return `/memory/activity?agent=${encodeURIComponent(node.contributor.agentId)}`;
  if (node.contributor.userId) return `/memory/activity?user=${encodeURIComponent(node.contributor.userId)}`;
  return null;
}

function PanelFrame({ heading, onClose, children }: { heading: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground" aria-label={heading}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </aside>
  );
}

interface NodeDetailProps {
  companyId: string;
  nodeId: string;
  /** The node as the graph has it, shown while the detail loads. Absent when the entry is outside the current filters. */
  initialNode?: MemoryGraphNode;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClose: () => void;
}

export function MemoryNodeDetail({ companyId, nodeId, initialNode, onSelectNode, onSelectEdge, onClose }: NodeDetailProps) {
  const detail = useQuery({
    queryKey: queryKeys.memoryGraph.node(companyId, nodeId),
    queryFn: () => memoryGraphApi.node(companyId, nodeId),
  });
  const data = detail.data;
  const node = data?.node ?? initialNode;
  if (!node) {
    return (
      <PanelFrame heading="Memory details" onClose={onClose}>
        <Muted>{detail.isLoading ? "Loading entry…" : "This entry is not available to you, or it no longer exists."}</Muted>
      </PanelFrame>
    );
  }
  const neighbours = new Map((data?.neighbours ?? []).map((other) => [other.id, other]));
  const provenance = data?.provenance;
  const facts = provenance?.extraction.facts ?? [];

  return (
    <PanelFrame heading="Memory details" onClose={onClose}>
      <div className="space-y-2">
        <MemoryStatusBadge status={node.status} />
        <p className="text-sm font-medium break-words">{nodeHeading(node)}</p>
        {node.title && node.excerpt ? <p className="text-sm text-muted-foreground break-words">{node.excerpt}</p> : null}
      </div>

      <div>
        <PropertyRow label="Scope">{node.scopeName} · {scopeKindLabel[node.scopeKind]}</PropertyRow>
        <PropertyRow label="Source"><MemorySourceLink source={node.source} /></PropertyRow>
      </div>

      <Section title="Contributor">
        <p className="text-sm">
          {actorLabel(node.contributor)} <span className="text-muted-foreground">· {formatDateTime(node.createdAt)}</span>
        </p>
        {contributorActivityHref(node) ? (
          <Link to={contributorActivityHref(node)!} className="text-xs underline underline-offset-2 hover:text-foreground">
            See this contributor's activity
          </Link>
        ) : null}
      </Section>

      {detail.isLoading ? (
        <Muted>Loading history…</Muted>
      ) : detail.error || !data || !provenance ? (
        <Muted>History could not be loaded. The entry may have changed since the graph loaded.</Muted>
      ) : (
        <>
          <Section title="Reviewers and editors">
            {provenance.reviewers.length === 0 ? (
              <Muted>No review yet.</Muted>
            ) : (
              <ul className="space-y-1">
                {provenance.reviewers.map((step, index) => (
                  <li key={`${step.action}-${index}`} className="text-sm">
                    {ACTION_LABEL[step.action]} by {actorLabel(step.actor)}
                    <span className="text-muted-foreground"> · {formatDateTime(step.at)}</span>
                    {step.reason ? <span className="block text-xs text-muted-foreground break-words">{step.reason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Engine extraction">
            {facts.length === 0 ? (
              <Muted>The engine has not extracted facts from this entry.</Muted>
            ) : (
              <p className="text-sm">
                {facts.length} {facts.length === 1 ? "fact" : "facts"} extracted by the engine
                <span className="block text-xs text-muted-foreground">Each traces back to this entry and its contributor.</span>
              </p>
            )}
            {provenance.checks.length > 0 ? (
              <Muted>
                {provenance.checks.length} automatic {provenance.checks.length === 1 ? "check" : "checks"} ran on this entry.
              </Muted>
            ) : null}
          </Section>

          {data.chain.length > 1 ? (
            <Section title="Supersession history">
              <ol className="space-y-1 text-sm">
                {data.chain.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2">
                    {entry.id === node.id ? (
                      <span className="font-medium">{nodeHeading(entry)} (this entry)</span>
                    ) : (
                      <EntryButton node={entry} onSelect={onSelectNode} />
                    )}
                    <MemoryStatusBadge status={entry.status} />
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}

          <Section title="Connections">
            {data.edges.length === 0 ? (
              <Muted>No connections you can see.</Muted>
            ) : (
              <ul className="space-y-1">
                {data.edges.map((edge) => {
                  const otherId = edge.from === node.id ? edge.to : edge.from;
                  const other = neighbours.get(otherId);
                  const otherHeading = other ? nodeHeading(other) : "another entry";
                  return (
                    <li key={edge.id}>
                      <button
                        type="button"
                        onClick={() => onSelectEdge(edge.id)}
                        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="text-sm break-words">
                          {edge.from === node.id
                            ? `${edgeLabel(edge)}: ${otherHeading}`
                            : `${otherHeading}: ${edgeLabel(edge).toLowerCase()} this entry`}
                        </span>
                        <MemoryEdgeKindTag kind={edge.kind} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </>
      )}
    </PanelFrame>
  );
}

interface EdgeDetailProps {
  companyId: string;
  edgeId: string;
  initialEdge?: MemoryGraphEdge;
  onSelectNode: (id: string) => void;
  onClose: () => void;
}

export function MemoryEdgeDetail({ companyId, edgeId, initialEdge, onSelectNode, onClose }: EdgeDetailProps) {
  const detail = useQuery({
    queryKey: queryKeys.memoryGraph.edge(companyId, edgeId),
    queryFn: () => memoryGraphApi.edge(companyId, edgeId),
  });
  const data = detail.data;
  const edge = data?.edge ?? initialEdge;

  return (
    <PanelFrame heading="Connection details" onClose={onClose}>
      {edge ? <MemoryEdgeKindTag kind={edge.kind} /> : null}
      {detail.isLoading ? (
        <Muted>Loading connection…</Muted>
      ) : detail.error || !data || !edge ? (
        <Muted>This connection is not available to you, or it no longer exists.</Muted>
      ) : (
        <>
          <div className="space-y-1 text-sm">
            <EntryButton node={data.from} onSelect={onSelectNode} />
            <p className="font-medium">{edgeLabel(edge)}</p>
            <EntryButton node={data.to} onSelect={onSelectNode} />
          </div>

          <Section title="What this means">
            <p className="text-sm">{data.meaning}</p>
            {data.sharedTerms.length > 0 ? <p className="text-sm">Matched on: {data.sharedTerms.join(", ")}</p> : null}
            {data.conflictState ? <Muted>Conflict is {data.conflictState}.</Muted> : null}
            <Muted>{data.note}</Muted>
          </Section>

          <Section title={edge.kind === "explicit" ? "Stated by" : "Found by"}>
            <p className="text-sm">
              {actorLabel(edge.author)} <span className="text-muted-foreground">· {formatDateTime(edge.createdAt)}</span>
            </p>
            {data.statedNote ? <p className="text-sm text-muted-foreground break-words">{data.statedNote}</p> : null}
          </Section>

          <div>
            <PropertyRow label="Source"><MemorySourceLink source={edge.source} /></PropertyRow>
          </div>
        </>
      )}
    </PanelFrame>
  );
}
