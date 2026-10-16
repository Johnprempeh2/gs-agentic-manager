/**
 * A small text-only PDF writer: A4 pages, Helvetica and Helvetica Bold, word
 * wrap and page breaks. Enough for a one-page report without a PDF library.
 * The output is plain ASCII (text goes in as hex), so it can be saved as text.
 */

export interface PdfLine {
  text: string;
  /** Font size in points. */
  size?: number;
  bold?: boolean;
  /** Left indent in points. */
  indent?: number;
  /** Extra space above, in points. */
  gapBefore?: number;
  /** Grey instead of black. */
  muted?: boolean;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_HEIGHT = 1.35;

// Helvetica advance widths (per 1000 em) for characters 32 to 126.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const REPLACEMENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u00A0": " ",
};

/** Text the standard fonts can draw: Latin-1, with curly quotes and dashes made plain. */
export function pdfSafeText(text: string): string {
  let out = "";
  for (const char of text) {
    const replaced = REPLACEMENTS[char] ?? char;
    for (const c of replaced) {
      const code = c.charCodeAt(0);
      out += (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? c : "?";
    }
  }
  return out;
}

function textWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    units += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32]! : 556;
  }
  return (units / 1000) * size * (bold ? 1.06 : 1);
}

/** Split a line into pieces that fit `width`, breaking at spaces (or mid-word when one word is too long). */
export function wrapText(text: string, size: number, bold: boolean, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size, bold) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while (textWidth(rest, size, bold) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > width) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
}

function hex(text: string): string {
  let out = "";
  for (const char of text) out += char.charCodeAt(0).toString(16).padStart(2, "0");
  return `<${out}>`;
}

/** Lay the lines out on A4 pages and return the PDF file as a string of ASCII. */
export function buildPdf(lines: PdfLine[], title = "Report"): string {
  const usable = PAGE_WIDTH - MARGIN * 2;
  const pages: string[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    const size = line.size ?? 11;
    const bold = line.bold ?? false;
    const indent = line.indent ?? 0;
    const leading = size * LINE_HEIGHT;
    y -= line.gapBefore ?? 0;
    for (const piece of wrapText(pdfSafeText(line.text), size, bold, usable - indent)) {
      if (y - leading < MARGIN) {
        pages.push([]);
        y = PAGE_HEIGHT - MARGIN;
      }
      y -= leading;
      const grey = line.muted ? "0.42 g" : "0 g";
      pages[pages.length - 1]!.push(
        `BT ${grey} /${bold ? "F2" : "F1"} ${size} Tf ${(MARGIN + indent).toFixed(2)} ${y.toFixed(2)} Td ${hex(piece)} Tj ET`,
      );
    }
  }

  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((commands, index) => {
    const pageId = pageIds[index]!;
    const stream = commands.join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const infoId = objects.length;
  objects[infoId] = `<< /Title ${hex(pdfSafeText(title))} /Producer (GS Agentic Manager) >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
