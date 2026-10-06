import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryRecordStatus } from "@greatstone/shared";
import MemoryGraph3D from "@/components/memory/MemoryGraph3D";
import { MemoryGraphLegend } from "@/components/memory/MemoryGraphLegend";
import { buildMemoryGraph3D, type MemoryGraphGroupBy } from "@/components/memory/memoryGraph3dData";
import { kestrelNodes } from "@/fixtures/memoryKestrel";

/**
 * The 3D Memory graph with synthetic data shaped like a busy organisation:
 * 15 agents, mostly unreviewed entries, a few reviewed ones and a handful of
 * stated and check-found links. No real people or client data.
 */

const AGENT_NAMES = [
  "Mason", "Scribe", "Everest", "Harbor", "Juniper", "Atlas", "Wren", "Cobalt",
  "Linden", "Quill", "Rook", "Sable", "Tamsin", "Orrin", "Vale",
];
const SCOPES = [
  { id: "org", kind: "organization" as const, name: "Kestrel Works" },
  { id: "pj-alder-site", kind: "project" as const, name: "Alder website rebuild" },
  { id: "cl-alder", kind: "client" as const, name: "Alder Bakery" },
  { id: "pj-harbour", kind: "project" as const, name: "Harbour ops" },
];

function syntheticMemory(unreviewed: number, reviewed: Array<[MemoryRecordStatus, number]>) {
  const nodes: MemoryGraphNode[] = [];
  let index = 0;
  const push = (status: MemoryRecordStatus) => {
    const agent = AGENT_NAMES[(index * 7) % AGENT_NAMES.length];
    const scope = SCOPES[index % SCOPES.length];
    nodes.push({
      ...kestrelNodes[2],
      id: `rec-${index}`,
      title: `${agent} noted item ${index + 1}`,
      excerpt: "Synthetic memory entry for the graph preview.",
      status,
      scopeId: scope.id,
      scopeKind: scope.kind,
      scopeName: scope.name,
      contributor: { actorType: "agent", agentId: `ag-${agent.toLowerCase()}`, userId: null, name: `${agent} (synthetic)` },
    });
    index += 1;
  };
  for (let i = 0; i < unreviewed; i += 1) push("unreviewed");
  for (const [status, count] of reviewed) for (let i = 0; i < count; i += 1) push(status);

  const edge = (id: string, from: number, to: number, kind: MemoryGraphEdge["kind"], type: MemoryGraphEdge["type"]): MemoryGraphEdge => ({
    id,
    from: `rec-${from}`,
    to: `rec-${to}`,
    type,
    kind,
    origin: kind === "explicit" ? "relationship" : "conflict_check",
    author: kind === "explicit" ? nodes[from].contributor : { actorType: "system", agentId: null, userId: null, name: "Conflict check" },
    source: { kind: null, id: null, runId: null },
    basis: null,
    createdAt: "2026-10-05T10:00:00.000Z",
  });
  const edges: MemoryGraphEdge[] = [
    edge("rel:1", 171, 172, "explicit", "supports"),
    edge("rel:2", 173, 171, "explicit", "refines"),
    edge("rel:3", 4, 171, "explicit", "depends_on"),
    edge("rel:4", 18, 174, "explicit", "same_subject"),
    edge("rel:5", 175, 22, "explicit", "supports"),
    edge("sup:6", 176, 180, "explicit", "supersedes"),
    edge("cfl:7", 40, 172, "inferred", "possible_conflict"),
    edge("cfl:8", 178, 9, "inferred", "possible_conflict"),
  ];
  return { nodes, edges };
}

function GraphPreview({ unreviewed = 170, groupBy: initialGroupBy = "contributor" }: { unreviewed?: number; groupBy?: MemoryGraphGroupBy }) {
  const [groupBy] = useState(initialGroupBy);
  const [selected, setSelected] = useState<string | null>(null);
  const source = useMemo(() => syntheticMemory(unreviewed, [["approved", 8], ["disputed", 2], ["superseded", 1]]), [unreviewed]);
  const data = useMemo(() => buildMemoryGraph3D(source.nodes, source.edges, { groupBy }), [source, groupBy]);
  return (
    <div className="bg-background p-4">
      <figure className="space-y-2 rounded-lg border border-border bg-card p-2">
        <MemoryGraph3D
          data={data}
          selectedNodeId={selected}
          selectedEdgeId={null}
          onSelectNode={setSelected}
          onSelectEdge={() => undefined}
          className="h-(--sz-memory-graph-height) w-full overflow-hidden rounded-md"
        />
        <MemoryGraphLegend groupBy={groupBy} />
      </figure>
      <p className="mt-2 text-xs text-muted-foreground">
        {data.memoryCount} entries, {source.edges.length} connections{selected ? `, selected ${selected}` : ""}
      </p>
    </div>
  );
}

const meta = {
  title: "Memory/Graph 3D",
  component: GraphPreview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GraphPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ByContributor: Story = { args: { unreviewed: 170, groupBy: "contributor" } };
export const ByScope: Story = { args: { unreviewed: 170, groupBy: "scope" } };
export const FiveHundred: Story = { args: { unreviewed: 500, groupBy: "contributor" } };
