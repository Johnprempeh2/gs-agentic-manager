import fs from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
// Vite emits flat, hashed names under assets/: nothing else is served here.
const ASSET_NAME = /^\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function accepts(header: string, encoding: string): boolean {
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== encoding) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

/**
 * Serve the `.br` or `.gz` copy the UI build wrote next to a hashed asset
 * (ui/src/lib/vite-precompress.ts) when the browser accepts it. Anything else
 * falls through to the plain static handler.
 */
export function precompressedAssets(assetsDir: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!ASSET_NAME.test(req.path)) return next();
    const contentType = CONTENT_TYPES[path.extname(req.path)];
    if (!contentType) return next();
    const header = String(req.headers["accept-encoding"] ?? "");
    const filePath = path.join(assetsDir, req.path.slice(1));
    for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
      if (!accepts(header, encoding) || !fs.existsSync(`${filePath}${suffix}`)) continue;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.sendFile(`${filePath}${suffix}`, { maxAge: "1y", immutable: true }, (err) => {
        if (err && !res.headersSent) {
          res.removeHeader("Content-Encoding");
          next();
        }
      });
      return;
    }
    res.setHeader("Vary", "Accept-Encoding");
    next();
  };
}
