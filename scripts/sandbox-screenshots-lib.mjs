// Pure helpers for scripts/sandbox-screenshots.mjs: argument parsing, route
// resolution and the index files. No I/O beyond reading a routes JSON file, so
// node --test can cover them without a server or a browser.
import fs from "node:fs";
import path from "node:path";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

// Key pages of the board, relative to the company prefix. Placeholders are
// filled from the seeded demo data: {issue} is an issue identifier, {agent} an
// agent id and {project} a project id.
export const DEFAULT_ROUTES = [
  "dashboard",
  "issues",
  "issues/{issue}",
  "agents/all",
  "agents/{agent}",
  "projects",
  "inbox/mine",
  "company/settings",
];

// Mounted outside the company prefix (GLOBAL_ROUTE_ROOTS in
// ui/src/lib/company-routes.ts).
export const GLOBAL_ROUTE_ROOTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs", "instance"]);

// The UI keeps the theme in localStorage under this key (ui/index.html and
// ui/src/context/ThemeContext.tsx) with the values "light" and "dark".
export const THEME_STORAGE_KEY = "paperclip.theme";

export const USAGE = `Usage: pnpm screenshots [options]

Starts an isolated sandbox (pnpm dev:once --data-dir ./tmp/screenshots-<stamp>),
seeds demo data through the API, captures each route at desktop (1440x900) and
phone (390x844) width and always stops the sandbox it started.

Options:
  --routes LIST        Comma separated routes, for example "dashboard,issues/{issue}"
  --routes-file FILE   JSON array of routes (same form as --routes)
  --out DIR            Output folder (default: ./tmp/screenshots/<stamp>)
  --data-dir DIR       Sandbox data dir (default: ./tmp/screenshots-<stamp>, removed afterwards)
  --keep-data          Keep the sandbox data dir after the run
  --light / --dark     Capture only that theme (default: both)
  --viewports LIST     desktop, phone or both (default: desktop,phone)
  --base-url URL       Capture an already running sandbox instead of starting one
                       (no seeding unless --seed; never point this at the live app)
  --seed               Seed demo data when --base-url is given
  --port N             Port for the sandbox (default: the first free port from 3300)
  --scale N            Device scale factor (default: 1)
  --attach ISSUE_ID    Upload the captures to that issue with the artifact helper
                       when GSAM_API_URL, GSAM_API_KEY, GSAM_RUN_ID and GSAM_COMPANY_ID are set
  --help               Show this help

Routes are relative to the company prefix unless they start with a global root
(${[...GLOBAL_ROUTE_ROOTS].join(", ")}). Placeholders: {issue}, {agent}, {project}.`;

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function splitList(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function readRoutesFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.routes;
  if (!Array.isArray(list) || !list.every((route) => typeof route === "string")) {
    throw new Error(`${file} must hold a JSON array of route strings (or {"routes": [...]})`);
  }
  return list;
}

export function parseArgs(argv, { readFile = readRoutesFile } = {}) {
  const options = {
    routes: null,
    out: null,
    dataDir: null,
    keepData: false,
    themes: ["light", "dark"],
    viewports: ["desktop", "phone"],
    baseUrl: null,
    seed: null,
    port: null,
    scale: 1,
    attach: null,
    help: false,
  };
  const themes = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const arg = eq > 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = takeValue(argv, index, arg);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--routes":
        options.routes = splitList(value());
        break;
      case "--routes-file":
        options.routes = readFile(value());
        break;
      case "--out":
        options.out = value();
        break;
      case "--data-dir":
        options.dataDir = value();
        break;
      case "--keep-data":
        options.keepData = true;
        break;
      case "--light":
        themes.add("light");
        break;
      case "--dark":
        themes.add("dark");
        break;
      case "--viewports": {
        const list = splitList(value());
        for (const name of list) {
          if (!VIEWPORTS[name]) throw new Error(`unknown viewport "${name}" (use desktop or phone)`);
        }
        if (list.length === 0) throw new Error("--viewports needs at least one viewport");
        options.viewports = [...new Set(list)];
        break;
      }
      case "--base-url":
        options.baseUrl = value().replace(/\/+$/, "");
        break;
      case "--seed":
        options.seed = true;
        break;
      case "--port": {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024..65535");
        options.port = port;
        break;
      }
      case "--scale": {
        const scale = Number(value());
        if (!(scale >= 1 && scale <= 3)) throw new Error("--scale must be between 1 and 3");
        options.scale = scale;
        break;
      }
      case "--attach":
        options.attach = value();
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  if (themes.size > 0) options.themes = ["light", "dark"].filter((theme) => themes.has(theme));
  if (options.routes && options.routes.length === 0) throw new Error("no routes given");
  if (options.baseUrl && (options.dataDir || options.port)) {
    throw new Error("--base-url captures a running server; --data-dir and --port only apply to a sandbox it starts");
  }
  // A sandbox we start is always seeded; a running one only on request.
  if (options.seed === null) options.seed = !options.baseUrl;
  return options;
}

/**
 * Turns a route into an absolute path. Company relative routes get
 * /<PREFIX>/, global roots and routes already carrying the prefix do not.
 * Placeholders that the seed could not fill make the route unresolvable.
 */
export function resolveRoute(route, { companyPrefix, ids = {} }) {
  let missing = null;
  const filled = route.trim().replace(/\{(\w+)\}/g, (match, name) => {
    const value = ids[name];
    if (value === undefined || value === null || value === "") {
      missing ??= name;
      return match;
    }
    return encodeURIComponent(String(value));
  });
  if (missing) return { route, path: null, error: `no seeded value for {${missing}}` };
  const [pathPart, ...rest] = filled.split(/(?=[?#])/);
  const segments = pathPart.split("/").filter(Boolean);
  const suffix = rest.join("");
  const first = segments[0] ?? "";
  const prefix = companyPrefix ? String(companyPrefix).toUpperCase() : null;
  const isGlobal = GLOBAL_ROUTE_ROOTS.has(first.toLowerCase());
  const hasPrefix = prefix !== null && first.toUpperCase() === prefix;
  if (isGlobal || hasPrefix || !prefix) {
    return { route, path: `/${segments.join("/")}${suffix}`, error: null };
  }
  return { route, path: `/${[prefix, ...segments].join("/")}${suffix}`, error: null };
}

export function routeSlug(route) {
  const slug = route
    .toLowerCase()
    .replace(/[{}]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

export function shotFileName(route, viewport, theme) {
  return `${routeSlug(route)}--${viewport}--${theme}.png`;
}

export function buildIndexMarkdown({ title, baseUrl, generatedAt, shots, skipped }) {
  const lines = [`# ${title}`, "", `Captured ${generatedAt} from ${baseUrl}.`, ""];
  lines.push("| Route | Path | Viewport | Theme | File | Console errors |", "| --- | --- | --- | --- | --- | --- |");
  for (const shot of shots) {
    lines.push(
      `| ${shot.route} | ${shot.path} | ${shot.viewport} | ${shot.theme} | [${shot.file}](${shot.file}) | ${shot.error ? `failed: ${shot.error}` : shot.consoleErrors} |`,
    );
  }
  if (skipped.length > 0) {
    lines.push("", "Skipped routes:", "");
    for (const item of skipped) lines.push(`- ${item.route}: ${item.error}`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

export function buildContactSheetHtml({ title, baseUrl, generatedAt, shots }) {
  const byRoute = new Map();
  for (const shot of shots) {
    if (!byRoute.has(shot.route)) byRoute.set(shot.route, []);
    byRoute.get(shot.route).push(shot);
  }
  const sections = [...byRoute.entries()]
    .map(([route, list]) => {
      const figures = list
        .map((shot) =>
          shot.error
            ? `<figure class="failed"><figcaption>${escapeHtml(shot.viewport)} ${escapeHtml(shot.theme)}: failed (${escapeHtml(shot.error)})</figcaption></figure>`
            : `<figure class="${escapeHtml(shot.viewport)}"><a href="${escapeHtml(shot.file)}"><img src="${escapeHtml(shot.file)}" alt="${escapeHtml(`${route} ${shot.viewport} ${shot.theme}`)}" loading="lazy"></a><figcaption>${escapeHtml(shot.viewport)} ${escapeHtml(shot.theme)}, console errors: ${shot.consoleErrors}</figcaption></figure>`,
        )
        .join("\n");
      return `<section><h2>${escapeHtml(route)} <code>${escapeHtml(list[0].path ?? "")}</code></h2><div class="row">${figures}</div></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f6f6f6;color:#111}
h1{font-size:20px}h2{font-size:16px;margin:24px 0 8px}code{font-size:12px;color:#555}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
figure{margin:0;background:#fff;border:1px solid #ddd;padding:6px}
figure.desktop img{width:480px}figure.phone img{width:160px}img{display:block;height:auto}
figcaption{font-size:12px;color:#555;margin-top:4px}figure.failed{color:#a00}
</style></head><body>
<h1>${escapeHtml(title)}</h1><p>Captured ${escapeHtml(generatedAt)} from ${escapeHtml(baseUrl)}.</p>
${sections}
</body></html>
`;
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

export function resolveFromRoot(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}
