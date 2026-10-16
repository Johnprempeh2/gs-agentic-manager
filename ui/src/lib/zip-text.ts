// Reads text files out of an export .zip (Notion and others) in the browser.
// Unlike readZipArchive in ./zip.ts it works from the central directory, so it
// handles entries written with data descriptors, which Notion's exports use,
// and it opens zips inside zips, which Notion uses for large exports.

export interface ZipTextFile {
  path: string;
  text: string;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view: DataView) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("This is not a zip file, or it is damaged.");
}

/**
 * Text files in a zip whose path passes `keep`, with nested zips opened too.
 * Paths inside a nested zip are joined to the nested zip's own folder.
 */
export async function readZipTextFiles(
  buffer: ArrayBuffer,
  keep: (path: string) => boolean,
  prefix = "",
): Promise<ZipTextFile[]> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder("utf-8");
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files: ZipTextFile[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error("This zip file is damaged.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    const path = `${prefix}${name}`;
    const nested = /\.zip$/i.test(name);
    if (name.endsWith("/") || (!nested && !keep(path))) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error("This zip file is damaged.");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else continue;

    if (nested) {
      const inner = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const folder = path.replace(/[^/]*$/, "");
      files.push(...(await readZipTextFiles(inner, keep, folder)));
    } else {
      files.push({ path, text: decoder.decode(data) });
    }
  }
  return files;
}
