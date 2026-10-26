import { describe, expect, it } from "vitest";
import { createWebsiteChangeRequestSchema } from "@greatstone/shared";
import {
  MARKUP_INK,
  boxFrom,
  canAddMark,
  cleanMarkupLabel,
  drawMarkupShapes,
  isTinyShape,
  markupDocument,
  markupJsonFile,
  markupSummary,
  nextMarkerNumber,
  pngSize,
  type MarkupContext,
  type MarkupShape,
} from "./website-markup";

/** A PNG data URL with a real IHDR header of this size. */
function pngDataUrl(width: number, height: number) {
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  const word = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  bytes.push(...word(width), ...word(height), 8, 6, 0, 0, 0, 0, 0, 0, 0);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

const shapes: MarkupShape[] = [
  { kind: "pen", color: "red", points: [[1.23, 4.56], [20.04, 30.06]] },
  { kind: "marker", color: "lime", x: 10, y: 10, n: 1 },
  { kind: "text", color: "teal", x: 5, y: 5, text: "Too big" },
  { kind: "marker", color: "red", x: 50, y: 50, n: 2 },
  { kind: "box", color: "red", x: 0, y: 0, w: 40, h: 40 },
];

describe("website markup (GRE-2518)", () => {
  it("reads the size from a PNG's header, and refuses anything else", () => {
    expect(pngSize(pngDataUrl(1440, 2200))).toEqual({ width: 1440, height: 2200 });
    expect(pngSize("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
    expect(pngSize("data:image/png;base64,!!!")).toBeNull();
  });

  it("numbers markers one more than the highest, so undo then add reuses the number", () => {
    expect(nextMarkerNumber([])).toBe(1);
    expect(nextMarkerNumber(shapes)).toBe(3);
    expect(nextMarkerNumber(shapes.slice(0, 2))).toBe(2);
  });

  it("drops a tap with the pen or a box with no size, keeps a real stroke", () => {
    expect(isTinyShape({ kind: "pen", color: "red", points: [[10, 10], [11, 10]] }, 1440)).toBe(true);
    expect(isTinyShape({ kind: "pen", color: "red", points: [[10, 10], [60, 10]] }, 1440)).toBe(false);
    expect(isTinyShape({ kind: "box", color: "red", ...boxFrom([10, 10], [60, 11]) }, 1440)).toBe(true);
    expect(isTinyShape({ kind: "arrow", color: "red", from: [0, 0], to: [100, 100] }, 1440)).toBe(false);
    expect(isTinyShape({ kind: "marker", color: "red", x: 0, y: 0, n: 1 }, 1440)).toBe(false);
  });

  it("a box from any two corners", () => {
    expect(boxFrom([60, 80], [10, 20])).toEqual({ x: 10, y: 20, w: 50, h: 60 });
  });

  it("keeps a label to one trimmed line of at most 120 characters", () => {
    expect(cleanMarkupLabel("  Too\n big  ")).toBe("Too big");
    expect(cleanMarkupLabel("x".repeat(200))).toHaveLength(120);
    expect(cleanMarkupLabel("   ")).toBe("");
  });

  it("stops at 100 marks", () => {
    const many = Array.from({ length: 100 }, (_, n): MarkupShape => ({ kind: "marker", color: "red", x: 0, y: 0, n: n + 1 }));
    expect(canAddMark(many.slice(1))).toBe(true);
    expect(canAddMark(many)).toBe(false);
  });

  it("the summary the server takes: marks, markers and labels", () => {
    const summary = markupSummary(shapes);
    expect(summary).toEqual({ marks: 5, markers: 2, labels: ["Too big"] });
    expect(markupSummary([])).toBeUndefined();
    const parsed = createWebsiteChangeRequestSchema.safeParse({
      requestId: "9b2f4b6e-8a5d-4d7e-9a43-0c1d2e3f4a5b",
      pageRevisionId: "1b2f4b6e-8a5d-4d7e-9a43-0c1d2e3f4a5b",
      request: "",
      screenshot: true,
      markup: summary,
    });
    expect(parsed.success).toBe(true);
  });

  it("the vector file: the screenshot's size, the device and every shape, rounded to tenths", async () => {
    const document = markupDocument(shapes, { width: 1440, height: 900 }, "tablet");
    expect(document).toMatchObject({ version: 1, width: 1440, height: 900, device: "tablet" });
    expect(document.shapes[0]).toEqual({ kind: "pen", color: "red", points: [[1.2, 4.6], [20, 30.1]] });
    expect(document.shapes).toHaveLength(5);
    const file = markupJsonFile(document, "hero-1");
    expect(file.name).toBe("website-hero-1-markup.json");
    expect(file.type).toBe("application/json");
    expect(JSON.parse(await file.text())).toEqual(document);
  });

  it("draws each line twice, ink edge then colour, and a marker's number in ink", () => {
    const calls: string[] = [];
    const strokes: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke(this: MarkupContext) {
        strokes.push(String(this.strokeStyle));
      },
      fill: () => calls.push("fill"),
      arc: () => calls.push("arc"),
      strokeRect: () => {},
      fillRect: () => calls.push("fillRect"),
      fillText(this: MarkupContext, text: string) {
        calls.push(`text:${text}:${String(this.fillStyle)}`);
      },
      measureText: () => ({ width: 40 }) as TextMetrics,
      lineWidth: 0,
      strokeStyle: "",
      fillStyle: "",
      globalAlpha: 1,
      lineCap: "butt",
      lineJoin: "miter",
      font: "",
      textAlign: "start",
      textBaseline: "alphabetic",
    } as unknown as MarkupContext;
    drawMarkupShapes(ctx, [shapes[0]!, shapes[1]!, shapes[2]!], 1440);
    expect(strokes.slice(0, 2)).toEqual([MARKUP_INK, "#ff6b6b"]);
    expect(calls).toContain(`text:1:${MARKUP_INK}`);
    expect(calls).toContain("text:Too big:#4ecdc4");
    expect(calls[0]).toBe("save");
    expect(calls.at(-1)).toBe("restore");
  });
});
