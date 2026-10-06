import type {
  MemoryActorRef,
  MemoryGraphEdge,
  MemoryGraphEdgeType,
  MemoryGraphNode,
  MemoryLinkBasis,
  MemoryRecordStatus,
} from "@greatstone/shared";
import { actorLabel } from "./memoryLabels";
import { nodeHeading } from "./MemoryRecordList";

/**
 * Pure data step for the 3D Memory graph (no three.js here, so it is cheap to test).
 *
 * Two kinds of node: one per memory record the server returned, and one hub per
 * contributor (or per scope). Three kinds of link:
 *   - `stated`: an explicit relationship from the data, drawn with an arrow;
 *   - `inferred`: an engine or conflict check finding from the data, drawn dashed;
 *   - `provenance`: display only, memory to its hub ("contributed by"). It is not a
 *     relationship between memories and never joins two memory records.
 * Memory to memory links come only from `edges`; this function never invents one.
 */

export type MemoryGraphGroupBy = "contributor" | "scope";
export type MemoryGraph3DLinkStyle = "stated" | "inferred" | "provenance";

export interface MemoryGraph3DNode {
  /** Memory record id, or `hub:<key>` for a hub. */
  id: string;
  kind: "memory" | "hub";
  label: string;
  /** Memory nodes only. */
  status: MemoryRecordStatus | null;
  /** Stated plus inferred links touching this node (memory nodes); member count (hubs). */
  degree: number;
  /** Relative size for the renderer: grows with links, hubs with members. */
  val: number;
}

export interface MemoryGraph3DLink {
  id: string;
  source: string;
  target: string;
  style: MemoryGraph3DLinkStyle;
  /** The server edge id for stated and inferred links; null for provenance links. */
  edgeId: string | null;
  edgeType: MemoryGraphEdgeType | null;
  /** What the link check matched, for its leads and links confirmed from them; null otherwise. */
  basis: MemoryLinkBasis | null;
}

export interface MemoryGraph3DData {
  nodes: MemoryGraph3DNode[];
  links: MemoryGraph3DLink[];
  /** Memory records drawn (after the render cap). */
  memoryCount: number;
  /** Memory records left out of the drawing because of the render cap. */
  omittedCount: number;
  /** Neighbours by node id, from every link. Built before the renderer turns link ends into objects. */
  adjacency: Map<string, Set<string>>;
}

/** Keeps the scene smooth: above this the graph draws the first N and says so. */
export const MEMORY_GRAPH_3D_MAX_NODES = 600;

export const HUB_PREFIX = "hub:";

function contributorKey(actor: MemoryActorRef): string {
  if (actor.actorType === "agent" && actor.agentId) return `agent:${actor.agentId}`;
  if (actor.actorType === "user" && actor.userId) return `user:${actor.userId}`;
  return actor.actorType;
}

function hubFor(node: MemoryGraphNode, groupBy: MemoryGraphGroupBy): { key: string; label: string } {
  if (groupBy === "scope") return { key: `scope:${node.scopeId}`, label: node.scopeName || "Scope" };
  return { key: contributorKey(node.contributor), label: actorLabel(node.contributor) };
}

function memoryVal(degree: number) {
  return 1 + Math.min(degree, 8) * 1.5;
}

function hubVal(members: number) {
  return 6 + Math.min(Math.sqrt(members) * 2, 18);
}

export function buildMemoryGraph3D(
  memoryNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: { groupBy?: MemoryGraphGroupBy; maxNodes?: number } = {},
): MemoryGraph3DData {
  const groupBy = options.groupBy ?? "contributor";
  const maxNodes = options.maxNodes ?? MEMORY_GRAPH_3D_MAX_NODES;
  const drawn = memoryNodes.slice(0, Math.max(0, maxNodes));
  const drawnIds = new Set(drawn.map((node) => node.id));

  const links: MemoryGraph3DLink[] = [];
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (!drawnIds.has(edge.from) || !drawnIds.has(edge.to)) continue;
    links.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      style: edge.kind === "explicit" ? "stated" : "inferred",
      edgeId: edge.id,
      edgeType: edge.type,
      basis: edge.basis ?? null,
    });
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    if (edge.to !== edge.from) degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const hubs = new Map<string, { label: string; members: number }>();
  const nodes: MemoryGraph3DNode[] = [];
  for (const node of drawn) {
    const hub = hubFor(node, groupBy);
    const hubId = `${HUB_PREFIX}${hub.key}`;
    const existing = hubs.get(hubId);
    if (existing) existing.members += 1;
    else hubs.set(hubId, { label: hub.label, members: 1 });
    const count = degree.get(node.id) ?? 0;
    nodes.push({ id: node.id, kind: "memory", label: nodeHeading(node), status: node.status, degree: count, val: memoryVal(count) });
    links.push({ id: `prov:${node.id}`, source: node.id, target: hubId, style: "provenance", edgeId: null, edgeType: null, basis: null });
  }
  for (const [id, hub] of hubs) {
    nodes.push({ id, kind: "hub", label: hub.label, status: null, degree: hub.members, val: hubVal(hub.members) });
  }

  const adjacency = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const link of links) {
    join(link.source, link.target);
    join(link.target, link.source);
  }

  return { nodes, links, memoryCount: drawn.length, omittedCount: memoryNodes.length - drawn.length, adjacency };
}

/** Ids of the focused nodes and everything one link away, for hover and selection highlight. */
export function neighbourhood(adjacency: Map<string, Set<string>>, focusIds: Array<string | null | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const id of focusIds) {
    if (!id) continue;
    ids.add(id);
    for (const next of adjacency.get(id) ?? []) ids.add(next);
  }
  return ids;
}
