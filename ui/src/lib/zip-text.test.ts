import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZipTextFiles } from "./zip-text";

/** Builds a zip in memory: each entry stored or deflated, as real tools write them. */
function makeZip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>) {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, entry.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, entry.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

const text = (value: string) => new TextEncoder().encode(value);

describe("readZipTextFiles", () => {
  it("reads stored and deflated files, opens zips inside zips and skips the rest", async () => {
    const inner = makeZip([{ name: "Clients/Osei Farms.md", data: text("# Osei Farms"), deflate: true }]);
    const outer = makeZip([
      { name: "Clients/", data: new Uint8Array() },
      { name: "Clients/Kente Logistics.md", data: text("# Kente Logistics\n\nAma é ótima"), deflate: true },
      { name: "Clients/Clients.csv", data: text("Name") },
      { name: "Readme.md", data: text("stored") },
      { name: "Export-Part-1.zip", data: inner },
    ]);
    const files = await readZipTextFiles(outer.buffer as ArrayBuffer, (path) => path.endsWith(".md"));
    expect(files).toEqual([
      { path: "Clients/Kente Logistics.md", text: "# Kente Logistics\n\nAma é ótima" },
      { path: "Readme.md", text: "stored" },
      { path: "Clients/Osei Farms.md", text: "# Osei Farms" },
    ]);
  });

  it("explains a file that is not a zip", async () => {
    await expect(readZipTextFiles(text("hello there, not a zip at all").buffer as ArrayBuffer, () => true)).rejects.toThrow(/not a zip/);
  });
});
