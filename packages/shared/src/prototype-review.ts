import { z } from "zod";

/**
 * John's markup on an agent-made HTML prototype: numbered pins with notes,
 * freehand strokes and in-place text edits. Coordinates are page pixels at
 * `width`, so the server can redraw them on the same layout.
 */
const point = z.tuple([z.number().finite(), z.number().finite()]);
const shortText = (max: number) => z.string().max(max);

/** The pen colour for review drawings; the server redraws strokes in it. */
export const PROTOTYPE_REVIEW_STROKE_COLOR = "#ff4d4d";

export const prototypeReviewMarkupSchema = z.object({
  width: z.number().int().min(280).max(2560),
  pins: z.array(z.object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    selector: shortText(500),
    tag: shortText(40),
    text: shortText(300),
    note: shortText(4000),
  })).max(100),
  strokes: z.array(z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    points: z.array(point).min(2).max(2000),
  })).max(200),
  edits: z.array(z.object({
    selector: shortText(500),
    before: shortText(4000),
    after: shortText(4000),
  })).max(100),
  note: shortText(8000).default(""),
});

export type PrototypeReviewMarkup = z.infer<typeof prototypeReviewMarkupSchema>;

const quote = (text: string) => text.replace(/\s+/g, " ").trim();

/** The comment the agent reads: every pin and edit, numbered to match the marked-up image. */
export function prototypeReviewMarkdown(markup: PrototypeReviewMarkup, input: { fileName: string; imageAttached: boolean }) {
  const lines = [`**Review of ${input.fileName}** (at ${markup.width}px wide)`, ""];
  if (markup.note.trim()) lines.push(markup.note.trim(), "");
  if (markup.pins.length) {
    lines.push("**Comments** (numbers match the pins on the image):");
    markup.pins.forEach((pin, i) => {
      const where = pin.text ? `${pin.tag} "${quote(pin.text).slice(0, 120)}"` : pin.tag;
      lines.push(`${i + 1}. On ${where} (\`${pin.selector}\`): ${quote(pin.note) || "(no note)"}`);
    });
    lines.push("");
  }
  if (markup.edits.length) {
    lines.push("**Text changes** (apply word for word):");
    for (const edit of markup.edits) {
      lines.push(`- \`${edit.selector}\`: "${quote(edit.before)}" → "${quote(edit.after)}"`);
    }
    lines.push("");
  }
  if (markup.strokes.length) {
    lines.push(`**Drawings:** ${markup.strokes.length} mark${markup.strokes.length === 1 ? "" : "s"} on the image.`, "");
  }
  lines.push(
    input.imageAttached
      ? "The marked-up page is attached as an image: open it to see the pins and drawings where John put them."
      : "No marked-up image this time (the server has no headless browser); the pins above give the element and text.",
    "Gear 1 (for John): apply this and send John the next round; no agent review needed.",
  );
  return lines.join("\n");
}
