import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Eraser, Hash, Highlighter, MoveUpRight, Pencil, Square, Type, Undo2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  MARKUP_COLORS,
  MARKUP_INK,
  arrowHead,
  boxFrom,
  canAddMark,
  cleanMarkupLabel,
  isTinyShape,
  markupHex,
  markupMetrics,
  nextMarkerNumber,
  type MarkupColor,
  type MarkupPoint,
  type MarkupShape,
  type MarkupTool,
} from "../../lib/website-markup";

// Draw on the page (GRE-2518). The editor's screenshot of the page at the
// current width, with a drawing layer on top. A mouse, a pen or a finger
// draws: pointer events, and no page scroll while a finger is on the drawing.

const TOOLS: { value: MarkupTool; label: string; icon: LucideIcon }[] = [
  { value: "pen", label: "Pen", icon: Pencil },
  { value: "arrow", label: "Arrow", icon: MoveUpRight },
  { value: "box", label: "Box", icon: Square },
  { value: "highlight", label: "Highlight", icon: Highlighter },
  { value: "text", label: "Text label", icon: Type },
  { value: "marker", label: "Numbered marker", icon: Hash },
];

/** One mark as SVG, drawn the way `drawMarkupShapes` draws it in the PNG. */
function ShapeSvg({ shape, imageWidth }: { shape: MarkupShape; imageWidth: number }) {
  const m = markupMetrics(imageWidth);
  const hex = markupHex(shape.color);
  const line = (points: readonly MarkupPoint[]) => points.map(([x, y]) => `${x},${y}`).join(" ");
  const edged = (points: readonly MarkupPoint[][]) => (
    <>
      {points.map((p, index) => <polyline key={`e${index}`} points={line(p)} fill="none" stroke={MARKUP_INK} strokeWidth={m.stroke + m.edge * 2} />)}
      {points.map((p, index) => <polyline key={`c${index}`} points={line(p)} fill="none" stroke={hex} strokeWidth={m.stroke} />)}
    </>
  );
  switch (shape.kind) {
    case "pen":
      return <g data-mark="pen">{edged([shape.points])}</g>;
    case "highlight":
      return (
        <g data-mark="highlight">
          <polyline points={line(shape.points)} fill="none" stroke={hex} strokeOpacity={0.4} strokeWidth={m.highlight} />
        </g>
      );
    case "arrow": {
      const [left, right] = arrowHead(shape.from, shape.to, m.stroke * 5);
      return <g data-mark="arrow">{edged([[shape.from, shape.to], [left, shape.to, right]])}</g>;
    }
    case "box": {
      const { x, y, w, h } = shape;
      return <g data-mark="box">{edged([[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]])}</g>;
    }
    case "marker":
      return (
        <g data-mark="marker">
          <circle cx={shape.x} cy={shape.y} r={m.marker} fill={hex} stroke={MARKUP_INK} strokeWidth={m.edge} />
          <text x={shape.x} y={shape.y} fill={MARKUP_INK} fontSize={m.font} fontWeight={700} textAnchor="middle" dominantBaseline="central">
            {shape.n}
          </text>
        </g>
      );
    case "text": {
      // SVG cannot measure before drawing; an estimate close to the PNG's measured box.
      const width = shape.text.length * m.font * 0.56 + m.pad * 2;
      return (
        <g data-mark="text">
          <rect x={shape.x} y={shape.y - m.font / 2 - m.pad} width={width} height={m.font + m.pad * 2} fill={MARKUP_INK} />
          <text x={shape.x + m.pad} y={shape.y} fill={hex} fontSize={m.font} fontWeight={600} dominantBaseline="central">
            {shape.text}
          </text>
        </g>
      );
    }
  }
}

export function WebsiteMarkupLayer({
  screenshotUrl,
  size,
  displayWidth,
  shapes,
  onChange,
  onDone,
}: {
  /** The editor's PNG of the page or block, as a data URL. */
  screenshotUrl: string;
  /** The PNG's size in pixels. */
  size: { width: number; height: number };
  /** The width the page shows at in the editor, in CSS pixels; null fills the canvas. */
  displayWidth: number | null;
  shapes: MarkupShape[];
  onChange: (shapes: MarkupShape[]) => void;
  /** Hides the layer; the drawing stays with the comment. */
  onDone: () => void;
}) {
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [color, setColor] = useState<MarkupColor>("red");
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const [label, setLabel] = useState<{ at: MarkupPoint; value: string } | null>(null);
  const start = useRef<MarkupPoint | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const full = !canAddMark(shapes);

  const point = (event: ReactPointerEvent): MarkupPoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * size.width : 0;
    const y = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * size.height : 0;
    return [Math.min(Math.max(x, 0), size.width), Math.min(Math.max(y, 0), size.height)];
  };

  const add = (shape: MarkupShape) => {
    if (canAddMark(shapes)) onChange([...shapes, shape]);
  };

  const commitLabel = () => {
    if (!label) return;
    const text = cleanMarkupLabel(label.value);
    if (text) add({ kind: "text", color, x: label.at[0], y: label.at[1], text });
    setLabel(null);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || full) return;
    event.preventDefault();
    const at = point(event);
    if (tool === "marker") return add({ kind: "marker", color, x: at[0], y: at[1], n: nextMarkerNumber(shapes) });
    if (tool === "text") {
      commitLabel();
      return setLabel({ at, value: "" });
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = at;
    if (tool === "pen" || tool === "highlight") setDraft({ kind: tool, color, points: [at] });
    else if (tool === "arrow") setDraft({ kind: "arrow", color, from: at, to: at });
    else setDraft({ kind: "box", color, ...boxFrom(at, at) });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft || !start.current) return;
    const at = point(event);
    if (draft.kind === "pen" || draft.kind === "highlight") setDraft({ ...draft, points: [...draft.points, at] });
    else if (draft.kind === "arrow") setDraft({ ...draft, to: at });
    else if (draft.kind === "box") setDraft({ ...draft, ...boxFrom(start.current, at) });
  };

  const onPointerUp = () => {
    if (draft && !isTinyShape(draft, size.width)) add(draft);
    setDraft(null);
    start.current = null;
  };

  return (
    // On a phone the editor's drawer is a bottom sheet; the drawing goes over it until Done (GRE-2759).
    <div className="absolute inset-0 z-sticky flex flex-col bg-muted sm:z-raised" data-testid="website-markup-layer">
      <div
        role="toolbar"
        aria-label="Drawing tools"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-2 py-1.5"
      >
        {TOOLS.map((entry) => (
          <Button
            key={entry.value}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={entry.label}
            title={entry.label}
            aria-pressed={tool === entry.value}
            className={cn(tool === entry.value && "bg-accent text-foreground ring-1 ring-inset ring-border")}
            onClick={() => {
              commitLabel();
              setTool(entry.value);
            }}
          >
            <entry.icon />
          </Button>
        ))}
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        {MARKUP_COLORS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-label={entry.label}
            title={entry.label}
            aria-pressed={color === entry.value}
            onClick={() => setColor(entry.value)}
            className={cn(
              "flex size-9 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              color === entry.value && "bg-accent ring-1 ring-inset ring-border",
            )}
          >
            <span className="size-5 rounded-full border border-foreground/40" style={{ backgroundColor: entry.hex }} />
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-border" aria-hidden />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Undo" title="Undo" disabled={shapes.length === 0} onClick={() => onChange(shapes.slice(0, -1))}>
          <Undo2 />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear" title="Clear the drawing" disabled={shapes.length === 0} onClick={() => onChange([])}>
          <Eraser />
        </Button>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => {
            commitLabel();
            onDone();
          }}
        >
          <Check />
          Done
        </Button>
        {full ? (
          <p className="basis-full text-xs text-status-warning-foreground" role="status">
            That is the most marks one drawing keeps. Undo one to draw more.
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="relative mx-auto shadow-sm" style={{ width: displayWidth ? `min(100%, ${displayWidth}px)` : "100%" }}>
          <img src={screenshotUrl} alt="The page as you see it" className="block h-auto w-full select-none" draggable={false} />
          <svg
            ref={svgRef}
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="none"
            className={cn("absolute inset-0 size-full touch-none", tool === "text" ? "cursor-text" : "cursor-crosshair")}
            aria-label="Drawing"
            role="img"
            data-testid="website-markup-canvas"
            strokeLinecap="round"
            strokeLinejoin="round"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {shapes.map((shape, index) => <ShapeSvg key={index} shape={shape} imageWidth={size.width} />)}
            {draft ? <ShapeSvg shape={draft} imageWidth={size.width} /> : null}
          </svg>
          {label ? (
            <input
              autoFocus
              aria-label="Label text"
              placeholder="Type a label"
              value={label.value}
              maxLength={120}
              onChange={(event) => setLabel({ ...label, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLabel();
                } else if (event.key === "Escape") {
                  // Esc drops this label only; the editor must not close the drawer.
                  event.preventDefault();
                  event.stopPropagation();
                  setLabel(null);
                }
              }}
              onBlur={commitLabel}
              className="absolute z-raised w-48 rounded border border-border bg-background px-2 py-1 text-sm shadow-sm"
              style={{ left: `${(label.at[0] / size.width) * 100}%`, top: `${(label.at[1] / size.height) * 100}%` }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
