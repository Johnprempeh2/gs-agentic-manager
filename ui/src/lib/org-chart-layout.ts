import type { AgentTeam } from "@greatstone/shared";
import type { OrgNode } from "../api/agents";
import type { TeamGroup } from "./agent-teams";

// Cards have a fixed height and clamp their text, so long names or task titles
// can never push a card into the row below.
export const CARD_W = 248;
export const CARD_H = 136;
export const GAP_X = 32;
export const GAP_Y = 64;
export const PADDING = 60;
/** A manager with more reports than this stacks them in compact columns. */
export const COMPACT_THRESHOLD = 4;
/** Most cards in one compact column before a new column starts. */
export const COMPACT_MAX_ROWS = 5;
export const COMPACT_INDENT = 28;
export const COMPACT_GAP_Y = 12;
export const COMPACT_TOP_GAP = 36;

export interface LayoutNode {
  id: string;
  /**
   * Unique card key. Equals `id` in the reporting-line view; in the team view
   * an agent in two teams has two cards, so the key adds the team.
   */
  key: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  depth: number;
  parentId: string | null;
  /** Direct reports in the data, whether or not the branch is collapsed. */
  reportCount: number;
  collapsed: boolean;
  /** How this node's children hang off it. */
  childLayout: "row" | "compact";
  /** x of the vertical line a compact-column child hangs from. */
  spineX?: number;
  children: LayoutNode[];
}

export interface OrgEdge {
  parent: LayoutNode;
  child: LayoutNode;
  path: string;
}

interface Measured {
  node: OrgNode;
  children: Measured[];
  columns: Measured[][] | null;
  width: number;
  height: number;
}

function chunkColumns<T>(items: T[]): T[][] {
  const columnCount = Math.ceil(items.length / COMPACT_MAX_ROWS);
  const perColumn = Math.ceil(items.length / columnCount);
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += perColumn) columns.push(items.slice(i, i + perColumn));
  return columns;
}

function columnWidth(column: Measured[]): number {
  return COMPACT_INDENT + Math.max(...column.map((c) => c.width));
}

function columnHeight(column: Measured[]): number {
  return column.reduce((sum, c) => sum + c.height, 0) + (column.length - 1) * COMPACT_GAP_Y;
}

function measure(node: OrgNode, collapsed: ReadonlySet<string>): Measured {
  const visible = collapsed.has(node.id) ? [] : node.reports;
  const children = visible.map((child) => measure(child, collapsed));
  if (children.length === 0) {
    return { node, children, columns: null, width: CARD_W, height: CARD_H };
  }

  if (children.length <= COMPACT_THRESHOLD) {
    const rowW = children.reduce((sum, c) => sum + c.width, 0) + (children.length - 1) * GAP_X;
    return {
      node,
      children,
      columns: null,
      width: Math.max(CARD_W, rowW),
      height: CARD_H + GAP_Y + Math.max(...children.map((c) => c.height)),
    };
  }

  const columns = chunkColumns(children);
  const colsW = columns.reduce((sum, col) => sum + columnWidth(col), 0) + (columns.length - 1) * GAP_X;
  return {
    node,
    children,
    columns,
    width: Math.max(CARD_W, colsW),
    height: CARD_H + COMPACT_TOP_GAP + Math.max(...columns.map(columnHeight)),
  };
}

function place(
  m: Measured,
  left: number,
  top: number,
  depth: number,
  parentId: string | null,
  collapsed: ReadonlySet<string>,
): LayoutNode {
  const children: LayoutNode[] = [];

  if (m.columns) {
    const colsW = m.columns.reduce((sum, col) => sum + columnWidth(col), 0) + (m.columns.length - 1) * GAP_X;
    let cx = left + (m.width - colsW) / 2;
    for (const column of m.columns) {
      let cy = top + CARD_H + COMPACT_TOP_GAP;
      for (const child of column) {
        const placed = place(child, cx + COMPACT_INDENT, cy, depth + 1, m.node.id, collapsed);
        placed.spineX = cx + COMPACT_INDENT / 2;
        children.push(placed);
        cy += child.height + COMPACT_GAP_Y;
      }
      cx += columnWidth(column) + GAP_X;
    }
  } else if (m.children.length > 0) {
    const rowW = m.children.reduce((sum, c) => sum + c.width, 0) + (m.children.length - 1) * GAP_X;
    let cx = left + (m.width - rowW) / 2;
    for (const child of m.children) {
      children.push(place(child, cx, top + CARD_H + GAP_Y, depth + 1, m.node.id, collapsed));
      cx += child.width + GAP_X;
    }
  }

  return {
    id: m.node.id,
    key: m.node.id,
    name: m.node.name,
    role: m.node.role,
    status: m.node.status,
    x: left + (m.width - CARD_W) / 2,
    y: top,
    depth,
    parentId,
    reportCount: m.node.reports.length,
    collapsed: collapsed.has(m.node.id) && m.node.reports.length > 0,
    childLayout: m.columns ? "compact" : "row",
    children,
  };
}

/** Lay out all roots side by side, skipping the reports of collapsed managers. */
export function layoutForest(roots: OrgNode[], collapsed: ReadonlySet<string> = new Set()): LayoutNode[] {
  let x = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const m = measure(root, collapsed);
    result.push(place(m, x, PADDING, 0, null, collapsed));
    x += m.width + GAP_X;
  }
  return result;
}

export function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  const walk = (n: LayoutNode) => {
    result.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return result;
}

export function collectEdges(nodes: LayoutNode[]): OrgEdge[] {
  const edges: OrgEdge[] = [];
  const walk = (parent: LayoutNode) => {
    const x1 = parent.x + CARD_W / 2;
    const y1 = parent.y + CARD_H;
    for (const child of parent.children) {
      let path: string;
      if (parent.childLayout === "compact") {
        const busY = y1 + COMPACT_TOP_GAP / 2;
        const spineX = child.spineX ?? child.x - COMPACT_INDENT / 2;
        const midY = child.y + CARD_H / 2;
        path = `M ${x1} ${y1} V ${busY} H ${spineX} V ${midY} H ${child.x}`;
      } else {
        const x2 = child.x + CARD_W / 2;
        const midY = (y1 + child.y) / 2;
        path = `M ${x1} ${y1} V ${midY} H ${x2} V ${child.y}`;
      }
      edges.push({ parent, child, path });
      walk(child);
    }
  };
  nodes.forEach(walk);
  return edges;
}

export function layoutBounds(nodes: LayoutNode[]): { width: number; height: number } {
  if (nodes.length === 0) return { width: 800, height: 600 };
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + CARD_W);
    maxY = Math.max(maxY, n.y + CARD_H);
  }
  return { width: maxX + PADDING, height: maxY + PADDING };
}

// ── Group by team ───────────────────────────────────────────────────────

export const TEAM_BOX_PAD = 16;
export const TEAM_BOX_HEADER = 36;
export const TEAM_BOX_GAP = 40;
/** Most cards side by side in one team box. */
export const TEAM_BOX_MAX_COLS = 3;
/** Team boxes wrap to a new row past this width, so the view stays phone-friendly. */
export const TEAM_ROW_MAX_WIDTH = 1700;

export interface TeamBox {
  /** Team id, or "none" for the No team group. */
  key: string;
  team: AgentTeam | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Lays out the "group by team" view: one box per team holding its members'
 * cards in a small grid, boxes wrapping into rows. Reporting lines are not
 * drawn here; an agent in two teams gets a card in each box.
 */
export function layoutTeamGroups(groups: TeamGroup<OrgNode>[]): { nodes: LayoutNode[]; boxes: TeamBox[] } {
  const nodes: LayoutNode[] = [];
  const boxes: TeamBox[] = [];
  let x = PADDING;
  let y = PADDING;
  let rowHeight = 0;
  for (const group of groups) {
    const count = group.agents.length;
    const cols = Math.min(count, TEAM_BOX_MAX_COLS);
    const rows = Math.ceil(count / cols);
    const width = TEAM_BOX_PAD * 2 + cols * CARD_W + (cols - 1) * GAP_X;
    const height = TEAM_BOX_HEADER + TEAM_BOX_PAD + rows * CARD_H + (rows - 1) * COMPACT_GAP_Y;
    if (x > PADDING && x + width > PADDING + TEAM_ROW_MAX_WIDTH) {
      x = PADDING;
      y += rowHeight + TEAM_BOX_GAP;
      rowHeight = 0;
    }
    const key = group.team?.id ?? "none";
    boxes.push({ key, team: group.team, x, y, width, height });
    group.agents.forEach((agent, i) => {
      nodes.push({
        id: agent.id,
        key: `${key}:${agent.id}`,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        x: x + TEAM_BOX_PAD + (i % cols) * (CARD_W + GAP_X),
        y: y + TEAM_BOX_HEADER + Math.floor(i / cols) * (CARD_H + COMPACT_GAP_Y),
        depth: 0,
        parentId: null,
        reportCount: 0,
        collapsed: false,
        childLayout: "row",
        children: [],
      });
    });
    x += width + TEAM_BOX_GAP;
    rowHeight = Math.max(rowHeight, height);
  }
  return { nodes, boxes };
}

/** Ids of every ancestor of `id` in the raw org tree, root first. */
export function ancestorIds(roots: OrgNode[], id: string): string[] | null {
  for (const root of roots) {
    if (root.id === id) return [];
    const below = ancestorIds(root.reports, id);
    if (below) return [root.id, ...below];
  }
  return null;
}

export function flattenOrg(roots: OrgNode[]): OrgNode[] {
  const result: OrgNode[] = [];
  const walk = (n: OrgNode) => {
    result.push(n);
    n.reports.forEach(walk);
  };
  roots.forEach(walk);
  return result;
}
