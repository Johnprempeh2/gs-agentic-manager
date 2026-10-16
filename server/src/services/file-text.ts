import { strFromU8, unzipSync, unzlibSync, inflateSync } from "fflate";

/**
 * Read the words out of an uploaded file so search can find them: plain
 * text, Word, PowerPoint and Excel files, and PDFs with a text layer. No
 * outside service and no native code: Office files are zips of XML, and PDF
 * text comes from the page content streams.
 */

/** Text kept per file; enough for long contracts, small enough to search quickly. */
export const MAX_FILE_TEXT_CHARS = 400_000;

export type FileTextResult =
  | { status: "indexed"; text: string }
  | { status: "unsupported"; text: null }
  | { status: "failed"; text: null; error: string };

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "log", "xml", "html", "htm"]);
const TEXT_TYPES = ["application/json", "application/xml", "application/x-yaml", "application/yaml", "application/csv"];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function extensionOf(filename: string | null | undefined): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename ?? "");
  return match ? match[1]!.toLowerCase() : "";
}

/** Tidy extracted text: one space between words, no blank runs, capped. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v  ]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]!.length > 0))
    .join("\n")
    .trim()
    .slice(0, MAX_FILE_TEXT_CHARS);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

/** Text runs in Office XML: `<w:t>` (Word), `<a:t>` (PowerPoint), `<t>` (Excel), a line per paragraph. */
function officeXmlText(xml: string, textTag: string, paragraphEnd: string): string {
  const out: string[] = [];
  const pattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|<${paragraphEnd}\\b|<w:tab/>|<w:br/>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) out.push(decodeEntities(match[1]));
    else if (match[0] === "<w:tab/>") out.push("\t");
    else out.push("\n");
  }
  return out.join("");
}

function byNumber(a: string, b: string) {
  const n = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  return n(a) - n(b);
}

function officeText(buffer: Buffer, kind: "docx" | "pptx" | "xlsx"): string {
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => file.name.endsWith(".xml") && file.originalSize < 50 * 1024 * 1024,
  });
  const read = (name: string) => (files[name] ? strFromU8(files[name]!) : "");
  if (kind === "docx") {
    const parts = ["word/document.xml", ...Object.keys(files).filter((name) => /^word\/(header|footer|footnotes)\d*\.xml$/.test(name)).sort()];
    return parts.map((name) => officeXmlText(read(name), "w:t", "/w:p")).join("\n");
  }
  if (kind === "pptx") {
    const slides = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(byNumber);
    return slides.map((name) => officeXmlText(read(name), "a:t", "/a:p")).join("\n");
  }
  const sheets = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(byNumber);
  return [officeXmlText(read("xl/sharedStrings.xml"), "t", "/si"), ...sheets.map((name) => officeXmlText(read(name), "t", "/row"))].join("\n");
}

/* ---------------------------------------------------------------- PDF */

type CMap = { bytes: 1 | 2; map: Map<number, string> };

function inflate(data: Uint8Array): Uint8Array | null {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data);
    } catch {
      return null;
    }
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return out;
}

/** The filters a stream was encoded with, in the order to undo them. */
function streamFilters(dict: string): string[] {
  const match = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
  return match ? [...match[1]!.matchAll(/\/(\w+)/g)].map((name) => name[1]!) : [];
}

function ascii85(data: Uint8Array): Uint8Array {
  const text = latin1(data).replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) value = value * 85 + (group[index] ?? 84);
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, count));
    group = [];
  };
  for (const char of text) {
    if (char === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(char.charCodeAt(0) - 33);
    if (group.length === 5) flush(4);
  }
  if (group.length > 0) flush(group.length - 1);
  return Uint8Array.from(out);
}

function decodeStream(data: Uint8Array, filters: string[]): Uint8Array | null {
  let current: Uint8Array | null = data;
  for (const filter of filters) {
    if (!current) return null;
    if (filter === "FlateDecode" || filter === "Fl") current = inflate(current);
    else if (filter === "ASCII85Decode" || filter === "A85") current = ascii85(current);
    else if (filter === "ASCIIHexDecode" || filter === "AHx") current = Uint8Array.from(hexBytes(latin1(current).replace(/>.*$/s, "")));
    else return null;
  }
  return current;
}

interface PdfObject {
  id: number;
  dict: string;
  /** Decoded stream as a latin1 string, when the object has a stream we can read. */
  stream: string | null;
}

function pdfObjects(buffer: Buffer): PdfObject[] {
  const source = buffer.toString("latin1");
  const objects: PdfObject[] = [];
  const pattern = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endobj", start);
    if (end < 0) break;
    const body = source.slice(start, end);
    pattern.lastIndex = end;
    const streamAt = body.search(/\bstream\r?\n/);
    if (streamAt < 0) {
      objects.push({ id: Number(match[1]), dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const dataStart = body.indexOf("\n", streamAt) + 1;
    const dataEnd = body.lastIndexOf("endstream");
    let raw = body.slice(dataStart, dataEnd < 0 ? body.length : dataEnd);
    raw = raw.replace(/\r?\n$/, "");
    const decoded = decodeStream(Uint8Array.from(raw, (char) => char.charCodeAt(0)), streamFilters(dict));
    objects.push({ id: Number(match[1]), dict, stream: decoded ? latin1(decoded) : null });
  }
  // Dictionaries packed inside object streams (fonts often live there).
  for (const object of [...objects]) {
    if (!object.stream || !/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? NaN);
    if (!Number.isFinite(first)) continue;
    const header = object.stream.slice(0, first).trim().split(/\s+/).map(Number);
    for (let index = 0; index + 1 < header.length; index += 2) {
      const from = first + header[index + 1]!;
      const to = index + 3 < header.length ? first + header[index + 3]! : object.stream.length;
      objects.push({ id: header[index]!, dict: object.stream.slice(from, to), stream: null });
    }
  }
  return objects;
}

function hexToCodes(hex: string): number {
  return parseInt(hex, 16);
}

function utf16Hex(hex: string): string {
  let out = "";
  for (let index = 0; index + 3 < hex.length + 1; index += 4) {
    const unit = parseInt(hex.slice(index, index + 4), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** A font's ToUnicode CMap: character codes to the text they stand for. */
export function parseToUnicode(cmap: string): CMap {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const space = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(cmap);
  if (space && space[1]!.length >= 4) bytes = 2;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi)) {
    for (const entry of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (entry[1]!.length >= 4) bytes = 2;
      map.set(hexToCodes(entry[1]!), utf16Hex(entry[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi)) {
    for (const entry of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi)) {
      const low = hexToCodes(entry[1]!);
      const high = hexToCodes(entry[2]!);
      if (entry[1]!.length >= 4) bytes = 2;
      if (high - low > 0xffff) continue;
      if (entry[4] !== undefined) {
        const base = entry[4];
        const start = parseInt(base.slice(-4), 16);
        const prefix = utf16Hex(base.slice(0, -4));
        for (let code = low; code <= high; code += 1) map.set(code, prefix + String.fromCharCode(start + (code - low)));
      } else {
        const targets = [...entry[5]!.matchAll(/<([0-9a-f]*)>/gi)].map((target) => utf16Hex(target[1]!));
        targets.forEach((target, offset) => map.set(low + offset, target));
      }
    }
  }
  return { bytes, map };
}

function literalBytes(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char !== "\\") {
      out.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = text[index + 1] ?? "";
    index += 1;
    if (next === "n") out.push(10);
    else if (next === "r") out.push(13);
    else if (next === "t") out.push(9);
    else if (next === "b") out.push(8);
    else if (next === "f") out.push(12);
    else if (next === "\r" || next === "\n") {
      if (next === "\r" && text[index + 1] === "\n") index += 1;
    } else if (/[0-7]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /[0-7]/.test(text[index + 1] ?? "")) {
        digits += text[index + 1];
        index += 1;
      }
      out.push(parseInt(digits, 8) & 0xff);
    } else out.push(next.charCodeAt(0) & 0xff);
  }
  return out;
}

function hexBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const out: number[] = [];
  for (let index = 0; index < padded.length; index += 2) out.push(parseInt(padded.slice(index, index + 2), 16));
  return out;
}

function decodeBytes(bytes: number[], cmap: CMap | undefined): string {
  if (!cmap) return String.fromCharCode(...bytes);
  let out = "";
  for (let index = 0; index < bytes.length; index += cmap.bytes) {
    const code = cmap.bytes === 2 ? (bytes[index]! << 8) | (bytes[index + 1] ?? 0) : bytes[index]!;
    out += cmap.map.get(code) ?? (cmap.bytes === 1 ? String.fromCharCode(code) : "");
  }
  return out;
}

/** Read the strings a content stream shows, with a line break where the text moves down. */
function contentText(stream: string, fonts: Map<string, CMap>): string {
  const out: string[] = [];
  let font: CMap | undefined;
  const tokens = /\/([^\s/<>[\]()]+)\s+[-\d.]+\s+Tf|\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[|\]|(-?\d*\.?\d+)|\b(Tj|TJ|'|"|T\*|Td|TD|Tm|ET|BT)\b/g;
  let lastNumbers: number[] = [];
  let inArray = false;
  for (const match of stream.matchAll(tokens)) {
    const token = match[0];
    if (match[1] !== undefined) {
      font = fonts.get(match[1]);
      continue;
    }
    if (token.startsWith("(")) {
      out.push(decodeBytes(literalBytes(token.slice(1, -1)), font));
      continue;
    }
    if (token.startsWith("<")) {
      out.push(decodeBytes(hexBytes(token.slice(1, -1)), font));
      continue;
    }
    if (token === "[") {
      inArray = true;
      continue;
    }
    if (token === "]") {
      inArray = false;
      continue;
    }
    if (match[2] !== undefined) {
      const value = Number(match[2]);
      // A big negative gap inside a TJ array is a space between words.
      if (inArray && value < -200) out.push(" ");
      lastNumbers = [...lastNumbers.slice(-5), value];
      continue;
    }
    const operator = match[3];
    if (operator === "T*" || operator === "'" || operator === '"' || operator === "ET") out.push("\n");
    else if ((operator === "Td" || operator === "TD") && (lastNumbers.at(-1) ?? 0) !== 0) out.push("\n");
    else if (operator === "Tm") out.push("\n");
    else if (operator === "Tj" || operator === "TJ") out.push("");
    lastNumbers = [];
  }
  return out.join("");
}

export function pdfText(buffer: Buffer): string {
  const objects = pdfObjects(buffer);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const cmapByFontId = new Map<number, CMap>();
  for (const object of objects) {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    const cmapObject = ref ? byId.get(Number(ref[1])) : undefined;
    if (cmapObject?.stream) cmapByFontId.set(object.id, parseToUnicode(cmapObject.stream));
  }
  // Font resource names ("/F1 12 0 R") to their CMaps, across every resource dictionary.
  const fonts = new Map<string, CMap>();
  for (const object of objects) {
    for (const block of object.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const entry of block[1]!.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
        const cmap = cmapByFontId.get(Number(entry[2]));
        if (cmap && !fonts.has(entry[1]!)) fonts.set(entry[1]!, cmap);
      }
    }
  }
  const pages: string[] = [];
  for (const object of objects) {
    if (!object.stream || /\/Type\s*\/(ObjStm|XRef|XObject)|\/Subtype\s*\/Image|begincmap/.test(`${object.dict}${object.stream.slice(0, 200)}`)) continue;
    if (!/\bBT\b/.test(object.stream) || !/\bET\b/.test(object.stream)) continue;
    pages.push(contentText(object.stream, fonts));
  }
  return pages.join("\n").replace(/\n{2,}/g, "\n");
}

/* ------------------------------------------------------------- entry */

/** Whether a file is a kind we can read, judged by its type and name alone, so other files are never downloaded. */
export function canExtractFileText(contentType: string, filename: string | null): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = extensionOf(filename);
  return type === "application/pdf" || type === DOCX || type === PPTX || type === XLSX || type.startsWith("text/")
    || TEXT_TYPES.includes(type)
    || ["pdf", "docx", "pptx", "xlsx", "html", "htm"].includes(ext) || TEXT_EXTENSIONS.has(ext);
}

/** The words in a file, or why there are none. */
export function extractFileText(buffer: Buffer, contentType: string, filename: string | null): FileTextResult {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = extensionOf(filename);
  try {
    let text: string | null = null;
    if (type === "application/pdf" || ext === "pdf") text = pdfText(buffer);
    else if (type === DOCX || ext === "docx") text = officeText(buffer, "docx");
    else if (type === PPTX || ext === "pptx") text = officeText(buffer, "pptx");
    else if (type === XLSX || ext === "xlsx") text = officeText(buffer, "xlsx");
    else if (type === "text/html" || ext === "html" || ext === "htm") text = htmlText(buffer.toString("utf8"));
    else if (type.startsWith("text/") || TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.has(ext)) text = buffer.toString("utf8");
    if (text === null) return { status: "unsupported", text: null };
    return { status: "indexed", text: tidyText(text) };
  } catch (error) {
    return { status: "failed", text: null, error: error instanceof Error ? error.message : String(error) };
  }
}
