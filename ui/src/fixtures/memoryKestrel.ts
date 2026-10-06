import {
  MEMORY_GRAPH_NOTE,
  type MemoryActorRef,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryScope,
} from "@greatstone/shared";

/**
 * Synthetic Kestrel Works memory (GRE-651 world, tests/memory-acceptance).
 * No client data, no real people. For component tests and UI previews only.
 */

export const kestrelAgents: Record<string, MemoryActorRef> = {
  mason: { actorType: "agent", agentId: "ag-mason-syn", userId: null, name: "Mason (synthetic)" },
  scribe: { actorType: "agent", agentId: "ag-scribe-syn", userId: null, name: "Scribe (synthetic)" },
  everest: { actorType: "agent", agentId: "ag-everest-syn", userId: null, name: "Everest (synthetic)" },
  john: { actorType: "user", agentId: null, userId: "hu-john-syn", name: null },
  check: { actorType: "system", agentId: null, userId: null, name: "Conflict check" },
};

export const kestrelScopes: MemoryScope[] = [
  { id: "org", companyId: "co-kestrel", kind: "organization", name: "Kestrel Works", projectId: null, agentId: null, createdAt: "2026-10-01T09:00:00.000Z" },
  { id: "pj-alder-site", companyId: "co-kestrel", kind: "project", name: "Alder website rebuild", projectId: null, agentId: null, createdAt: "2026-10-01T09:00:00.000Z" },
  { id: "cl-alder", companyId: "co-kestrel", kind: "client", name: "Alder Bakery", projectId: null, agentId: null, createdAt: "2026-10-01T09:00:00.000Z" },
];

function node(id: string, overrides: Partial<MemoryGraphNode>): MemoryGraphNode {
  return {
    id,
    scopeId: "org",
    scopeKind: "organization",
    scopeName: "Kestrel Works",
    title: null,
    excerpt: "",
    status: "unreviewed",
    entryType: "observation",
    decisionClass: "operational",
    contributor: kestrelAgents.mason,
    source: { kind: "issue", id: `issue-${id}`, runId: `run-${id}` },
    openConflictCount: 0,
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

export const kestrelNodes: MemoryGraphNode[] = [
  node("rec-hours", {
    title: "Alder Bakery opens at 6am on weekdays",
    excerpt: "Alder Bakery opens at 6am Monday to Friday; deliveries arrive before opening.",
    status: "approved",
    scopeId: "cl-alder",
    scopeKind: "client",
    scopeName: "Alder Bakery",
    contributor: kestrelAgents.scribe,
  }),
  node("rec-hours-old", {
    title: "Alder Bakery opens at 7am",
    excerpt: "Opening time noted from the old website.",
    status: "superseded",
    scopeId: "cl-alder",
    scopeKind: "client",
    scopeName: "Alder Bakery",
    contributor: kestrelAgents.mason,
    createdAt: "2026-10-01T10:00:00.000Z",
  }),
  node("rec-delivery", {
    title: "Deliveries need a 5:30am slot",
    excerpt: "Flour supplier delivers 5:30am; the site must show the delivery entrance.",
    status: "unreviewed",
    scopeId: "cl-alder",
    scopeKind: "client",
    scopeName: "Alder Bakery",
    openConflictCount: 1,
  }),
  node("rec-site-launch", {
    title: "Alder site launches after menu photos",
    excerpt: "Launch waits for the new menu photos.",
    status: "disputed",
    scopeId: "pj-alder-site",
    scopeKind: "project",
    scopeName: "Alder website rebuild",
    contributor: kestrelAgents.everest,
  }),
  node("rec-weekend", {
    title: "Weekend opening is 8am",
    excerpt: "Saturday and Sunday opening is 8am.",
    status: "approved",
    scopeId: "cl-alder",
    scopeKind: "client",
    scopeName: "Alder Bakery",
    contributor: kestrelAgents.scribe,
  }),
];

function edge(id: string, overrides: Partial<MemoryGraphEdge> & Pick<MemoryGraphEdge, "from" | "to" | "type">): MemoryGraphEdge {
  return {
    id,
    kind: "explicit",
    origin: "relationship",
    author: kestrelAgents.mason,
    source: { kind: "issue", id: `issue-${id}`, runId: null },
    basis: null,
    createdAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

export const kestrelEdges: MemoryGraphEdge[] = [
  edge("sup:rec-hours", { from: "rec-hours", to: "rec-hours-old", type: "supersedes", origin: "supersession", author: kestrelAgents.john }),
  edge("rel:refines-weekend", { from: "rec-weekend", to: "rec-hours", type: "refines", author: kestrelAgents.scribe }),
  edge("rel:depends-launch", { from: "rec-site-launch", to: "rec-hours", type: "depends_on", author: kestrelAgents.everest }),
  edge("cfl:delivery-hours", {
    from: "rec-delivery",
    to: "rec-hours",
    type: "possible_conflict",
    kind: "inferred",
    origin: "conflict_check",
    author: kestrelAgents.check,
    source: { kind: "memory_conflict", id: "cfl-delivery-hours", runId: null },
  }),
];

export const kestrelGraph: MemoryGraph = {
  note: MEMORY_GRAPH_NOTE,
  nodes: kestrelNodes,
  edges: kestrelEdges,
  scopes: kestrelScopes,
  truncated: false,
};
