import { describe, expect, it } from "vitest";
import { strToU8, zipSync, zlibSync } from "fflate";
import { canExtractFileText, extractFileText, parseToUnicode, pdfText, tidyText } from "../services/file-text.js";

/** A small PDF with the given objects; offsets are not needed for text reading. */
function pdf(objects: string[]): Buffer {
  return Buffer.from(`%PDF-1.4\n${objects.map((body, index) => `${index + 1} 0 obj\n${body}\nendobj\n`).join("")}%%EOF\n`, "latin1");
}

function stream(content: string, compress = false): string {
  if (!compress) return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const packed = Buffer.from(zlibSync(strToU8(content))).toString("latin1");
  return `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed}\nendstream`;
}

describe("extractFileText", () => {
  it("reads plain text, markdown and csv", () => {
    expect(extractFileText(Buffer.from("Fee: 2,000 a month\r\n\r\n\r\nPaid  quarterly"), "text/plain", "terms.txt")).toEqual({
      status: "indexed",
      text: "Fee: 2,000 a month\n\nPaid quarterly",
    });
    expect(extractFileText(Buffer.from("name,role\nAda,Lead"), "application/octet-stream", "team.csv").text).toBe("name,role\nAda,Lead");
  });

  it("strips HTML down to its words", () => {
    const result = extractFileText(Buffer.from("<html><style>p{}</style><p>Hello &amp; welcome</p><p>Line two</p></html>"), "text/html", null);
    expect(result.text).toBe("Hello & welcome\nLine two");
  });

  it("reads a Word document, paragraph by paragraph", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>Mutual NDA</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Term: </w:t></w:r><w:r><w:t>two years &amp; one day</w:t></w:r></w:p></w:body></w:document>`;
    const docx = Buffer.from(zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") }));
    expect(extractFileText(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "nda.docx")).toEqual({
      status: "indexed",
      text: "Mutual NDA\nTerm: two years & one day",
    });
  });

  it("reads PowerPoint slides in order and Excel shared strings", () => {
    const pptx = Buffer.from(zipSync({
      "ppt/slides/slide10.xml": strToU8("<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>"),
      "ppt/slides/slide2.xml": strToU8("<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>"),
    }));
    expect(extractFileText(pptx, "", "deck.pptx").text).toBe("First\n\nLast");
    const xlsx = Buffer.from(zipSync({ "xl/sharedStrings.xml": strToU8("<sst><si><t>Revenue</t></si><si><t>Costs</t></si></sst>") }));
    expect(extractFileText(xlsx, "", "plan.xlsx").text).toBe("Revenue\nCosts");
  });

  it("leaves images alone and reports a broken file", () => {
    expect(extractFileText(Buffer.from([0x89, 0x50]), "image/png", "logo.png")).toEqual({ status: "unsupported", text: null });
    expect(extractFileText(Buffer.from("not a zip"), "", "broken.docx").status).toBe("failed");
  });

  it("knows which files are worth downloading", () => {
    expect(canExtractFileText("application/pdf", null)).toBe(true);
    expect(canExtractFileText("application/octet-stream", "Pack.DOCX")).toBe(true);
    expect(canExtractFileText("text/csv; charset=utf-8", null)).toBe(true);
    expect(canExtractFileText("image/png", "logo.png")).toBe(false);
    expect(canExtractFileText("video/mp4", "demo.mp4")).toBe(false);
  });
});

describe("pdfText", () => {
  it("reads simple and compressed text, one line per move down", () => {
    const content = "BT /F1 12 Tf 72 720 Td (Engagement pack) Tj 0 -14 Td [(Fee) -300 (\\(fixed\\))] TJ ET";
    expect(tidyText(pdfText(pdf([stream(content)])))).toBe("Engagement pack\nFee (fixed)");
    expect(tidyText(pdfText(pdf([stream(content, true)])))).toBe("Engagement pack\nFee (fixed)");
  });

  it("maps two-byte glyph codes through the font's ToUnicode CMap", () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin begincmap",
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "2 beginbfchar <0001> <004E> <0002> <0044> endbfchar",
      "1 beginbfrange <0003> <0004> <0041> endbfrange",
      "endcmap",
    ].join("\n");
    const objects = [
      "<< /Type /Page /Resources << /Font << /F7 2 0 R >> >> /Contents 4 0 R >>",
      "<< /Type /Font /Subtype /Type0 /ToUnicode 3 0 R >>",
      stream(cmap, true),
      stream("BT /F7 11 Tf <0001000200030004> Tj ET", true),
    ];
    expect(tidyText(pdfText(pdf(objects)))).toBe("NDAB");
  });

  it("parses bfrange arrays", () => {
    const parsed = parseToUnicode("begincodespacerange <00> <FF> endcodespacerange beginbfrange <41> <42> [<0058> <0059>] endbfrange");
    expect(parsed.bytes).toBe(1);
    expect(parsed.map.get(0x41)).toBe("X");
    expect(parsed.map.get(0x42)).toBe("Y");
  });
});
