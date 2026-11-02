import type { Plugin } from "vite";

/**
 * Start a page's code at t=0 when the browser opens straight onto its URL.
 *
 * Since the page split (16 Oct) a cold task URL fetched the app, evaluated it,
 * and only then asked for the task page and its ~110 files, so the network sat
 * idle while the app started (GRE-3611). This plugin writes a tiny inline
 * script into index.html that, only on a matching URL, adds modulepreload links
 * for the page's files the app itself does not load. Modulepreload fetches and
 * parses without running anything, so module order is unchanged; every other
 * URL (the phone's first screen included) downloads exactly what it did before.
 */

type BundleChunk = { type: "chunk"; fileName: string; imports: string[]; isEntry: boolean; moduleIds: string[] };
type BundleItem = BundleChunk | { type: "asset"; fileName: string };

export type RoutePreload = {
  /** Source file of the page, matched against the end of a module id in its chunk. */
  page: string;
  /** URL paths that open on the page; same rule the app uses. */
  path: RegExp;
};

function staticClosure(start: string, chunks: Map<string, BundleChunk>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const fileName = stack.pop()!;
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    stack.push(...(chunks.get(fileName)?.imports ?? []));
  }
  return seen;
}

/** Files a page needs on top of the entry's own static imports, page chunk first. */
export function routePreloadFiles(bundle: Record<string, BundleItem>, page: string): string[] {
  const chunks = new Map<string, BundleChunk>();
  for (const item of Object.values(bundle)) if (item.type === "chunk") chunks.set(item.fileName, item);
  const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
  // Rolldown reports no facade for this chunk here, so find the one holding the page module.
  const pageChunk = [...chunks.values()].find((chunk) => chunk.moduleIds.some((id) => id.replace(/\\/g, "/").endsWith(page)));
  if (!entry || !pageChunk) throw new Error(`route preload: no ${entry ? `chunk for ${page}` : "entry chunk"} in the bundle`);
  const booted = staticClosure(entry.fileName, chunks);
  return [...staticClosure(pageChunk.fileName, chunks)].filter((fileName) => !booted.has(fileName));
}

export function routePreloadScript(routes: { path: RegExp; files: string[] }[], base: string): string {
  const table = JSON.stringify(routes.map((route) => [route.path.source, route.files]));
  return `<script>(function(){var r=${table},p=location.pathname;for(var i=0;i<r.length;i++)if(new RegExp(r[i][0]).test(p)){r[i][1].forEach(function(f){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=${JSON.stringify(base)}+f;document.head.appendChild(l)});return}})()</script>`;
}

export function routePreloadPlugin(routes: RoutePreload[]): Plugin {
  let base = "/";
  return {
    name: "gsam-route-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const bundle = ctx.bundle as unknown as Record<string, BundleItem>;
        const script = routePreloadScript(routes.map((route) => ({ path: route.path, files: routePreloadFiles(bundle, route.page) })), base);
        // After the entry's own modulepreload links, so the app's files queue first.
        return html.replace("</head>", `${script}\n</head>`);
      },
    },
  };
}
