import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown, Maximize, Maximize2, Minimize2, Minus, Plus, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsPhone } from "@/hooks/useIsPhone";
import { cn } from "@/lib/utils";
import type { DiagramRect, DiagramViewport } from "./useDiagramViewport";

export type DiagramFullscreenMode = "native" | "overlay" | null;

/** How long to wait for the browser to grant full screen before using the overlay. */
const FULLSCREEN_WAIT_MS = 1_000;

/**
 * Full screen for one element: the browser Fullscreen API where it works,
 * a fixed full-viewport overlay on phones and where it does not.
 */
export function useDiagramFullscreen(targetRef: React.RefObject<HTMLElement | null>, options: { onExit?: () => void } = {}) {
  const isPhone = useIsPhone();
  const [mode, setMode] = useState<DiagramFullscreenMode>(null);
  const onExitRef = useRef(options.onExit);
  onExitRef.current = options.onExit;

  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement) {
        if (document.fullscreenElement === targetRef.current) setMode("native");
        return;
      }
      setMode((current) => {
        if (current === "native") onExitRef.current?.();
        return current === "native" ? null : current;
      });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [targetRef]);

  const enter = useCallback(async () => {
    const el = targetRef.current;
    if (!el) return;
    if (!isPhone && typeof el.requestFullscreen === "function") {
      // Refused, or left hanging by an embedding host: the overlay does the same job.
      const granted = await Promise.race([
        el.requestFullscreen().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), FULLSCREEN_WAIT_MS)),
      ]);
      if (granted || document.fullscreenElement === el) {
        setMode("native");
        return;
      }
    }
    setMode("overlay");
  }, [isPhone, targetRef]);

  const exit = useCallback(() => {
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") void document.exitFullscreen();
    setMode(null);
    onExitRef.current?.();
  }, []);

  return { mode, active: mode !== null, enter, exit, toggle: () => (mode ? exit() : void enter()) };
}

export interface DiagramFindItem {
  id: string;
  label: string;
  detail?: string;
}

const MAX_MATCHES = 8;

/** The nodes a find query matches, by name or detail (a task's key or project), first few only. */
export function matchFindItems(items: DiagramFindItem[], query: string, limit = MAX_MATCHES): DiagramFindItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return items.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)).slice(0, limit);
}

/** Find a node by name: type, pick a match (Enter takes the first) and the diagram jumps to it. */
export function DiagramFind({ items, onPick }: { items: DiagramFindItem[]; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(() => matchFindItems(items, query), [items, query]);

  const pick = (item: DiagramFindItem | undefined) => {
    if (!item) return;
    onPick(item.id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys typed here never zoom or move the diagram.
    event.stopPropagation();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(matches[active] ?? matches[0]);
    } else if (event.key === "Escape" && (open || query)) {
      event.preventDefault();
      if (open && matches.length) setOpen(false);
      else setQuery("");
    }
  };

  const expanded = open && query.trim().length > 0;
  return (
    <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        role="combobox"
        aria-label="Find in the diagram"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && matches[active] ? `${listId}-${active}` : undefined}
        placeholder="Find by name"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-diagram-find=""
      />
      {expanded ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matches"
          className="absolute left-0 top-full z-popover mt-1 max-h-72 w-full min-w-56 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-sm"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Nothing by that name</li>
          ) : (
            matches.map((item, index) => (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                // Keep focus in the input so the pick lands before blur closes the list.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(item)}
                className={cn("cursor-pointer rounded-sm px-2 py-1.5 text-xs", index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")}
              >
                <span className="block truncate font-medium">{item.label}</span>
                {item.detail ? <span className="block truncate text-muted-foreground">{item.detail}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

const MINIMAP_WIDTH = 160;

/** The whole diagram in miniature with the part in view outlined; click or drag to move there. */
const DiagramMinimap = memo(function DiagramMinimap({
  boxes,
  content,
  view,
  size,
  onCenter,
}: {
  boxes: DiagramRect[];
  content: { width: number; height: number };
  view: { x: number; y: number; k: number };
  size: { width: number; height: number };
  onCenter: (point: { x: number; y: number }) => void;
}) {
  const scale = MINIMAP_WIDTH / Math.max(content.width, 1);
  const height = Math.min(120, Math.max(32, content.height * scale));
  const s = Math.min(scale, height / Math.max(content.height, 1));
  const rects = useMemo(
    () => boxes.map((box, index) => <rect key={index} x={box.x * s} y={box.y * s} width={Math.max(1.5, box.width * s)} height={Math.max(1.5, box.height * s)} rx={1} className="fill-border" />),
    [boxes, s],
  );
  // The part of the diagram in view, clipped to the diagram.
  const inView = {
    x0: Math.max(0, -view.x / view.k),
    y0: Math.max(0, -view.y / view.k),
    x1: Math.min(content.width, (size.width - view.x) / view.k),
    y1: Math.min(content.height, (size.height - view.y) / view.k),
  };
  const drag = useRef(false);
  const move =(event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onCenter({ x: (event.clientX - rect.left) / s, y: (event.clientY - rect.top) / s });
  };
  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-3 z-raised hidden rounded-md border border-border bg-card p-1 shadow-sm sm:block"
      data-diagram-minimap=""
      onPointerDown={(event) => event.stopPropagation()}
    >
      <svg
        width={content.width * s}
        height={content.height * s}
        role="img"
        aria-label="Overview of the whole diagram. Click to move there."
        className="block cursor-pointer touch-none"
        onPointerDown={(event) => {
          drag.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          move(event);
        }}
        onPointerMove={(event) => drag.current && move(event)}
        onPointerUp={() => (drag.current = false)}
        onPointerCancel={() => (drag.current = false)}
      >
        {rects}
        <rect
          x={inView.x0 * s + 0.75}
          y={inView.y0 * s + 0.75}
          width={Math.max(0, (inView.x1 - inView.x0) * s - 1.5)}
          height={Math.max(0, (inView.y1 - inView.y0) * s - 1.5)}
          rx={2}
          className="fill-none stroke-ring"
          strokeWidth={1.5}
          data-minimap-view=""
        />
      </svg>
    </div>
  );
});

/** Tab and Shift+Tab stay inside the element while it is full screen. */
export function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface DiagramFrameProps {
  /** Names the diagram for the toolbar and full screen ("Task tree", "Sitemap board"). */
  label: string;
  viewport: DiagramViewport;
  content: { width: number; height: number };
  /** Boxes for the minimap, in diagram space. */
  boxes: DiagramRect[];
  find?: { items: DiagramFindItem[]; onPick: (id: string) => void };
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
  /** Extra controls at the start of the toolbar. */
  toolbarStart?: ReactNode;
  /** Open straight into full screen (a phone opening the diagram from its outline). */
  startFullscreen?: boolean;
  onExitFullscreen?: () => void;
  className?: string;
  /** The pannable canvas itself. */
  children: ReactNode;
}

/**
 * The frame every diagram shares: a toolbar 16px above the canvas (find,
 * fold, zoom, fit, reset, full screen), the minimap when the diagram is
 * bigger than the view, and the keys +, - and 0. In full screen the toolbar
 * comes along and focus stays inside.
 */
export function DiagramFrame({
  label,
  viewport,
  content,
  boxes,
  find,
  onCollapseAll,
  onExpandAll,
  toolbarStart,
  startFullscreen,
  onExitFullscreen,
  className,
  children,
}: DiagramFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const fullscreen = useDiagramFullscreen(frameRef, { onExit: onExitFullscreen });
  const { view, size, zoomIn, zoomOut, fit, reset, centerOn } = viewport;

  const started = useRef(false);
  useEffect(() => {
    if (!startFullscreen || started.current) return;
    started.current = true;
    void fullscreen.enter();
  }, [startFullscreen, fullscreen]);

  // A resize (full screen, a phone turned, a view remembered from a wider
  // screen) must never leave an empty canvas: if no node is in view, go home.
  const viewNow = useRef(view);
  viewNow.current = view;
  useEffect(() => {
    if (size.width === 0 || size.height === 0 || boxes.length === 0) return;
    const { x, y, k } = viewNow.current;
    const anyInView = boxes.some(
      (box) => box.x * k + x < size.width && box.y * k + y < size.height && (box.x + box.width) * k + x > 0 && (box.y + box.height) * k + y > 0,
    );
    if (!anyInView) reset();
    // Only on a size change: panning away on purpose is allowed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fullscreen.active) trapTab(event, frameRef.current);
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomIn();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomOut();
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    } else if (event.key === "Escape" && fullscreen.mode === "overlay") {
      event.preventDefault();
      fullscreen.exit();
    }
  };

  // The minimap shows whenever part of the diagram is out of view.
  const larger =
    view.x < -1 || view.y < -1 || view.x + content.width * view.k > size.width + 1 || view.y + content.height * view.k > size.height + 1;

  return (
    <div
      ref={frameRef}
      role="group"
      aria-label={label}
      data-diagram-frame=""
      data-fullscreen={fullscreen.mode ?? undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-0 w-full flex-col gap-4",
        className,
        fullscreen.active && "h-full min-h-0 bg-background p-4",
        fullscreen.mode === "overlay" && "fixed inset-0 z-dialog",
      )}
    >
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={`${label} controls`} data-diagram-toolbar="">
        {toolbarStart}
        {find ? <DiagramFind items={find.items} onPick={find.onPick} /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {onCollapseAll ? (
            <Button type="button" variant="ghost" size="xs" onClick={onCollapseAll} title="Fold every branch">
              <ChevronsDownUp aria-hidden="true" />
              Collapse all
            </Button>
          ) : null}
          {onExpandAll ? (
            <Button type="button" variant="ghost" size="xs" onClick={onExpandAll} title="Unfold every branch">
              <ChevronsUpDown aria-hidden="true" />
              Expand all
            </Button>
          ) : null}
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom out" title="Zoom out (-)" onClick={zoomOut}>
              <Minus />
            </Button>
            <span className="w-10 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite" data-diagram-zoom="">
              {Math.round(view.k * 100)}%
            </span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Zoom in" title="Zoom in (+)" onClick={zoomIn}>
              <Plus />
            </Button>
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={fit} title="Fit the whole diagram (0)">
            <Maximize aria-hidden="true" />
            Fit to screen
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={reset} title="Back to where the diagram opens">
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
          <Button type="button" variant={fullscreen.active ? "outline" : "ghost"} size="xs" onClick={fullscreen.toggle} data-diagram-fullscreen-toggle="">
            {fullscreen.active ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            {fullscreen.active ? "Exit full screen" : "Full screen"}
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {larger && boxes.length > 0 ? <DiagramMinimap boxes={boxes} content={content} view={view} size={size} onCenter={centerOn} /> : null}
      </div>
    </div>
  );
}
