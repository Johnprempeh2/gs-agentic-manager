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
import { contributorFocusKey, findCeoAgentId, type MemoryAgentInfo } from "./memoryContributors";

/**
 * Pure data step for the 3D Memory graph (no three.js here, so it is cheap to test).
 *
 * Two kinds of node: one per memory record the server returned, and one hub per
 * contributor (or per scope). Four kinds of link:
 *   - `stated`: an explicit relationship from the data (supersedes included), drawn with an arrow;
 *   - `inferred`: a link check lead or conflict check finding from the data, drawn dashed.
 *     These are "suggested links": left out unless `showSuggested` is on;
 *   - `provenance`: display only, memory to its hub ("contributed by"). It is not a
 *     relationship between memories and never joins two memory records;
 *   - `orbit`: display only, each agent hub to the main agent's hub, so the hubs sit
 *     around it. Never touches a memory record.
 * Memory to memory links come only from `edges`; this function never invents one.
 */

export type MemoryGraphGroupBy = "contributor" | "scope";
/** While contributors are focused, everything else is hidden (default) or dimmed. */
export type MemoryGraphFocusMode = "hide" | "dim";
export type MemoryGraph3DLinkStyle = "stated" | "inferred" | "provenance" | "orbit";

export interface MemoryGraph3DNode {
  /** Memory record id, or `hub:<key>` for a hub. */
  id: string;
  kind: "memory" | "hub";
  label: string;
  /** Memory nodes only. */
  status: MemoryRecordStatus | null;
  /** Stated plus suggested links touching this node (memory nodes); member count (hubs). */
  degree: number;
  /** Relative size for the renderer (a volume: the radius grows with its cube root). */
  val: number;
  /** Memory nodes: the influence score behind `val` (see memoryInfluence). Hubs: 0. */
  influence: number;
  /** Contributor focus key of the memory, or of a contributor hub; null for a scope hub. */
  contributorKey: string | null;
  /** The main agent's hub: pinned at the centre, biggest, always labelled. */
  ceo: boolean;
  /** Memory nodes: their hub's id. Hubs: null. */
  hubId: string | null;
  /** Memory nodes: true when any stated or suggested link touches it (drawn, or not). */
  linked: boolean;
}

export interface MemoryGraph3DLink {
  id: string;
  source: string;
  target: string;
  style: MemoryGraph3DLinkStyle;
  /** The server edge id for stated and inferred links; null for display only links. */
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
  /** Stated links between drawn records. */
  statedCount: number;
  /** Suggested (check found) links between drawn records, whether shown or not. */
  suggestedCount: number;
  /** Whether the suggested links are in `links`. */
  showSuggested: boolean;
  /** The main agent's hub id, when it has entries here (contributor grouping only). */
  ceoHubId: string | null;
  /** Neighbours by node id, from the drawn stated, suggested and provenance links (not orbit). */
  adjacency: Map<string, Set<string>>;
}

/** Keeps the scene smooth: above this the graph draws the first N and says so. */
export const MEMORY_GRAPH_3D_MAX_NODES = 600;

export const HUB_PREFIX = "hub:";

/**
 * Influence weights. A stated link is a person or agent saying two entries belong
 * together, so it counts four times a check's suggestion. Approval adds a little.
 * The graph API has no recall or use count, so use plays no part (nothing is guessed).
 */
export const MEMORY_INFLUENCE_WEIGHTS = { stated: 2, suggested: 0.5, approved: 1.5 } as const;

/** Memory node sizes (renderer `val`, a volume). Clamped so no entry rivals a hub. */
export const MEMORY_NODE_VAL = { min: 0.5, perInfluence: 0.4, max: 4 } as const;
/** Hub sizes: agent hubs grow gently with their entries; the main agent's hub is fixed and largest. */
export const HUB_NODE_VAL = { base: 7, perSqrtMember: 1.2, max: 14, ceo: 100 } as const;

/**
 * How much a memory entry matters in the picture:
 *
 *   influence = 2 × stated links + 0.5 × suggested links + (approved ? 1.5 : 0)
 *
 * Stated links include supersedes. Negative or fractional counts are treated as 0.
 */
export function memoryInfluence(input: { stated: number; suggested: number; approved: boolean }): number {
  const stated = Math.max(0, Math.floor(input.stated));
  const suggested = Math.max(0, Math.floor(input.suggested));
  return (
    stated * MEMORY_INFLUENCE_WEIGHTS.stated +
    suggested * MEMORY_INFLUENCE_WEIGHTS.suggested +
    (input.approved ? MEMORY_INFLUENCE_WEIGHTS.approved : 0)
  );
}

/** Influence to renderer size: small by default, growing linearly, clamped to `MEMORY_NODE_VAL.max`. */
export function memoryNodeVal(influence: number): number {
  const value = MEMORY_NODE_VAL.min + Math.max(0, influence) * MEMORY_NODE_VAL.perInfluence;
  return Math.min(MEMORY_NODE_VAL.max, value);
}

/** Hub size from its entry count; the main agent's hub is always `HUB_NODE_VAL.ceo`. */
export function hubNodeVal(members: number, ceo = false): number {
  if (ceo) return HUB_NODE_VAL.ceo;
  return Math.min(HUB_NODE_VAL.max, HUB_NODE_VAL.base + Math.sqrt(Math.max(0, members)) * HUB_NODE_VAL.perSqrtMember);
}

function contributorHubKey(actor: MemoryActorRef): string {
  if (actor.actorType === "agent" && actor.agentId) return `agent:${actor.agentId}`;
  if (actor.actorType === "user" && actor.userId) return `user:${actor.userId}`;
  return actor.actorType;
}

function hubFor(node: MemoryGraphNode, groupBy: MemoryGraphGroupBy): { key: string; label: string } {
  if (groupBy === "scope") return { key: `scope:${node.scopeId}`, label: node.scopeName || "Scope" };
  return { key: contributorHubKey(node.contributor), label: actorLabel(node.contributor) };
}

export interface BuildMemoryGraph3DOptions {
  groupBy?: MemoryGraphGroupBy;
  maxNodes?: number;
  /** Draw the check found links too (default false: stated links only). */
  showSuggested?: boolean;
  /** The agent list, for the main agent's role and names. */
  agents?: MemoryAgentInfo[];
}

export function buildMemoryGraph3D(
  memoryNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: BuildMemoryGraph3DOptions = {},
): MemoryGraph3DData {
  const groupBy = options.groupBy ?? "contributor";
  const maxNodes = options.maxNodes ?? MEMORY_GRAPH_3D_MAX_NODES;
  const showSuggested = options.showSuggested ?? false;
  const agents = options.agents ?? [];
  const drawn = memoryNodes.slice(0, Math.max(0, maxNodes));
  const drawnIds = new Set(drawn.map((node) => node.id));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

  const links: MemoryGraph3DLink[] = [];
  const stated = new Map<string, number>();
  const suggested = new Map<string, number>();
  const bump = (counts: Map<string, number>, id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  let statedCount = 0;
  let suggestedCount = 0;
  for (const edge of edges) {
    if (!drawnIds.has(edge.from) || !drawnIds.has(edge.to)) continue;
    const isStated = edge.kind === "explicit";
    const counts = isStated ? stated : suggested;
    bump(counts, edge.from);
    if (edge.to !== edge.from) bump(counts, edge.to);
    if (isStated) statedCount += 1;
    else suggestedCount += 1;
    if (!isStated && !showSuggested) continue;
    links.push({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      style: isStated ? "stated" : "inferred",
      edgeId: edge.id,
      edgeType: edge.type,
      basis: edge.basis ?? null,
    });
  }

  const ceoAgentId = groupBy === "contributor" ? findCeoAgentId(agents, drawn.map((node) => node.contributor)) : null;
  const ceoHubId = ceoAgentId ? `${HUB_PREFIX}agent:${ceoAgentId}` : null;

  const hubs = new Map<string, { label: string; members: number; contributorKey: string | null }>();
  const nodes: MemoryGraph3DNode[] = [];
  for (const node of drawn) {
    const hub = hubFor(node, groupBy);
    const hubId = `${HUB_PREFIX}${hub.key}`;
    const focusKey = contributorFocusKey(node.contributor);
    const existing = hubs.get(hubId);
    if (existing) existing.members += 1;
    else {
      const agentName = node.contributor.agentId ? agentNames.get(node.contributor.agentId) : undefined;
      hubs.set(hubId, {
        label: groupBy === "contributor" && agentName ? agentName : hub.label,
        members: 1,
        contributorKey: groupBy === "contributor" ? focusKey : null,
      });
    }
    const statedLinks = stated.get(node.id) ?? 0;
    const suggestedLinks = suggested.get(node.id) ?? 0;
    const influence = memoryInfluence({ stated: statedLinks, suggested: suggestedLinks, approved: node.status === "approved" });
    nodes.push({
      id: node.id,
      kind: "memory",
      label: nodeHeading(node),
      status: node.status,
      degree: statedLinks + suggestedLinks,
      val: memoryNodeVal(influence),
      influence,
      contributorKey: focusKey,
      ceo: false,
      hubId,
      linked: statedLinks + suggestedLinks > 0,
    });
    links.push({ id: `prov:${node.id}`, source: node.id, target: hubId, style: "provenance", edgeId: null, edgeType: null, basis: null });
  }
  for (const [id, hub] of hubs) {
    const ceo = id === ceoHubId;
    nodes.push({
      id,
      kind: "hub",
      label: hub.label,
      status: null,
      degree: hub.members,
      val: hubNodeVal(hub.members, ceo),
      influence: 0,
      contributorKey: hub.contributorKey,
      ceo,
      hubId: null,
      linked: false,
    });
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

  const presentCeoHub = ceoHubId && hubs.has(ceoHubId) ? ceoHubId : null;
  if (presentCeoHub) {
    for (const id of hubs.keys()) {
      if (id === presentCeoHub) continue;
      links.push({ id: `orbit:${id}`, source: id, target: presentCeoHub, style: "orbit", edgeId: null, edgeType: null, basis: null });
    }
  }

  return {
    nodes,
    links,
    memoryCount: drawn.length,
    omittedCount: memoryNodes.length - drawn.length,
    statedCount,
    suggestedCount,
    showSuggested,
    ceoHubId: presentCeoHub,
    adjacency,
  };
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

/**
 * What stays in front when contributors are focused: their entries, the entries one
 * drawn stated or suggested link away, and the hubs of all of those. Null when
 * nothing is focused. It only narrows what the server sent; it never adds.
 */
export function focusNodeIds(data: Pick<MemoryGraph3DData, "nodes" | "links">, contributorKeys: string[]): Set<string> | null {
  if (contributorKeys.length === 0) return null;
  const keys = new Set(contributorKeys);
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const own = new Set(data.nodes.filter((node) => node.kind === "memory" && node.contributorKey !== null && keys.has(node.contributorKey)).map((node) => node.id));
  const ids = new Set(own);
  for (const link of data.links) {
    if (link.style !== "stated" && link.style !== "inferred") continue;
    if (own.has(link.source)) ids.add(link.target);
    if (own.has(link.target)) ids.add(link.source);
  }
  for (const id of [...ids]) {
    const hubId = byId.get(id)?.hubId;
    if (hubId) ids.add(hubId);
  }
  return ids;
}
