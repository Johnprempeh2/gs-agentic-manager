// Parses a single HTTP Range header ("bytes=0-99", "bytes=100-", "bytes=-50")
// against a known length. Safari will not play a video without it.

export type ParsedByteRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

export function parseByteRangeHeader(raw: string | undefined, contentLength: number): ParsedByteRange {
  if (!raw) return { kind: "none" };
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return { kind: "invalid" };
  const prefix = "bytes=";
  if (!raw.toLowerCase().startsWith(prefix)) return { kind: "invalid" };
  const spec = raw.slice(prefix.length).trim();
  if (!spec || spec.includes(",")) return { kind: "invalid" };
  const [startRaw, endRaw] = spec.split("-", 2);
  if (endRaw === undefined) return { kind: "invalid" };
  if (startRaw === "") {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(contentLength - suffixLength, 0), end: contentLength - 1 };
  }
  const start = Number.parseInt(startRaw!, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= contentLength) return { kind: "invalid" };
  const end = endRaw === "" ? contentLength - 1 : Number.parseInt(endRaw, 10);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, contentLength - 1) };
}
