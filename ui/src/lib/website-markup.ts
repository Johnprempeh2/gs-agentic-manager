import {
  WEBSITE_MARKUP_MAX_LABEL,
  WEBSITE_MARKUP_MAX_MARKS,
  type CreateWebsiteChangeRequest,
  type WebsiteCommentWidth,
} from "@greatstone/shared";

// Draw on the page (GRE-2518). The person marks up the editor's screenshot
// before asking an agent. Every point is in the screenshot's own pixels, so
// the vector JSON, the SVG on screen and the PNG the agent gets line up.

export const MARKUP_TOOLS = ["pen", "arrow", "box", "highlight", "text", "marker"] as const;
export type MarkupTool = (typeof MARKUP_TOOLS)[number];

/** Three brand colours. Each mark gets an ink edge, so it reads on a light or a dark page. */
export const MARKUP_COLORS = [
  { value: "red", label: "Red", hex: "#ff6b6b" },
  { value: "lime", label: "Lime", hex: "#c8ff00" },
  { value: "teal", label: "Teal", hex: "#4ecdc4" },
] as const;
export type MarkupColor = (typeof MARKUP_COLORS)[number]["value"];
/** Brand ink: the edge on every mark and the text on a lime, red or teal fill. */
export const MARKUP_INK = "#0e1611";

export type MarkupPoint = [number, number];

export type MarkupShape =
  | { kind: "pen" | "highlight"; color: MarkupColor; points: MarkupPoint[] }
  | { kind: "arrow"; color: MarkupColor; from: MarkupPoint; to: MarkupPoint }
  | { kind: "box"; color: MarkupColor; x: number; y: number; w: number; h: number }
  | { kind: "text"; color: MarkupColor; x: number; y: number; text: string }
  | { kind: "marker"; color: MarkupColor; x: number; y: number; n: number };

/** The drawing as attached to the task (`website-*-markup.json`). */
export interface WebsiteMarkupDocument {
  version: 1;
  /** The screenshot's size in pixels; every coordinate is in this space. */
  width: number;
  height: number;
  device: WebsiteCommentWidth;
  shapes: MarkupShape[];
}

export function markupHex(color: MarkupColor) {
  return MARKUP_COLORS.find((entry) => entry.value === color)!.hex;
}

/** Line widths and sizes for a screenshot this wide: the same on screen and in the PNG. */
export function markupMetrics(imageWidth: number) {
  const unit = Math.max(1, imageWidth / 480);
  return {
    stroke: 3 * unit,
    edge: 1.5 * unit,
    highlight: 16 * unit,
    marker: 13 * unit,
    font: 15 * unit,
    pad: 5 * unit,
  };
}

/** The next numbered marker: one more than the highest placed. */
export function nextMarkerNumber(shapes: readonly MarkupShape[]) {
  return shapes.reduce((most, shape) => (shape.kind === "marker" ? Math.max(most, shape.n) : most), 0) + 1;
}

/** Room for one more mark. */
export function canAddMark(shapes: readonly MarkupShape[]) {
  return shapes.length < WEBSITE_MARKUP_MAX_MARKS;
}

/** A text label as kept: one line, trimmed, at most 120 characters. Empty means no label. */
export function cleanMarkupLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, WEBSITE_MARKUP_MAX_LABEL);
}

/** A stroke or box too small to mean anything, like a tap with the pen. */
export function isTinyShape(shape: MarkupShape, imageWidth: number) {
  const min = Math.max(2, imageWidth / 300);
  switch (shape.kind) {
    case "pen":
    case "highlight": {
      const xs = shape.points.map(([x]) => x);
      const ys = shape.points.map(([, y]) => y);
      return Math.max(...xs) - Math.min(...xs) < min && Math.max(...ys) - Math.min(...ys) < min;
    }
    case "arrow":
      return Math.hypot(shape.to[0] - shape.from[0], shape.to[1] - shape.from[1]) < min * 2;
    case "box":
      return Math.abs(shape.w) < min || Math.abs(shape.h) < min;
    default:
      return false;
  }
}

/** A box from two corners, any direction. */
export function boxFrom(from: MarkupPoint, to: MarkupPoint) {
  return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), w: Math.abs(to[0] - from[0]), h: Math.abs(to[1] - from[1]) };
}

/** The two short lines of an arrow head at `to`. */
export function arrowHead(from: MarkupPoint, to: MarkupPoint, size: number): [MarkupPoint, MarkupPoint] {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const spread = Math.PI / 7;
  return [
    [to[0] - size * Math.cos(angle - spread), to[1] - size * Math.sin(angle - spread)],
    [to[0] - size * Math.cos(angle + spread), to[1] - size * Math.sin(angle + spread)],
  ];
}

/** What the task says about the drawing; undefined when nothing is drawn. */
export function markupSummary(shapes: readonly MarkupShape[]): CreateWebsiteChangeRequest["markup"] {
  if (shapes.length === 0) return undefined;
  return {
    marks: shapes.length,
    markers: shapes.filter((shape) => shape.kind === "marker").length,
    labels: shapes.flatMap((shape) => (shape.kind === "text" ? [shape.text] : [])),
  };
}

/** The drawing to attach, rounded to tenths of a pixel to keep the file small. */
export function markupDocument(shapes: readonly MarkupShape[], size: { width: number; height: number }, device: WebsiteCommentWidth): WebsiteMarkupDocument {
  const r = (value: number) => Math.round(value * 10) / 10;
  const p = ([x, y]: MarkupPoint): MarkupPoint => [r(x), r(y)];
  return {
    version: 1,
    width: size.width,
    height: size.height,
    device,
    shapes: shapes.map((shape) => {
      switch (shape.kind) {
        case "pen":
        case "highlight":
          return { ...shape, points: shape.points.map(p) };
        case "arrow":
          return { ...shape, from: p(shape.from), to: p(shape.to) };
        case "box":
          return { ...shape, x: r(shape.x), y: r(shape.y), w: r(shape.w), h: r(shape.h) };
        default:
          return { ...shape, x: r(shape.x), y: r(shape.y) };
      }
    }),
  };
}

/** The subset of the 2D canvas the drawing uses, so a test can record the calls. */
export type MarkupContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "fill"
  | "arc"
  | "strokeRect"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "lineWidth"
  | "strokeStyle"
  | "fillStyle"
  | "globalAlpha"
  | "lineCap"
  | "lineJoin"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

function strokePath(ctx: MarkupContext, points: readonly MarkupPoint[]) {
  ctx.beginPath();
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
}

/** Draws the marks on a 2D canvas the size of the screenshot, ink edge first, as the SVG does. */
export function drawMarkupShapes(ctx: MarkupContext, shapes: readonly MarkupShape[], imageWidth: number) {
  const m = markupMetrics(imageWidth);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const shape of shapes) {
    const hex = markupHex(shape.color);
    const lines: MarkupPoint[][] =
      shape.kind === "pen"
        ? [shape.points]
        : shape.kind === "arrow"
          ? (() => {
              const [left, right] = arrowHead(shape.from, shape.to, m.stroke * 5);
              return [[shape.from, shape.to], [left, shape.to, right]];
            })()
          : shape.kind === "box"
            ? [[[shape.x, shape.y], [shape.x + shape.w, shape.y], [shape.x + shape.w, shape.y + shape.h], [shape.x, shape.y + shape.h], [shape.x, shape.y]]]
            : [];
    if (shape.kind === "highlight") {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = hex;
      ctx.lineWidth = m.highlight;
      strokePath(ctx, shape.points);
      ctx.globalAlpha = 1;
    } else if (lines.length > 0) {
      for (const [style, width] of [[MARKUP_INK, m.stroke + m.edge * 2], [hex, m.stroke]] as const) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        lines.forEach((line) => strokePath(ctx, line));
      }
    } else if (shape.kind === "marker") {
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, m.marker, 0, Math.PI * 2);
      ctx.fillStyle = hex;
      ctx.fill();
      ctx.strokeStyle = MARKUP_INK;
      ctx.lineWidth = m.edge;
      ctx.stroke();
      ctx.fillStyle = MARKUP_INK;
      ctx.font = `700 ${m.font}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(shape.n), shape.x, shape.y);
    } else if (shape.kind === "text") {
      ctx.font = `600 ${m.font}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const width = ctx.measureText(shape.text).width;
      ctx.fillStyle = MARKUP_INK;
      ctx.fillRect(shape.x, shape.y - m.font / 2 - m.pad, width + m.pad * 2, m.font + m.pad * 2);
      ctx.fillStyle = hex;
      ctx.fillText(shape.text, shape.x + m.pad, shape.y);
    }
  }
  ctx.restore();
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The screenshot could not be read."));
    image.src = src;
  });
}

/** The screenshot with the drawing on it, as a PNG file. Null when this browser cannot draw it. */
export async function renderMarkupPng(screenshotUrl: string, shapes: readonly MarkupShape[], name: string): Promise<File | null> {
  const image = await loadImage(screenshotUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  drawMarkupShapes(ctx, shapes, image.naturalWidth);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new File([blob], `website-${name}-markup.png`, { type: "image/png" }) : null;
}

/** The vector drawing as a JSON file for the task. */
export function markupJsonFile(document: WebsiteMarkupDocument, name: string) {
  return new File([JSON.stringify(document)], `website-${name}-markup.json`, { type: "application/json" });
}

/** A PNG data URL's size from its IHDR header, or null when it is not a readable PNG. */
export function pngSize(dataUrl: string): { width: number; height: number } | null {
  try {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 1 + 44));
    if (binary.length < 24 || binary.slice(12, 16) !== "IHDR") return null;
    const word = (at: number) => ((binary.charCodeAt(at) << 24) | (binary.charCodeAt(at + 1) << 16) | (binary.charCodeAt(at + 2) << 8) | binary.charCodeAt(at + 3)) >>> 0;
    const width = word(16);
    const height = word(20);
    return width > 0 && height > 0 && width <= 10_000 && height <= 100_000 ? { width, height } : null;
  } catch {
    return null;
  }
}
