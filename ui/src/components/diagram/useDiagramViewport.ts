import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

export interface DiagramView {
  x: number;
  y: number;
  k: number;
}
export type DiagramPoint = { x: number; y: number };
export type DiagramSize = { width: number; height: number };
export type DiagramRect = DiagramPoint & DiagramSize;

export const DIAGRAM_MIN_ZOOM = 0.1;
export const DIAGRAM_MAX_ZOOM = 2;
const FIT_MARGIN = 32;
const DRAG_THRESHOLD = 4;
const ZOOM_STEP = 1.2;

export const clampDiagramZoom = (k: number) => Math.min(DIAGRAM_MAX_ZOOM, Math.max(DIAGRAM_MIN_ZOOM, k));

/* ---- Remembered per diagram: zoom and place, and folded branches ---- */

export interface DiagramPrefs {
  view?: DiagramView;
  collapsed?: string[];
}

const PREFS_PREFIX = "gsam.diagram.";

export function readDiagramPrefs(key: string | undefined): DiagramPrefs {
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(PREFS_PREFIX + key);
    const parsed = raw ? (JSON.parse(raw) as DiagramPrefs) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDiagramPrefs(key: string | undefined, patch: DiagramPrefs) {
  if (!key) return;
  try {
    const next = { ...readDiagramPrefs(key), ...patch };
    window.localStorage.setItem(PREFS_PREFIX + key, JSON.stringify(next));
  } catch {
    // Private mode or full storage: the diagram still works, it just forgets.
  }
}

/** The view that fits the whole content in the viewport, centred. */
export function fitView(content: DiagramSize, viewport: DiagramSize, maxZoom = 1): DiagramView {
  const k = clampDiagramZoom(
    Math.min(maxZoom, (viewport.width - FIT_MARGIN * 2) / Math.max(content.width, 1), (viewport.height - FIT_MARGIN * 2) / Math.max(content.height, 1)),
  );
  return { k, x: (viewport.width - content.width * k) / 2, y: Math.max(FIT_MARGIN / 2, (viewport.height - content.height * k) / 2) };
}

/**
 * Pan and zoom for a diagram drawn on a transformed layer. Drag empty space
 * to pan; wheel or trackpad pans, Ctrl or Cmd with the wheel (and a trackpad
 * pinch) zooms; two fingers pinch on touch. The view is remembered under
 * `storageKey` when given.
 */
export function useDiagramViewport({
  content,
  storageKey,
  home,
}: {
  content: DiagramSize;
  storageKey?: string;
  /** Where the diagram opens and "Reset" returns to; defaults to fit. */
  home?: (viewport: DiagramSize) => DiagramView;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<DiagramView>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState<DiagramSize>({ width: 0, height: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const contentRef = useRef(content);
  contentRef.current = content;
  const homeRef = useRef(home);
  homeRef.current = home;

  const viewportSize = (): DiagramSize | null => {
    const el = viewportRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return null;
    return { width: el.clientWidth, height: el.clientHeight };
  };

  const fit = useCallback(() => {
    const vp = viewportSize();
    if (vp) setView(fitView(contentRef.current, vp));
  }, []);

  const reset = useCallback(() => {
    const vp = viewportSize();
    if (!vp) return;
    setView(homeRef.current ? homeRef.current(vp) : fitView(contentRef.current, vp));
  }, []);

  // Open where it was left, or at home.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current) return;
    const vp = viewportSize();
    if (!vp) return;
    placed.current = true;
    const stored = readDiagramPrefs(storageKey).view;
    if (stored && [stored.x, stored.y, stored.k].every(Number.isFinite)) setView({ ...stored, k: clampDiagramZoom(stored.k) });
    else reset();
  });

  useEffect(() => {
    if (!placed.current || !storageKey) return;
    const timer = window.setTimeout(() => writeDiagramPrefs(storageKey, { view }), 250);
    return () => window.clearTimeout(timer);
  }, [view, storageKey]);

  // Track the viewport size for the minimap and for full screen.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setSize((prev) => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoomAt = useCallback((factor: number, at?: DiagramPoint) => {
    const el = viewportRef.current;
    const current = viewRef.current;
    const k = clampDiagramZoom(current.k * factor);
    const px = at?.x ?? (el?.clientWidth ?? 0) / 2;
    const py = at?.y ?? (el?.clientHeight ?? 0) / 2;
    setView({ k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) });
  }, []);
  const zoomIn = useCallback(() => zoomAt(ZOOM_STEP), [zoomAt]);
  const zoomOut = useCallback(() => zoomAt(1 / ZOOM_STEP), [zoomAt]);

  /** Centre the view on a point in diagram space, at the current zoom. */
  const centerOn = useCallback((point: DiagramPoint) => {
    const vp = viewportSize();
    if (!vp) return;
    const { k } = viewRef.current;
    setView({ k, x: vp.width / 2 - point.x * k, y: vp.height / 2 - point.y * k });
  }, []);

  /** Bring a box into view; with `onlyIfHidden`, leave the view alone when it already shows. */
  const reveal = useCallback(
    (box: DiagramRect, onlyIfHidden = false) => {
      const vp = viewportSize();
      if (!vp) return;
      const { k, x, y } = viewRef.current;
      const left = box.x * k + x;
      const top = box.y * k + y;
      if (onlyIfHidden && left >= 0 && top >= 0 && left + box.width * k <= vp.width && top + box.height * k <= vp.height) return;
      centerOn({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    },
    [centerOn],
  );

  // Wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      const scale = event.deltaMode === 1 ? 16 : 1;
      const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale;
      const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale;
      setView((current) => ({ ...current, x: current.x - dx, y: current.y - dy }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ── Pointer: drag to pan, two fingers to pinch ──────────────────────────
  const pointers = useRef(new Map<number, DiagramPoint>());
  const gesture = useRef<{ start: DiagramPoint; view: DiagramView; moved: boolean; pinch?: { distance: number; mid: DiagramPoint } } | null>(null);
  /** True right after a drag, so the click that ends it does not open a node. */
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);

  const localPoint = (event: { clientX: number; clientY: number }): DiagramPoint => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    pointers.current.set(event.pointerId, localPoint(event));
    suppressClick.current = false;
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points as [DiagramPoint, DiagramPoint];
      gesture.current = {
        start: a,
        view: viewRef.current,
        moved: true,
        pinch: { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } },
      };
    } else {
      gesture.current = { start: localPoint(event), view: viewRef.current, moved: false };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, localPoint(event));
    const current = gesture.current;
    const points = [...pointers.current.values()];
    if (current.pinch && points.length >= 2) {
      const [a, b] = points as [DiagramPoint, DiagramPoint];
      const k = clampDiagramZoom(current.view.k * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(current.pinch.distance, 1)));
      const mid = current.pinch.mid;
      setView({ k, x: mid.x - (mid.x - current.view.x) * (k / current.view.k), y: mid.y - (mid.y - current.view.y) * (k / current.view.k) });
      return;
    }
    const point = pointers.current.get(event.pointerId)!;
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!current.moved) {
      current.moved = true;
      setPanning(true);
      // Capture only once it is a drag, so a plain click still reaches the node.
      viewportRef.current?.setPointerCapture?.(event.pointerId);
    }
    setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (gesture.current?.moved) suppressClick.current = true;
    if (pointers.current.size === 0) {
      gesture.current = null;
      setPanning(false);
    }
  };

  return {
    viewportRef,
    view,
    setView,
    size,
    fit,
    reset,
    zoomAt,
    zoomIn,
    zoomOut,
    centerOn,
    reveal,
    panning,
    suppressClick,
    panHandlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
  };
}

export type DiagramViewport = ReturnType<typeof useDiagramViewport>;
