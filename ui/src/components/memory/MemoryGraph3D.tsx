import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-3d";
import { BufferAttribute, CanvasTexture, Color, Line, LineDashedMaterial, SRGBColorSpace, Sprite, SpriteMaterial, Vector2, type Object3D, type PerspectiveCamera } from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { neighbourhood, type MemoryGraph3DData, type MemoryGraph3DLink, type MemoryGraph3DNode } from "./memoryGraph3dData";
import { readMemoryGraphPalette, rgba, type MemoryGraphPalette, type Rgb } from "./memoryGraphPalette";
import { basisLines, EDGE_KIND_LABEL, edgeTypeLabel, memoryStatusMeta } from "./memoryLabels";

/**
 * The 3D Memory graph (three.js via react-force-graph-3d). Loaded with React.lazy
 * from the Memory page so three.js stays out of the main bundle. It only draws what
 * the page hands it; it never adds records or relationships.
 */

type GraphNode = NodeObject<MemoryGraph3DNode>;
type GraphLink = LinkObject<MemoryGraph3DNode, MemoryGraph3DLink>;

const NODE_REL_SIZE = 4;
const LABEL_MAX = 48;
const DOUBLE_CLICK_MS = 320;
const ROTATE_RESUME_MS = 6000;
const FOCUS_DISTANCE = 90;
const DIMMED = 0.12;
/** Sprite scale without size attenuation (about 17px on a 470px tall canvas at the default field of view). */
const HUB_LABEL_SCREEN_HEIGHT = 0.026;
/**
 * Motion tuning, kept in one place. The graph used to bounce about too much, so these
 * favour a calm scene: heavy damping, a quick settle, a faint slow drift and a slow spin.
 * Previous values are noted alongside each one.
 *
 * - VELOCITY_DECAY: share of speed lost each tick (d3 default 0.4). Higher is calmer.
 *   Dragging stays direct because the dragged node is pinned to the pointer.
 * - ALPHA_DECAY: how fast the layout cools. At 0.045 alpha drops to 0.001 in about
 *   150 ticks, against about 275 before. The first 100 run off screen as warmup, so the
 *   visible settle is now about 50 ticks (under a second at 60fps) instead of about 175.
 * - DRIFT_STRENGTH / DRIFT_SPEED: the settled "breathing" wobble. Per tick velocity nudge
 *   and phase step; with the heavier damping the sway is under a unit over
 *   roughly 25 seconds, instead of a few units every 10 seconds.
 * - AUTO_ROTATE_SPEED: OrbitControls units (2.0 is one turn a minute), so 0.15 is one
 *   turn in about 13 minutes.
 * - FIT_TICKS: visible engine ticks after new data at which the camera reframes (about
 *   0.4s, then about 1s, once the faster settle has finished).
 */
const MOTION = {
  VELOCITY_DECAY: 0.6, // was 0.35
  ALPHA_DECAY: 0.045, // was 0.025
  DRIFT_STRENGTH: 0.004, // was 0.02
  DRIFT_SPEED: 0.004, // was 0.01
  AUTO_ROTATE_SPEED: 0.15, // was 0.35
  FIT_TICKS: [25, 60] as const, // was [40, 180]
} as const;

export interface MemoryGraph3DProps {
  data: MemoryGraph3DData;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
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

/**
 * A flat text label that always faces the camera, drawn on a canvas in the app font.
 * Fixed on-screen size (no size attenuation) so hub names stay readable at any zoom,
 * anchored just above the node and drawn on top of everything.
 */
function textSprite(text: string, palette: MemoryGraphPalette, screenHeight: number): Sprite {
  const scale = 4;
  const fontPx = 14 * scale;
  const pad = 6 * scale;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `600 ${fontPx}px ${palette.fontFamily}`;
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

export default function MemoryGraph3D({ data, selectedNodeId, selectedEdgeId, onSelectNode, onSelectEdge, className }: MemoryGraph3DProps) {
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [boxRef, size] = useElementSize<HTMLDivElement>();
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const lastClick = useRef<{ id: string; at: number } | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);

  // The renderer mutates node and link objects (positions, link ends), so it gets
  // its own copy whenever the data changes and keeps it while only styling changes.
  const graphData = useMemo(
    () => ({ nodes: data.nodes.map((node) => ({ ...node })), links: data.links.map((link) => ({ ...link })) }),
    [data],
  );

  const selectedEdge = useMemo(() => data.links.find((link) => link.edgeId && link.edgeId === selectedEdgeId), [data, selectedEdgeId]);
  const highlight = useMemo(() => {
    if (hoverId) return neighbourhood(data.adjacency, [hoverId]);
    if (selectedNodeId) return neighbourhood(data.adjacency, [selectedNodeId]);
    if (selectedEdge) return new Set([selectedEdge.source, selectedEdge.target]);
    return null;
  }, [data, hoverId, selectedNodeId, selectedEdge]);
  const focusId = hoverId ?? selectedNodeId;
  const ready = size.width > 0 && size.height > 0;

  const nodeColor = useCallback(
    (node: GraphNode) => {
      const base = node.kind === "hub" ? palette.hub : palette.status[node.status ?? "unreviewed"];
      const lit = !highlight || highlight.has(node.id);
      return rgba(base, lit ? (node.kind === "memory" && node.status === "superseded" ? 0.7 : 1) : DIMMED);
    },
    [palette, highlight],
  );

  const linkLit = useCallback(
    (link: GraphLink) => {
      if (!highlight) return true;
      const source = endId(link.source);
      const target = endId(link.target);
      if (selectedEdge && !hoverId && !selectedNodeId) return link.edgeId === selectedEdge.edgeId;
      return focusId !== null && (source === focusId || target === focusId);
    },
    [highlight, selectedEdge, hoverId, selectedNodeId, focusId],
  );

  const linkPaint = useCallback(
    (link: GraphLink): { rgb: Rgb; alpha: number } => {
      const lit = linkLit(link);
      if (link.style === "stated") return { rgb: palette.foreground, alpha: lit ? 0.9 : DIMMED * 0.8 };
      if (link.style === "inferred") return { rgb: palette.muted, alpha: lit ? 0.9 : DIMMED * 0.8 };
      return { rgb: palette.muted, alpha: highlight ? (lit ? 0.45 : 0.04) : 0.14 };
    },
    [palette, linkLit, highlight],
  );
  const linkColor = useCallback((link: GraphLink) => {
    const { rgb, alpha } = linkPaint(link);
    return rgba(rgb, alpha);
  }, [linkPaint]);

  // Dashed lines need their own material (and line distances, see linkPositionUpdate).
  const dashedMaterials = useRef(new Map<string, LineDashedMaterial>());
  const linkMaterial = useCallback(
    (link: GraphLink) => {
      if (link.style !== "inferred") return null;
      const { rgb, alpha } = linkPaint(link);
      const key = rgba(rgb, alpha);
      let material = dashedMaterials.current.get(key);
      if (!material) {
        material = new LineDashedMaterial({ color: new Color(rgba(rgb)), dashSize: 3, gapSize: 2.5, transparent: true, opacity: alpha, depthWrite: false });
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

  // Hub labels are always on; they are rebuilt only when the data or theme changes.
  const nodeThreeObject = useCallback(
    (node: GraphNode) => {
      if (node.kind !== "hub") return undefined as unknown as Object3D;
      return textSprite(clip(node.label), palette, HUB_LABEL_SCREEN_HEIGHT);
    },
    [palette],
  );

  const nodeLabel = useCallback((node: GraphNode) => {
    if (node.kind === "hub") return `<strong>${escapeHtml(node.label)}</strong><br/>${node.degree} ${node.degree === 1 ? "entry" : "entries"}`;
    const status = memoryStatusMeta[node.status ?? "unreviewed"].label;
    return `<strong>${escapeHtml(clip(node.label))}</strong><br/>${escapeHtml(status)}${node.degree ? `, ${node.degree} ${node.degree === 1 ? "link" : "links"}` : ""}`;
  }, []);

  const linkLabel = useCallback((link: GraphLink) => {
    if (link.style === "provenance" || !link.edgeType) return "";
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
      const ratio = 1 + FOCUS_DISTANCE / Math.max(Math.hypot(x, y, z), 1);
      fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, reducedMotion ? 0 : 1200);
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
    [focusCamera, onSelectNode, pauseRotation],
  );

  const onLinkClick = useCallback(
    (link: GraphLink) => {
      if (link.edgeId) onSelectEdge(link.edgeId);
    },
    [onSelectEdge],
  );

  const onNodeHover = useCallback(
    (node: GraphNode | null) => {
      hovering.current = node !== null;
      setHoverId(node ? String(node.id) : null);
      if (node) pauseRotation();
      if (boxRef.current) boxRef.current.style.cursor = node ? "pointer" : "";
    },
    [pauseRotation, boxRef],
  );

  // Forces, controls, bloom: set once the instance exists, and again when motion or theme changes.
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const linkForce = fg.d3Force("link") as unknown as { distance: (fn: (link: GraphLink) => number) => void } | undefined;
    linkForce?.distance((link) => (link.style === "provenance" ? 28 : 45));
    const charge = fg.d3Force("charge") as unknown as { strength: (value: number) => void } | undefined;
    charge?.strength(-45);
    fg.d3Force("gravity", gravityForce());
    fg.d3Force("drift", reducedMotion ? null : driftForce());

    const controls = fg.controls() as OrbitControls;
    controls.autoRotateSpeed = MOTION.AUTO_ROTATE_SPEED;
    controls.enableDamping = true;
    controls.autoRotate = !reducedMotion;
    const onStart = () => pauseRotation();
    controls.addEventListener("start", onStart);
    return () => controls.removeEventListener("start", onStart);
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

  // Frame the graph once new data lands and again once the layout has pulled together.
  // Tighter than the library's zoomToFit, which frames the longest side of the 3D box and
  // leaves a wide canvas mostly empty. Horizontal room uses the larger of x and z, since
  // the auto-rotate swings one into the other.
  const fitCamera = useCallback((transitionMs = 800) => {
    const fg = graphRef.current;
    const box = fg?.getGraphBbox();
    if (!fg || !box) return;
    const camera = fg.camera() as PerspectiveCamera;
    const centre = { x: (box.x[0] + box.x[1]) / 2, y: (box.y[0] + box.y[1]) / 2, z: (box.z[0] + box.z[1]) / 2 };
    const halfHeight = (box.y[1] - box.y[0]) / 2;
    const halfWidth = Math.max(box.x[1] - box.x[0], box.z[1] - box.z[0]) / 2;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max(halfHeight / tan, halfWidth / (tan * camera.aspect)) * 1.1 + halfWidth;
    fg.cameraPosition({ x: centre.x, y: centre.y, z: centre.z + Math.max(distance, 120) }, centre, reducedMotion ? 0 : transitionMs);
  }, [reducedMotion]);
  const ticks = useRef(0);
  useEffect(() => {
    ticks.current = 0;
    if (!ready) return;
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
  }, [graphData, ready, fitCamera]);
  const onEngineTick = useCallback(() => {
    ticks.current += 1;
    if (ticks.current === MOTION.FIT_TICKS[0] || ticks.current === MOTION.FIT_TICKS[1]) fitCamera();
  }, [fitCamera]);

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
          graphData={graphData}
          controlType="orbit"
          backgroundColor={rgba(palette.background)}
          showNavInfo={false}
          nodeRelSize={NODE_REL_SIZE}
          nodeVal="val"
          nodeResolution={12}
          nodeOpacity={0.95}
          nodeColor={nodeColor}
          nodeLabel={nodeLabel}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend
          linkColor={linkColor}
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
