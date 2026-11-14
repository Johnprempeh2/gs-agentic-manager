import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STEP = 16;

// Collapsed icon rail. The glass panel floats inside an 8px inset on the left
// and top/bottom and a 4px one on the right, and has a 1px edge. Inside the
// glass the icon's left edge sits at nav px-3 (12) + item mx-2 (8) + px-2 (8)
// = 28px, so a 72px content box centres the 16px icon (28 + 16 + 28) on one
// vertical axis, 36px in, with the highlight pill symmetric around it:
// 8 + 1 + 72 + 1 + 4 = 86. Icons stay pixel-identical across states.
export const SIDEBAR_RAIL_WIDTH = 86;
/** Where every rail icon, the logo stone and the avatar centre, from the glass's content edge. */
export const SIDEBAR_RAIL_AXIS = 36;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth(storageKey: string) {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(parsed);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function writeStoredSidebarWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, String(clampSidebarWidth(width)));
  } catch {
    // Storage can be unavailable in private contexts; resizing should still work.
  }
}

type SidebarShellProps = {
  children: ReactNode;
  /** Whether the sidebar occupies space at all (mobile back-compat / hidden). */
  open: boolean;
  /** Pinned collapsed (rail) mode. Desktop-only; the caller gates this. */
  collapsed?: boolean;
  /** Ephemeral hover/focus peek. Only meaningful while collapsed. */
  peeking?: boolean;
  resizable?: boolean;
  storageKey?: string;
  className?: string;
  /** Forwarded to the overlay panel so Layout can wire peek triggers. */
  onPanelMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onPanelMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onPanelFocusCapture?: FocusEventHandler<HTMLDivElement>;
  onPanelBlurCapture?: FocusEventHandler<HTMLDivElement>;
};

/**
 * Layout shell for the desktop sidebar. Owns the persisted expanded width and
 * renders two layers:
 *  - an in-flow spacer that reserves `reservedWidth` (rail when collapsed,
 *    expanded width otherwise) so content to the right only reflows on pin, and
 *  - an absolutely-positioned panel of `panelWidth` (rail at rest, expanded
 *    while peeking) that overlays content — with shadow/raised z-index — when it
 *    is wider than the reserved spacer.
 *
 * The icon-alignment guarantee comes for free: collapsing is a pure width
 * change with `overflow-hidden` clipping the labels; item padding/icon markup
 * are never touched, so the left-aligned icon stays pixel-identical.
 *
 * Expanding and collapsing ease the width (gs-sidebar-motion, about 220ms
 * ease-out): the spacer and the panel share one clock, so the page eases with
 * the sidebar on a pin, and a peek only grows the overlay. Nothing inside the
 * panel moves: icons are left-anchored and labels fade in after the width
 * starts (gs-side-reveal). Reduced motion is instant. Dragging the handle is
 * direct (no transition while resizing).
 */
export function SidebarShell({
  children,
  open,
  collapsed = false,
  peeking = false,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
  onPanelMouseEnter,
  onPanelMouseLeave,
  onPanelFocusCapture,
  onPanelBlurCapture,
}: SidebarShellProps) {
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth(storageKey);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey]);

  // Unified width function (plan §5): one code path for every pinned state.
  const expandedWidth = open ? width : 0;
  const reservedWidth = !open ? 0 : collapsed ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const panelWidth = !open ? 0 : collapsed && !peeking ? SIDEBAR_RAIL_WIDTH : expandedWidth;
  const isOverlay = panelWidth > reservedWidth;

  // The drag handle can only resize the expanded width, so it is disabled while
  // collapsed (the rail width is a fixed constant, not user-resizable).
  const canResize = resizable && open && !collapsed;

  const reservedStyle = useMemo(
    () => ({ width: `${reservedWidth}px` }),
    [reservedWidth],
  );
  const panelStyle = useMemo(
    () => ({ width: `${panelWidth}px` }),
    [panelWidth],
  );

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      writeStoredSidebarWidth(storageKey, clamped);
    },
    [storageKey],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canResize) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = { startX: event.clientX, startWidth: widthRef.current };
      setIsResizing(true);
    },
    [canResize],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;

      const nextWidth = dragState.current.startWidth + event.clientX - dragState.current.startX;
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [],
  );

  const endResize = useCallback(() => {
    if (!dragState.current) return;

    dragState.current = null;
    setIsResizing(false);
    writeStoredSidebarWidth(storageKey, widthRef.current);
  }, [storageKey]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!canResize) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(width - SIDEBAR_WIDTH_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(width + SIDEBAR_WIDTH_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitWidth(MIN_SIDEBAR_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        commitWidth(MAX_SIDEBAR_WIDTH);
      }
    },
    [canResize, commitWidth, width],
  );

  return (
    <div
      className={cn("relative h-full shrink-0", !isResizing && "gs-sidebar-motion", className)}
      style={reservedStyle}
      data-slot="sidebar-spacer"
    >
      <div
        className={cn(
          // The padding is the float inset around the liquid-glass panel.
          "absolute inset-y-0 left-0 flex flex-col py-2 pl-2 pr-1",
          !isResizing && "gs-sidebar-motion",
          // Overlay styling only while the panel is wider than its reserved
          // spacer (i.e. peeking) so it floats above content without reflow.
          isOverlay ? "z-chrome" : "z-page",
        )}
        style={panelStyle}
        data-sidebar-overlay={isOverlay ? "" : undefined}
        onMouseEnter={onPanelMouseEnter}
        onMouseLeave={onPanelMouseLeave}
        onFocusCapture={onPanelFocusCapture}
        onBlurCapture={onPanelBlurCapture}
      >
        <div className="gs-sidebar-glass" data-slot="sidebar-glass">{children}</div>
      </div>
      {canResize ? (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-dragging={isResizing ? "" : undefined}
          className="group absolute inset-y-0 z-sticky cursor-col-resize touch-none outline-none"
          style={{ right: -4, width: 8 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onKeyDown={handleKeyDown}
        >
          <div
            className={cn(
              "mx-auto h-full w-0.5 transition-colors",
              isResizing
                ? "bg-ring"
                : "bg-transparent group-hover:bg-ring group-focus-visible:bg-ring",
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
