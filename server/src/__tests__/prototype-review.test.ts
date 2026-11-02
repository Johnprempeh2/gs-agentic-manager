import { describe, expect, it } from "vitest";
import { prototypeReviewMarkdown, prototypeReviewMarkupSchema } from "@greatstone/shared";
import { injectReviewBridge } from "../services/prototype-review.js";

const markup = prototypeReviewMarkupSchema.parse({
  width: 1440,
  pins: [{ x: 10, y: 20, selector: "h1", tag: "h1", text: "Old title", note: "Bigger" }],
  strokes: [{ color: "#ff4d4d", points: [[0, 0], [5, 5]] }],
  edits: [{ selector: "p", before: "Old line", after: "New line" }],
});

describe("prototype review", () => {
  it("puts the bridge before </body>, and once at the end when there is none", () => {
    const html = injectReviewBridge("<html><body><h1>x</h1></body></html>");
    expect(html.indexOf("__gsReview")).toBeLessThan(html.indexOf("</body>"));
    expect(injectReviewBridge("<h1>x</h1>").endsWith("</script>")).toBe(true);
  });

  it("cannot break out of the preset script with a hostile note", () => {
    const hostile = { ...markup, pins: [{ ...markup.pins[0], note: "</script><script>alert(1)</script>" }] };
    const html = injectReviewBridge("<body></body>", hostile);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  it("refuses markup the server should not draw", () => {
    expect(prototypeReviewMarkupSchema.safeParse({ ...markup, width: 99999 }).success).toBe(false);
    expect(prototypeReviewMarkupSchema.safeParse({ ...markup, strokes: [{ color: "red", points: [[0, 0], [1, 1]] }] }).success).toBe(false);
  });

  it("writes numbered pins and word-for-word edits for the agent", () => {
    const text = prototypeReviewMarkdown(markup, { fileName: "hero.html", imageAttached: true });
    expect(text).toContain('1. On h1 "Old title" (`h1`): Bigger');
    expect(text).toContain('"Old line" → "New line"');
    expect(text).toContain("attached as an image");
  });
});
