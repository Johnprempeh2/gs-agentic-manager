import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import {
  BufferAttribute,
  CanvasTexture,
  Color,
  Group,
  Line,
  LineDashedMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  type Object3D,
  type PerspectiveCamera,
} from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  neighbourhood,
  type MemoryGraph3DData,
  type MemoryGraph3DLink,
  type MemoryGraph3DNode,
  type MemoryGraphFocusMode,
} from "./memoryGraph3dData";
import { readMemoryGraphPalette, rgba, type MemoryGraphPalette, type Rgb } from "./memoryGraphPalette";
import { basisLines, EDGE_KIND_LABEL, edgeTypeLabel, memoryStatusMeta } from "./memoryLabels";

/**
 * The 3D Memory graph (three.js via react-force-graph-3d). Loaded with React.lazy
 * from the Memory page so three.js stays out of the main bundle. It only draws what
 * the page hands it; it never adds records or relationships. Focus (hide or dim)
 * only changes what is drawn in front, never what the data holds.
 */

type GraphNode = NodeObject<MemoryGraph3DNode>;
type GraphLink = LinkObject<MemoryGraph3DNode, MemoryGraph3DLink>;

const NODE_REL_SIZE = 4;
const LABEL_MAX = 48;
const DOUBLE_CLICK_MS = 320;
const ROTATE_RESUME_MS = 6000;
const FOCUS_DISTANCE = 90;
/** The camera never frames closer than this, so a small focused cluster is not blown up. */
const MIN_CAMERA_DISTANCE = 200;
/** Opacity of nodes pushed to the back by hover, selection or focus. */
const DIMMED = 0.1;
/** The main agent's hub when it is only context for a focused agent. */
const CONTEXT = 0.4;
/** Sprite scales without size attenuation (about 17px, 22px and 15px on a 470px tall canvas). */
const HUB_LABEL_SCREEN_HEIGHT = 0.026;
const CEO_LABEL_SCREEN_HEIGHT = 0.034;
const MEMORY_LABEL_SCREEN_HEIGHT = 0.022;
/** The main agent's halo, as a multiple of its node radius. */
const CEO_HALO_SCALE = 3.4;

/**
 * Motion tuning, kept in one place. The graph used to bounce about too much, so these
 * favour a calm scene: heavy damping, a quick settle, a faint slow drift and a slow spin.
 *
 * - VELOCITY_DECAY: share of speed lost each tick (d3 default 0.4). Higher is calmer.
 * - ALPHA_DECAY: how fast the layout cools; the first 100 ticks run off screen as warmup.
 * - DRIFT_STRENGTH / DRIFT_SPEED: the settled "breathing" wobble.
 * - AUTO_ROTATE_SPEED: OrbitControls units (2.0 is one turn a minute).
 * - FIT_TICKS: visible engine ticks after new data at which the camera reframes.
 * - FOCUS_MS: how long the camera takes to ease to a focused agent.
 */
const MOTION = {
  VELOCITY_DECAY: 0.6,
  ALPHA_DECAY: 0.045,
  DRIFT_STRENGTH: 0.004,
  DRIFT_SPEED: 0.004,
  AUTO_ROTATE_SPEED: 0.15,
  FIT_TICKS: [25, 60] as const,
  FOCUS_MS: 1200,
} as const;

/**
 * Layout tuning. Agent hubs are held around the main agent's hub (pinned at the
 * centre) by their display only orbit links and push each other apart; entries sit
 * near their hub, closer still when nothing links them. Suggested links do not pull
 * at all (strength 0), so turning them on does not reshape the picture.
 */
const LAYOUT = {
  ORBIT_DISTANCE: 150,
  PROVENANCE_DISTANCE: 30,
  LONE_PROVENANCE_DISTANCE: 16,
  STATED_DISTANCE: 45,
  SUGGESTED_DISTANCE: 60,
  STRENGTH: { orbit: 0.7, provenance: 0.6, stated: 0.25, inferred: 0 },
  CHARGE: { ceo: -500, hub: -320, memory: -22 },
} as const;

export interface MemoryGraph3DProps {
  data: MemoryGraph3DData;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** Node ids to keep in front (a focused agent's cluster); null shows everything. */
  focusIds?: Set<string> | null;
  /** What happens to everything else while focused. */
  focusMode?: MemoryGraphFocusMode;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  /** CSS height of the canvas box; width follows the container. */
  className?: string;
}

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Re-read the tokens when the app flips light/dark (ThemeProvider toggles `.dark` on <html>). */
function usePalette() {
  const [palette, setPalette] = useState<MemoryGraphPalette>(() => readMemoryGraphPalette());
  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readMemoryGraphPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ignore a zero size (the page hidden, a collapsed parent) so the scene keeps its state.
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function clip(text: string) {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

function endId(end: GraphLink["source"]): string {
  return typeof end === "object" && end !== null ? String((end as { id?: unknown }).id) : String(end);
}

function endNode(end: GraphLink["source"]): GraphNode | null {
  return typeof end === "object" && end !== null ? (end as GraphNode) : null;
}

/**
 * A flat text label that always faces the camera, drawn on a canvas in the app font.
 * Fixed on-screen size (no size attenuation) so names stay readable at any zoom,
 * anchored just above the node and drawn on top of everything.
 */
function textSprite(text: string, palette: MemoryGraphPalette, screenHeight: number, weight = 600): Sprite {
  const scale = 4;
  const fontPx = 14 * scale;
  const pad = 6 * scale;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `${weight} ${fontPx}px ${palette.fontFamily}`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = fontPx + pad * 2;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 6 * scale * 0.5;
  ctx.strokeStyle = rgba(palette.background, 0.85);
  ctx.strokeText(text, pad, canvas.height / 2);
  ctx.fillStyle = rgba(palette.foreground);
  ctx.fillText(text, pad, canvas.height / 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false });
  const sprite = new Sprite(material);
  sprite.scale.set((screenHeight * canvas.width) / canvas.height, screenHeight, 1);
  sprite.center.set(0.5, -0.9);
  sprite.renderOrder = 20;
  return sprite;
}

/** A soft ring and glow around the main agent's hub, facing the camera, in the hub colour. */
function haloSprite(palette: MemoryGraphPalette, radius: number): Sprite {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const glow = ctx.createRadialGradient(c, c, size * 0.2, c, c, size * 0.5);
  glow.addColorStop(0, rgba(palette.hub, 0.35));
  glow.addColorStop(0.6, rgba(palette.hub, 0.12));
  glow.addColorStop(1, rgba(palette.hub, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  // The ring is in the text colour so it stands apart from the hub colour in both themes.
  ctx.beginPath();
  ctx.arc(c, c, size * 0.36, 0, Math.PI * 2);
  ctx.lineWidth = size * 0.03;
  ctx.strokeStyle = rgba(palette.foreground, 0.85);
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new Sprite(material);
  const world = radius * CEO_HALO_SCALE;
  sprite.scale.set(world, world, 1);
  sprite.renderOrder = 5;
  return sprite;
}

/** Pulls every node gently towards the centre, so loose clusters stay in one view. Scales with alpha, so it settles. */
function gravityForce(strength = 0.04) {
  let nodes: GraphNode[] = [];
  const force = (alpha: number) => {
    const k = strength * alpha;
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - (node.x ?? 0) * k;
      node.vy = (node.vy ?? 0) - (node.y ?? 0) * k;
      node.vz = (node.vz ?? 0) - (node.z ?? 0) * k;
    }
  };
  force.initialize = (next: GraphNode[]) => {
    nodes = next;
  };
  return force;
}

/** Faint, slow zero-mean wobble so the settled graph keeps breathing. Ignores alpha on purpose. */
function driftForce(strength: number = MOTION.DRIFT_STRENGTH, speed: number = MOTION.DRIFT_SPEED) {
  let nodes: GraphNode[] = [];
  let t = 0;
  const phases = new WeakMap<object, number>();
  const force = () => {
    t += speed;
    for (const node of nodes) {
      let phase = phases.get(node);
      if (phase === undefined) {
        phase = Math.random() * Math.PI * 2;
        phases.set(node, phase);
      }
      node.vx = (node.vx ?? 0) + Math.sin(t + phase) * strength;
      node.vy = (node.vy ?? 0) + Math.cos(t * 0.8 + phase) * strength;
      node.vz = (node.vz ?? 0) + Math.sin(t * 0.6 + phase * 1.3) * strength;
    }
  };
  force.initialize = (next: GraphNode[]) => {
    nodes = next;
  };
  return force;
}

type LinkState = "lit" | "normal" | "dim";

const EMPTY_GRAPH: { nodes: GraphNode[]; links: GraphLink[] } = { nodes: [], links: [] };

/** Opacity per link style and state. Stated links read clearly; the rest stay in the background. */
const LINK_ALPHA: Record<MemoryGraph3DLink["style"], Record<LinkState, number>> = {
  stated: { lit: 0.95, normal: 0.55, dim: 0.06 },
  inferred: { lit: 0.6, normal: 0.2, dim: 0.03 },
  provenance: { lit: 0.35, normal: 0.1, dim: 0.02 },
  orbit: { lit: 0.25, normal: 0.14, dim: 0.03 },
};

export default function MemoryGraph3D({
  data,
  selectedNodeId,
  selectedEdgeId,
  focusIds = null,
  focusMode = "hide",
  onSelectNode,
  onSelectEdge,
  className,
}: MemoryGraph3DProps) {
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [boxRef, size] = useElementSize<HTMLDivElement>();
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);

  // The renderer mutates node objects (positions), so it gets its own copies. They are
  // kept by id across data changes (suggested links on or off, a new filter), so the
  // layout carries on from where it was instead of starting again. The main agent's
  // hub is pinned at the centre.
  // Suggested links join only once the first layout has settled: they do not pull, but
  // they still change how d3 shares out the other links' pull, which loosens the clusters
  // when they are there from the start. Added later, they leave the picture as it is.
  const nodeObjects = useRef(new Map<string, GraphNode>());
  const [settled, setSettled] = useState(false);
  const graphData = useMemo(() => {
    const previous = nodeObjects.current;
    const next = new Map<string, GraphNode>();
    const nodes = data.nodes.map((node) => {
      const object = Object.assign(previous.get(node.id) ?? {}, node) as GraphNode;
      if (node.ceo) {
        object.fx = 0;
        object.fy = 0;
        object.fz = 0;
      } else {
        object.fx = undefined;
        object.fy = undefined;
        object.fz = undefined;
      }
      next.set(node.id, object);
      return object;
    });
    nodeObjects.current = next;
    const links = settled ? data.links : data.links.filter((link) => link.style !== "inferred");
    return { nodes, links: links.map((link) => ({ ...link })) };
  }, [data, settled]);

  const hiding = focusIds !== null && focusMode === "hide";
  const isVisible = useCallback(
    (node: Pick<MemoryGraph3DNode, "id" | "ceo">) => !hiding || node.ceo || focusIds!.has(node.id),
    [hiding, focusIds],
  );

  const selectedEdge = useMemo(() => data.links.find((link) => link.edgeId && link.edgeId === selectedEdgeId), [data, selectedEdgeId]);
  const highlight = useMemo(() => {
    if (hoverId) return neighbourhood(data.adjacency, [hoverId]);
    if (selectedNodeId) return neighbourhood(data.adjacency, [selectedNodeId]);
    if (selectedEdge) return new Set([selectedEdge.source, selectedEdge.target]);
    return null;
  }, [data, hoverId, selectedNodeId, selectedEdge]);
  const pointId = hoverId ?? selectedNodeId;
  const ready = size.width > 0 && size.height > 0;

  /** 1 in front, CONTEXT for the main agent behind a focus, DIMMED for the rest. */
  const nodeAlpha = useCallback(
    (node: Pick<MemoryGraph3DNode, "id" | "ceo">) => {
      if (highlight) return highlight.has(node.id) ? 1 : DIMMED;
      if (focusIds && !focusIds.has(node.id)) return node.ceo ? CONTEXT : DIMMED;
      return 1;
    },
    [highlight, focusIds],
  );

  const nodeColor = useCallback(
    (node: GraphNode) => {
      const base = node.kind === "hub" ? palette.hub : palette.status[node.status ?? "unreviewed"];
      const alpha = nodeAlpha(node);
      return rgba(base, alpha === 1 && node.kind === "memory" && node.status === "superseded" ? 0.7 : alpha);
    },
    [palette, nodeAlpha],
  );

  const linkState = useCallback(
    (link: GraphLink): LinkState => {
      const source = endId(link.source);
      const target = endId(link.target);
      if (highlight) {
        if (selectedEdge && !hoverId && !selectedNodeId) return link.edgeId === selectedEdge.edgeId ? "lit" : "dim";
        return pointId !== null && (source === pointId || target === pointId) ? "lit" : "dim";
      }
      if (focusIds && !(focusIds.has(source) && focusIds.has(target))) return "dim";
      return "normal";
    },
    [highlight, selectedEdge, hoverId, selectedNodeId, pointId, focusIds],
  );

  const linkPaint = useCallback(
    (link: GraphLink): { rgb: Rgb; alpha: number } => {
      const alpha = LINK_ALPHA[link.style][linkState(link)];
      if (link.style === "stated") return { rgb: palette.foreground, alpha };
      if (link.style === "orbit") return { rgb: palette.hub, alpha };
      return { rgb: palette.muted, alpha };
    },
    [palette, linkState],
  );
  const linkColor = useCallback((link: GraphLink) => {
    const { rgb, alpha } = linkPaint(link);
    return rgba(rgb, alpha);
  }, [linkPaint]);

  // By id, not by node object: the renderer asks before the layout has turned link ends
  // into objects. An orbit link always ends at the main agent's hub, which stays visible.
  const linkVisible = useCallback(
    (link: GraphLink) => {
      if (!hiding) return true;
      const source = endId(link.source);
      if (link.style === "orbit") return focusIds!.has(source);
      return focusIds!.has(source) && focusIds!.has(endId(link.target));
    },
    [hiding, focusIds],
  );

  // Dashed lines need their own material (and line distances, see linkPositionUpdate).
  const dashedMaterials = useRef(new Map<string, LineDashedMaterial>());
  const linkMaterial = useCallback(
    (link: GraphLink) => {
      if (link.style !== "inferred") return null;
      const { rgb, alpha } = linkPaint(link);
      const key = rgba(rgb, alpha);
      let material = dashedMaterials.current.get(key);
      if (!material) {
        material = new LineDashedMaterial({ color: new Color(rgba(rgb)), dashSize: 2.5, gapSize: 3, transparent: true, opacity: alpha, depthWrite: false });
        dashedMaterials.current.set(key, material);
      }
      return material;
    },
    [linkPaint],
  );
  useEffect(() => {
    const materials = dashedMaterials.current;
    return () => {
      for (const material of materials.values()) material.dispose();
      materials.clear();
    };
  }, []);

  const linkPositionUpdate = useCallback((obj: Object3D, { start, end }: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }, link: object) => {
    if ((link as GraphLink).style !== "inferred" || !(obj as Line).isLine) return false;
    const line = obj as Line;
    let position = line.geometry.getAttribute("position") as BufferAttribute | undefined;
    if (!position || position.array.length !== 6) {
      position = new BufferAttribute(new Float32Array(6), 3);
      line.geometry.setAttribute("position", position);
    }
    position.setXYZ(0, start.x, start.y || 0, start.z || 0);
    position.setXYZ(1, end.x, end.y || 0, end.z || 0);
    position.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.computeLineDistances();
    return true;
  }, []);

  // Labels: every hub (the main agent's larger, with its halo) and the selected entry.
  // Kept by node id so focus and hover can fade them without rebuilding them.
  const labelSprites = useRef(new Map<string, Sprite[]>());
  const nodeThreeObject = useCallback(
    (node: GraphNode) => {
      const id = String(node.id);
      if (node.kind === "hub" && node.ceo) {
        const group = new Group();
        const radius = Math.cbrt(node.val) * NODE_REL_SIZE;
        const halo = haloSprite(palette, radius);
        const label = textSprite(clip(node.label), palette, CEO_LABEL_SCREEN_HEIGHT, 700);
        group.add(halo, label);
        labelSprites.current.set(id, [halo, label]);
        return group;
      }
      if (node.kind === "hub") {
        const label = textSprite(clip(node.label), palette, HUB_LABEL_SCREEN_HEIGHT);
        labelSprites.current.set(id, [label]);
        return label;
      }
      if (id === selectedNodeId) {
        const label = textSprite(clip(node.label), palette, MEMORY_LABEL_SCREEN_HEIGHT, 500);
        labelSprites.current.set(id, [label]);
        return label;
      }
      labelSprites.current.delete(id);
      return undefined as unknown as Object3D;
    },
    [palette, selectedNodeId],
  );
  useEffect(() => {
    for (const [id, sprites] of labelSprites.current) {
      const node = nodeObjects.current.get(id);
      if (!node) continue;
      const alpha = nodeAlpha(node);
      for (const sprite of sprites) (sprite.material as SpriteMaterial).opacity = alpha === 1 ? 1 : Math.max(alpha, 0.15);
    }
  }, [nodeAlpha, nodeThreeObject, graphData]);

  const nodeLabel = useCallback((node: GraphNode) => {
    if (node.kind === "hub") {
      const entries = `${node.degree} ${node.degree === 1 ? "entry" : "entries"}`;
      return `<strong>${escapeHtml(node.label)}</strong><br/>${node.ceo ? `Main agent, ${entries}` : entries}`;
    }
    const status = memoryStatusMeta[node.status ?? "unreviewed"].label;
    return `<strong>${escapeHtml(clip(node.label))}</strong><br/>${escapeHtml(status)}${node.degree ? `, ${node.degree} ${node.degree === 1 ? "link" : "links"}` : ""}`;
  }, []);

  const linkLabel = useCallback((link: GraphLink) => {
    if (link.style === "provenance" || link.style === "orbit" || !link.edgeType) return "";
    const basis = basisLines(link.basis).map((line) => `<br/>${escapeHtml(clip(line))}`).join("");
    return `${escapeHtml(edgeTypeLabel[link.edgeType])}<br/>${link.style === "stated" ? EDGE_KIND_LABEL.explicit : EDGE_KIND_LABEL.inferred}${basis}`;
  }, []);

  const focusCamera = useCallback(
    (node: GraphNode) => {
      const fg = graphRef.current;
      if (!fg) return;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const z = node.z ?? 0;
      const distance = Math.hypot(x, y, z);
      // The main agent sits at the origin, so step back along the view axis instead.
      if (distance < 1) {
        fg.cameraPosition({ x, y, z: z + FOCUS_DISTANCE * 2 }, { x, y, z }, reducedMotion ? 0 : MOTION.FOCUS_MS);
        return;
      }
      const ratio = 1 + FOCUS_DISTANCE / distance;
      fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, reducedMotion ? 0 : MOTION.FOCUS_MS);
    },
    [reducedMotion],
  );

  const setAutoRotate = useCallback(
    (on: boolean) => {
      const controls = graphRef.current?.controls() as OrbitControls | undefined;
      if (controls) controls.autoRotate = on && !reducedMotion;
    },
    [reducedMotion],
  );

  const pauseRotation = useCallback(() => {
    window.clearTimeout(resumeTimer.current);
    setAutoRotate(false);
    resumeTimer.current = window.setTimeout(() => {
      if (!hovering.current) setAutoRotate(true);
    }, ROTATE_RESUME_MS);
  }, [setAutoRotate]);

  const onNodeClick = useCallback(
    (node: GraphNode) => {
      if (!isVisible(node)) return;
      pauseRotation();
      const now = Date.now();
      const previous = lastClick.current;
      lastClick.current = { id: String(node.id), at: now };
      if (previous && previous.id === node.id && now - previous.at < DOUBLE_CLICK_MS) {
        focusCamera(node);
        return;
      }
      if (node.kind === "memory") onSelectNode(String(node.id));
      else focusCamera(node);
    },
    [focusCamera, onSelectNode, pauseRotation, isVisible],
  );

  const onLinkClick = useCallback(
    (link: GraphLink) => {
      if (link.edgeId && linkVisible(link)) onSelectEdge(link.edgeId);
    },
    [onSelectEdge, linkVisible],
  );

  const onNodeHover = useCallback(
    (node: GraphNode | null) => {
      const target = node && isVisible(node) ? node : null;
      hovering.current = target !== null;
      setHoverId(target ? String(target.id) : null);
      if (target) pauseRotation();
      if (boxRef.current) boxRef.current.style.cursor = target ? "pointer" : "";
    },
    [pauseRotation, boxRef, isVisible],
  );

  // Forces, controls: set once the instance exists, and again when motion changes. The
  // renderer gets the data only after this (see `forcesReady`), so the off screen warmup
  // already uses these forces rather than the library defaults.
  const [forcesReady, setForcesReady] = useState(false);
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    type LinkForce = {
      distance: (fn: (link: GraphLink) => number) => LinkForce;
      strength: (fn: (link: GraphLink) => number) => LinkForce;
    };
    const linkForce = fg.d3Force("link") as unknown as LinkForce | undefined;
    linkForce
      ?.distance((link) => {
        if (link.style === "orbit") return LAYOUT.ORBIT_DISTANCE;
        if (link.style === "provenance") return endNode(link.source)?.linked === false ? LAYOUT.LONE_PROVENANCE_DISTANCE : LAYOUT.PROVENANCE_DISTANCE;
        return link.style === "stated" ? LAYOUT.STATED_DISTANCE : LAYOUT.SUGGESTED_DISTANCE;
      })
      .strength((link) => LAYOUT.STRENGTH[link.style]);
    const charge = fg.d3Force("charge") as unknown as { strength: (fn: (node: GraphNode) => number) => void } | undefined;
    charge?.strength((node) => (node.kind === "hub" ? (node.ceo ? LAYOUT.CHARGE.ceo : LAYOUT.CHARGE.hub) : LAYOUT.CHARGE.memory));
    fg.d3Force("gravity", gravityForce());
    fg.d3Force("drift", reducedMotion ? null : driftForce());

    const controls = fg.controls() as OrbitControls;
    controls.autoRotateSpeed = MOTION.AUTO_ROTATE_SPEED;
    controls.enableDamping = true;
    controls.autoRotate = !reducedMotion;
    const onStart = () => pauseRotation();
    controls.addEventListener("start", onStart);
    setForcesReady(true);    return () => controls.removeEventListener("start", onStart);
  }, [reducedMotion, pauseRotation, ready]);

  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || !palette.dark) return;
    const composer = fg.postProcessingComposer();
    // Small radius and a high threshold: nodes glow, the void stays dark.
    const bloom = new UnrealBloomPass(new Vector2(size.width || 1, size.height || 1), 0.7, 0.25, 0.4);
    // Bloom renders in linear space; OutputPass converts back to sRGB so token colours stay true.
    const output = new OutputPass();
    composer.addPass(bloom);
    composer.addPass(output);
    // The renderer clear colour skips colour management inside the composer (the void came
    // out grey), so the background is drawn as the scene background instead.
    const scene = fg.scene();
    scene.background = new Color(rgba(palette.background));
    return () => {
      scene.background = null;
      composer.removePass(output);
      composer.removePass(bloom);
      output.dispose();
      bloom.dispose();
    };
  }, [palette, ready]);

  // Frame the graph (or the focused cluster) once new data lands and again once the
  // layout has pulled together. Tighter than the library's zoomToFit, which frames the
  // longest side of the 3D box and leaves a wide canvas mostly empty. Horizontal room
  // uses the larger of x and z, since the auto-rotate swings one into the other.
  const focusRef = useRef(focusIds);
  focusRef.current = focusIds;
  const fitCamera = useCallback((transitionMs = 800) => {
    const fg = graphRef.current;
    const focus = focusRef.current;
    // A focused cluster is framed with the main agent's hub, so it keeps its bearings.
    const box = fg?.getGraphBbox(focus ? (node: GraphNode) => node.ceo || focus.has(String(node.id)) : undefined) ?? fg?.getGraphBbox();
    if (!fg || !box) return;
    const camera = fg.camera() as PerspectiveCamera;
    const centre = { x: (box.x[0] + box.x[1]) / 2, y: (box.y[0] + box.y[1]) / 2, z: (box.z[0] + box.z[1]) / 2 };
    const halfHeight = (box.y[1] - box.y[0]) / 2;
    const halfWidth = Math.max(box.x[1] - box.x[0], box.z[1] - box.z[0]) / 2;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    // A little room at the edges, plus some depth so nodes nearer the camera stay in frame.
    // A focused cluster gets more room: the slow spin swings its far side towards the edge.
    const margin = focus ? 1.35 : 1.05;
    const distance = Math.max(halfHeight / tan, halfWidth / (tan * camera.aspect)) * margin + halfWidth * 0.4;
    fg.cameraPosition({ x: centre.x, y: centre.y, z: centre.z + Math.max(distance, MIN_CAMERA_DISTANCE) }, centre, reducedMotion ? 0 : transitionMs);
  }, [reducedMotion]);
  const ticks = useRef(0);
  useEffect(() => {
    ticks.current = 0;
    if (!ready || !forcesReady) return;
    // First framing as soon as the nodes are placed; the tick based refits below follow the
    // layout as it settles.
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      // The renderer takes the data on its next update and only then spreads the nodes, so
      // wait until the box is wider than a single hub.
      const box = graphRef.current?.getGraphBbox();
      if (box && box.x[1] - box.x[0] > 60) {
        fitCamera(0);
        return;
      }
      if (++tries < 25) timer = window.setTimeout(attempt, 200);
    };
    timer = window.setTimeout(attempt, 300);
    return () => window.clearTimeout(timer);
    // `data`, not `graphData`: suggested links joining after the first settle is not new data.
  }, [data, ready, forcesReady, fitCamera]);
  const onEngineTick = useCallback(() => {
    ticks.current += 1;
    if (!settled && ticks.current === MOTION.FIT_TICKS[1]) setSettled(true);
    if (ticks.current === MOTION.FIT_TICKS[0] || ticks.current === MOTION.FIT_TICKS[1]) fitCamera();
  }, [fitCamera, settled]);

  // Ease to the focused cluster (or back to the whole graph) when the focus changes.
  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    if (!ready) return;
    pauseRotation();
    fitCamera(MOTION.FOCUS_MS);
  }, [focusIds, ready, fitCamera, pauseRotation]);

  // Stop rendering while scrolled out of view.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const fg = graphRef.current;
      if (!fg) return;
      if (entry?.isIntersecting) fg.resumeAnimation();
      else fg.pauseAnimation();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [boxRef]);

  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

  return (
    <div ref={boxRef} className={className} onPointerDown={pauseRotation} onWheel={pauseRotation}>
      {ready ? (
        <ForceGraph3D<MemoryGraph3DNode, MemoryGraph3DLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={forcesReady ? graphData : EMPTY_GRAPH}
          controlType="orbit"
          backgroundColor={rgba(palette.background)}
          showNavInfo={false}
          nodeRelSize={NODE_REL_SIZE}
          nodeVal="val"
          nodeResolution={16}
          nodeOpacity={0.95}
          nodeColor={nodeColor}
          nodeVisibility={isVisible}
          nodeLabel={nodeLabel}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend
          linkColor={linkColor}
          linkVisibility={linkVisible}
          linkMaterial={linkMaterial}
          linkPositionUpdate={linkPositionUpdate}
          linkLabel={linkLabel}
          linkOpacity={1}
          linkWidth={(link: GraphLink) => (link.style === "stated" && link.edgeId === selectedEdgeId ? 1.2 : 0)}
          linkDirectionalArrowLength={(link: GraphLink) => (link.style === "stated" ? 3.5 : 0)}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={linkColor}
          linkHoverPrecision={2}
          onNodeClick={onNodeClick}
          onNodeHover={onNodeHover}
          onNodeDragEnd={pauseRotation}
          onLinkClick={onLinkClick}
          onEngineTick={onEngineTick}
          enableNodeDrag
          warmupTicks={reducedMotion ? 200 : 100}
          cooldownTicks={Infinity}
          cooldownTime={reducedMotion ? 6000 : Infinity}
          d3AlphaMin={reducedMotion ? 0.001 : 0}
          d3AlphaDecay={MOTION.ALPHA_DECAY}
          d3VelocityDecay={MOTION.VELOCITY_DECAY}
        />
      ) : null}
    </div>
  );
}
