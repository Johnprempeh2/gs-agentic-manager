import { execFile } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { decodeLsofNameField } from "./lsof-name-field.js";

const decode = (field: string) => decodeLsofNameField(Buffer.from(field, "latin1"));

describe("decodeLsofNameField", () => {
  it("decodes non-ASCII bytes lsof prints as \\xNN", () => {
    expect(decode("/w/out/\\xe7\\x8c\\xab picture.png")).toBe("/w/out/猫 picture.png");
    expect(decode("/w/emoji \\xf0\\x9f\\x90\\xb1.txt")).toBe("/w/emoji 🐱.txt");
    expect(decode("/w/\\xE7\\x8C\\xAB")).toBe("/w/猫");
  });

  it("keeps the NFC or NFD bytes lsof reported instead of normalizing them", () => {
    const nfc = decode("/w/r\\xc3\\xa9sum\\xc3\\xa9.pdf");
    const nfd = decode("/w/re\\xcc\\x81sume\\xcc\\x81.pdf");
    expect(nfc).toBe("/w/résumé.pdf");
    expect(nfd).toBe("/w/résumé.pdf");
    expect(nfc).not.toBe(nfd);
  });

  it("decodes backslash and control escapes exactly", () => {
    expect(decode("/w/back\\\\slash")).toBe("/w/back\\slash");
    expect(decode("/w/x\\\\x41")).toBe("/w/x\\x41");
    expect(decode("/w/\\t\\n\\r\\b\\f")).toBe("/w/\t\n\r\b\f");
    expect(decode("/w/del\\x7f")).toBe("/w/del\u007f");
  });

  it("keeps a caret that cannot be a control-byte token", () => {
    expect(decode("/w/x^2.png")).toBe("/w/x^2.png");
    expect(decode("/w/a^b")).toBe("/w/a^b");
    expect(decode("/w/end^")).toBe("/w/end^");
  });

  it("refuses caret sequences that could be a control byte or a literal caret", () => {
    for (const field of ["/w/c^A.txt", "/w/c^[.txt", "/w/c^\\.txt", "/w/c^\\x41", "/w/c^?.txt", "/w/c^@", "/w/c^_"]) {
      expect(decode(field), field).toBeNull();
    }
  });

  it("refuses unknown, truncated, and NUL escapes", () => {
    for (const field of ["/w/\\q", "/w/\\x4", "/w/\\xzz", "/w/trailing\\", "/w/\\x00", "/w/\\040"]) {
      expect(decode(field), field).toBeNull();
    }
  });

  it("refuses bytes that do not form UTF-8", () => {
    for (const field of ["/w/\\xff", "/w/\\xe7\\x8c", "/w/\\xed\\xa0\\x80", "/w/\\xc0\\xaf"]) {
      expect(decode(field), field).toBeNull();
    }
  });

  it("passes raw UTF-8 bytes through unchanged", () => {
    expect(decodeLsofNameField(Buffer.from("/w/猫.png", "utf8"))).toBe("/w/猫.png");
  });

  it.skipIf(process.platform !== "darwin")("round-trips real lsof output for an open descriptor", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lsof-name-field-")));
    try {
      const readable = [
        "猫 picture.png",
        "résumé report.pdf",
        "résumé report.pdf",
        "emoji 🐱.txt",
        "back\\slash.txt",
        "x\\x41.txt",
        "tab\there.txt",
        "x^2 a^b.txt",
      ];
      const reported = async (name: string) => {
        await writeFile(path.join(directory, name), "x");
        const handle = await open(path.join(directory, name), "r");
        try {
          const { stdout } = await promisify(execFile)(
            "/usr/sbin/lsof",
            ["-a", "-p", String(process.pid), "-d", String(handle.fd), "-F0n"],
            { encoding: "buffer" },
          );
          const fields = stdout.toString("latin1").split("\0").filter((field) => field.startsWith("n"));
          expect(fields).toHaveLength(1);
          return decodeLsofNameField(Buffer.from(fields[0]!.slice(1), "latin1"));
        } finally {
          await handle.close();
        }
      };
      for (const name of readable) {
        expect(await reported(name), name).toBe(await realpath(path.join(directory, name)));
      }
      expect(await reported("control\u0001byte.txt")).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
