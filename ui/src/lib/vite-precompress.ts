import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json)$/;
const MIN_BYTES = 1024;

/**
 * Write `.br` and `.gz` copies of each built asset next to it. The server's
 * static UI mode sends them to browsers that accept them (see
 * server/src/middleware/precompressed-assets.ts): the main bundle is about
 * 6 MB raw and 1.4 MB as brotli, which matters for a phone over Tailscale.
 */
export function precompressAssetsPlugin(): Plugin {
  return {
    name: "gsam-precompress-assets",
    apply: "build",
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) return;
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.startsWith("assets/") || !COMPRESSIBLE.test(fileName)) continue;
        const filePath = path.join(outDir, fileName);
        const source = fs.readFileSync(filePath);
        if (source.length < MIN_BYTES) continue;
        fs.writeFileSync(`${filePath}.br`, brotliCompressSync(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: source.length },
        }));
        fs.writeFileSync(`${filePath}.gz`, gzipSync(source, { level: 9 }));
      }
    },
  };
}
