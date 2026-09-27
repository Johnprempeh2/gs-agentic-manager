import { isUtf8 } from "node:buffer";

const BACKSLASH = 0x5c;
const CARET = 0x5e;

const SINGLE_CHARACTER_ESCAPES = new Map<number, number>([
  [0x5c, 0x5c], // \\
  [0x62, 0x08], // \b
  [0x66, 0x0c], // \f
  [0x6e, 0x0a], // \n
  [0x72, 0x0d], // \r
  [0x74, 0x09], // \t
]);

function hexDigit(byte: number | undefined): number | null {
  if (byte === undefined) return null;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return null;
}

/**
 * Decodes the `n` (name) field lsof prints for an open file back to the path
 * it names, or returns null when the field does not decode to exactly one
 * UTF-8 path.
 *
 * lsof escapes every byte outside printable ASCII. High bytes and DEL print
 * as `\xNN`, five controls print as `\b` `\f` `\n` `\r` `\t`, and a literal
 * backslash prints as `\\`, so every backslash sequence has one meaning. The
 * remaining control bytes print as `^` followed by the byte plus 0x40 (and
 * 0xff as `^?`), which is indistinguishable from a literal caret in the name.
 * Those sequences are refused rather than guessed, so a decoded path always
 * names the file lsof reported.
 */
export function decodeLsofNameField(field: Buffer): string | null {
  const bytes: number[] = [];
  for (let index = 0; index < field.length; index += 1) {
    const byte = field[index]!;
    if (byte === CARET) {
      const next = field[index + 1];
      if (next !== undefined && ((next >= 0x40 && next <= 0x5f) || next === 0x3f)) {
        return null;
      }
      bytes.push(byte);
      continue;
    }
    if (byte !== BACKSLASH) {
      bytes.push(byte);
      continue;
    }
    const escape = field[index + 1];
    const single = escape === undefined ? undefined : SINGLE_CHARACTER_ESCAPES.get(escape);
    if (single !== undefined) {
      bytes.push(single);
      index += 1;
      continue;
    }
    const high = hexDigit(field[index + 2]);
    const low = hexDigit(field[index + 3]);
    if (escape !== 0x78 || high === null || low === null) return null;
    const decoded = high * 16 + low;
    if (decoded === 0) return null;
    bytes.push(decoded);
    index += 3;
  }
  const decoded = Buffer.from(bytes);
  return isUtf8(decoded) ? decoded.toString("utf8") : null;
}
