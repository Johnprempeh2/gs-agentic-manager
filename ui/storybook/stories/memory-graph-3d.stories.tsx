import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { MEMORY_GRAPH_STATUSES, type MemoryGraphEdge, type MemoryGraphNode, type MemoryRecordStatus } from "@greatstone/shared";
import { MemoryContributorPanel } from "@/components/memory/MemoryContributorPanel";
import { MemoryFilterBar } from "@/components/memory/MemoryFilterBar";
import { MemoryGraphFigure, MemoryViewToolbar, useMemoryExplorer, type MemoryView } from "@/components/memory/MemoryExplorer";
import { MemoryRecordList } from "@/components/memory/MemoryRecordList";
import type { MemoryAgentInfo } from "@/components/memory/memoryContributors";
import type { MemoryGraphFocusMode, MemoryGraphGroupBy } from "@/components/memory/memoryGraph3dData";
import { kestrelNodes, kestrelScopes } from "@/fixtures/memoryKestrel";

/**
 * The Memory page's graph with synthetic data shaped like a busy organisation:
 * 21 agents (one CEO), 170 entries, about 300 check found leads and a few stated
 * links. No real people or client data.
 */

const AGENT_NAMES = [
  "Everest", "Mason", "Scribe", "Harbor", "Juniper", "Atlas", "Wren", "Cobalt", "Linden", "Quill", "Rook",
  "Sable", "Tamsin", "Orrin", "Vale", "Fennel", "Briar", "Calder", "Indigo", "Marlow", "Pike",
];
/** Entries per agent, the CEO first; adds up to 170. */
const ENTRY_COUNTS = [22, 16, 14, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 5, 5, 4, 4, 4, 2];
const SCOPES = [
  { id: "org", kind: "organization" as const, name: "Kestrel Works" },
  { id: "pj-alder-site", kind: "project" as const, name: "Alder website rebuild" },
  { id: "cl-alder", kind: "client" as const, name: "Alder Bakery" },
];

const PREVIEW_AGENTS: MemoryAgentInfo[] = AGENT_NAMES.map((name, index) => ({
  id: `ag-${name.toLowerCase()}`,
  name,
  role: index === 0 ? "ceo" : "general",
  appearance: null,
}));

/** Small seeded generator so every render draws the same picture. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function syntheticMemory() {
  const random = seeded(42);
  const nodes: MemoryGraphNode[] = [];
  AGENT_NAMES.forEach((name, agentIndex) => {
    for (let i = 0; i < ENTRY_COUNTS[agentIndex]; i += 1) {
      const index = nodes.length;
      const scope = SCOPES[index % SCOPES.length];
      const roll = random();
      const status: MemoryRecordStatus = roll < 0.12 ? "approved" : roll < 0.14 ? "disputed" : roll < 0.155 ? "superseded" : "unreviewed";
      nodes.push({
        ...kestrelNodes[2],
        id: `rec-${index}`,
        title: `${name} noted item ${i + 1}`,
        excerpt: "Synthetic memory entry for the graph preview.",
        status,
        openConflictCount: 0,
        scopeId: scope.id,
        scopeKind: scope.kind,
        scopeName: scope.name,
        contributor: { actorType: "agent", agentId: `ag-${name.toLowerCase()}`, userId: null, name },
      });
    }
  });

  const edge = (id: string, from: number, to: number, kind: MemoryGraphEdge["kind"], type: MemoryGraphEdge["type"]): MemoryGraphEdge => ({
    id,
    from: `rec-${from}`,
    to: `rec-${to}`,
    type,
    kind,
    origin: kind === "explicit" ? (type === "supersedes" ? "supersession" : "relationship") : "link_check",
    author: kind === "explicit" ? nodes[from].contributor : { actorType: "system", agentId: null, userId: null, name: "Link check" },
    source: kind === "explicit" ? { kind: null, id: null, runId: null } : { kind: "memory_link_lead", id: `lead-${id}`, runId: null },
    basis: kind === "explicit" ? null : { entities: ["alder bakery"], topics: [], values: [], sameSource: false },
    createdAt: "2026-10-05T10:00:00.000Z",
  });
  const edges: MemoryGraphEdge[] = [
    edge("rel:1", 0, 25, "explicit", "supports"),
    edge("rel:2", 3, 0, "explicit", "refines"),
    edge("rel:3", 40, 1, "explicit", "depends_on"),
    edge("rel:4", 60, 41, "explicit", "same_subject"),
    edge("rel:5", 90, 5, "explicit", "supports"),
    edge("sup:6", 7, 8, "explicit", "supersedes"),
    edge("sup:7", 120, 121, "explicit", "supersedes"),
    edge("rel:8", 150, 2, "explicit", "contradicts"),
  ];
  const seen = new Set<string>();
  while (edges.length < 8 + 300) {
    const from = Math.floor(random() * nodes.length);
    const to = Math.floor(random() * nodes.length);
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    edges.push(edge(`lnk:${edges.length}`, from, to, "inferred", "same_subject"));
  }
  return { nodes, edges };
}

interface PreviewProps {
  focus?: string[];
  suggested?: boolean;
  focusMode?: MemoryGraphFocusMode;
  groupBy?: MemoryGraphGroupBy;
}

function MemoryExplorerPreview({ focus = [], suggested = false, focusMode: initialMode = "hide", groupBy: initialGroupBy = "contributor" }: PreviewProps) {
  const source = useMemo(() => syntheticMemory(), []);
  const [focusKeys, setFocusKeys] = useState(focus);
  const [showSuggested, setShowSuggested] = useState(suggested);
  const [focusMode, setFocusMode] = useState(initialMode);
  const [groupBy, setGroupBy] = useState(initialGroupBy);
  const [view, setView] = useState<MemoryView>("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const explorer = useMemoryExplorer({ nodes: source.nodes, edges: source.edges, agents: PREVIEW_AGENTS, groupBy, showSuggested, focusKeys });
  const toggle = (key: string, additive: boolean) =>
    setFocusKeys((current) =>
      additive
        ? current.includes(key) ? current.filter((existing) => existing !== key) : [...current, key]
        : current.length === 1 && current[0] === key ? [] : [key],
    );
  const list = (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Memory list">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {explorer.listNodes.length} of {source.nodes.length} entries
      </div>
      <MemoryRecordList nodes={explorer.listNodes} edges={explorer.listEdges} selectedNodeId={selected} onSelectNode={setSelected} />
    </section>
  );

  return (
    <div className="space-y-4 bg-background p-4">
      <MemoryFilterBar
        filters={{}}
        statuses={MEMORY_GRAPH_STATUSES}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onChange={() => undefined}
        scopes={kestrelScopes}
      />
      <div className="grid gap-4 lg:grid-cols-(--gtc-memory-layout)">
        <div className="min-w-0 space-y-3">
          <MemoryViewToolbar
            view={view}
            webgl
            groupBy={groupBy}
            showSuggested={showSuggested}
            suggestedCount={explorer.graph3d.suggestedCount}
            onViewChange={setView}
            onGroupByChange={setGroupBy}
            onShowSuggestedChange={setShowSuggested}
          />
          <div className="grid gap-4 md:grid-cols-(--gtc-memory-explorer)">
            <MemoryContributorPanel
              contributors={explorer.contributors}
              total={source.nodes.length}
              selected={focusKeys}
              onToggle={toggle}
              onReset={() => setFocusKeys([])}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
              showFocusMode={view === "graph"}
              className="max-h-(--sz-memory-contributors-phone) md:max-h-(--sz-memory-graph-height) md:self-start"
            />
            {view === "graph" ? (
              <MemoryGraphFigure
                explorer={explorer}
                groupBy={groupBy}
                focusMode={focusMode}
                total={source.nodes.length}
                truncated={false}
                selectedNodeId={selected}
                selectedEdgeId={null}
                onSelectNode={setSelected}
                onSelectEdge={() => undefined}
              />
            ) : (
              list
            )}
          </div>
        </div>
        <div className="min-w-0 self-start lg:max-h-(--sz-memory-list-max) lg:overflow-y-auto">{view === "graph" ? list : null}</div>
      </div>
    </div>
  );
}

const meta = {
  title: "Memory/Graph 3D",
  component: MemoryExplorerPreview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MemoryExplorerPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllAgents: Story = { args: {} };
export const OneAgentFocused: Story = { args: { focus: ["ag-harbor"] } };
export const OneAgentDimmed: Story = { args: { focus: ["ag-harbor"], focusMode: "dim" } };
export const SuggestedLinksOn: Story = { args: { suggested: true } };
export const ByScope: Story = { args: { groupBy: "scope" } };
