import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";
import { createApiProxy } from "./src/lib/vite-api-proxy";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id";
import { buildInfoPlugin, readBrowserBuildCommit } from "./src/lib/vite-build-commit";
import { precompressAssetsPlugin } from "./src/lib/vite-precompress";
import { isLoopbackHost, resolveDevServerHost } from "./src/lib/dev-server-host.mjs";

// GSAM_UI_API_TARGET points the dev UI at another server (for example the
// preview on :3200) instead of live on :3100.
const apiProxy = createApiProxy(process.env.GSAM_UI_API_TARGET || undefined);
const buildCommit = readBrowserBuildCommit(__dirname);
// The dev and preview servers listen on loopback; GSAM_DEV_HOST opts in to
// another address (for example 0.0.0.0 to open `pnpm dev:mobile` from a phone).
// The main server loads this config in middleware mode and passes its own
// host, so this does not change where it listens.
const devServerHost = resolveDevServerHost(process.env.GSAM_DEV_HOST);

export default defineConfig(({ mode }) => ({
  define: {
    __GSAM_BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  plugins: [react(), tailwindcss(), serviceWorkerBuildIdPlugin(), buildInfoPlugin(buildCommit), precompressAssetsPlugin()],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          // React's component trace uses function names. Keep those useful in
          // error reports without publishing source maps or page context.
          keepNames: true,
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    host: devServerHost,
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: devServerHost,
    // Any Host header (such as <host>.ts.net) only when opened up for another
    // device; on loopback Vite's default host check stays on.
    ...(isLoopbackHost(devServerHost) ? {} : { allowedHosts: true as const }),
    proxy: apiProxy,
  },
}));
