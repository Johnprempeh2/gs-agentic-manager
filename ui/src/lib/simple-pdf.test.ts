import { describe, expect, it } from "vitest";
import { buildPdf, pdfSafeText, wrapText } from "./simple-pdf";

describe("simple PDF writer", () => {
  it("makes curly quotes and dashes plain and drops what the font cannot draw", () => {
    expect(pdfSafeText("“Brief” – done… £5 ✅")).toBe('"Brief" - done... £5 ?');
  });

  it("wraps at spaces and breaks a word that is too long", () => {
    expect(wrapText("one two three", 10, false, 40)).toEqual(["one two", "three"]);
    expect(wrapText("aaaaaaaaaaaaaaaaaaaa", 10, false, 30).every((line) => line.length < 20)).toBe(true);
  });

  it("writes a valid file with a page per screenful", () => {
    const pdf = buildPdf(Array.from({ length: 80 }, (_, index) => ({ text: `Line ${index}` })), "Test");
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toMatch(/\/Count 2 >>/);
    expect(/^[\x00-\x7f]*$/.test(pdf)).toBe(true);
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const firstObject = Number(pdf.match(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/)![1]);
    expect(pdf.slice(firstObject, firstObject + 7)).toBe("1 0 obj");
  });
});
