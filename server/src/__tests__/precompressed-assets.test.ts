import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { precompressedAssets } from "../middleware/precompressed-assets.js";

// Live serves the built UI to a phone over Tailscale; the main bundle is ~6 MB raw.
const source = "export const x = 1;\n".repeat(200);
let dir: string;
let app: express.Express;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-assets-"));
  fs.writeFileSync(path.join(dir, "index-abc.js"), source);
  fs.writeFileSync(path.join(dir, "index-abc.js.br"), brotliCompressSync(source));
  fs.writeFileSync(path.join(dir, "index-abc.js.gz"), gzipSync(source));
  fs.writeFileSync(path.join(dir, "plain-abc.css"), "body{}");
  fs.writeFileSync(path.join(dir, "..", "secret.js.gz"), gzipSync("secret"));
  app = express();
  app.use("/assets", precompressedAssets(dir), express.static(dir, { maxAge: "1y", immutable: true }));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const raw = (req: request.Test) => req.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
});

describe("precompressed UI assets", () => {
  it("sends brotli when accepted, as JavaScript, cached for a year", async () => {
    const res = await raw(request(app).get("/assets/index-abc.js").set("Accept-Encoding", "gzip, deflate, br"));
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers.vary).toContain("Accept-Encoding");
    expect(res.headers["cache-control"]).toContain("immutable");
    // The client decodes by Content-Encoding, so this also proves the body is valid brotli.
    expect(res.body.toString()).toBe(source);
  });

  it("falls back to gzip, then to the plain file", async () => {
    const gz = await raw(request(app).get("/assets/index-abc.js").set("Accept-Encoding", "gzip"));
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.body.toString()).toBe(source);
    const refused = await raw(request(app).get("/assets/index-abc.js").set("Accept-Encoding", "br;q=0, gzip;q=0"));
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(refused.body.toString()).toBe(source);
    const noCopy = await request(app).get("/assets/plain-abc.css").set("Accept-Encoding", "br");
    expect(noCopy.headers["content-encoding"]).toBeUndefined();
    expect(noCopy.text).toBe("body{}");
  });

  it("never serves a compressed file from outside the assets folder", async () => {
    for (const p of ["/assets/../secret.js", "/assets/..%2fsecret.js", "/assets/%2e%2e/secret.js"]) {
      const res = await request(app).get(p).set("Accept-Encoding", "gzip");
      expect(res.headers["content-encoding"]).toBeUndefined();
      expect(res.status).toBe(404);
    }
  });
});
