import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LIVE_DESIGN_VARIANT_COUNT } from "@greatstone/shared";
import {
  acceptLiveDesign,
  discardLiveDesign,
  isLiveDesignAgentConnected,
  LiveDesignConflict,
  requestLiveDesign,
  steerLiveDesign,
  type LiveDesignSession,
} from "./live-design.js";

/**
 * GSAM stands in for Impeccable's local live helper (github.com/pbakaus/impeccable,
 * Apache-2.0, vendored in built-ins/impeccable by scripts/update-impeccable.mjs).
 *
 * Impeccable's page scripts run unchanged inside the attachment sandbox. A small
 * adapter in front of them turns their calls to http://localhost:<port>/... and
 * their EventSource into postMessage to the editor, which relays them here. So
 * the page tools work on any device that reaches GSAM, with no network access
 * from the page itself.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIRS = [path.resolve(moduleDir, "../built-ins/impeccable"), path.resolve(moduleDir, "../../src/built-ins/impeccable")];

/** Every helper endpoint the vendored scripts call; update-impeccable.mjs lists them for comparison. */
export const KNOWN_ENDPOINTS = [
  "/agent-target-claim",
  "/agent-target-result",
  "/annotation",
  "/design-system.json",
  "/design-system/raw",
  "/detect.js",
  "/events",
  "/manual-edit-commit",
  "/manual-edit-discard",
  "/manual-edit-repair-decision",
  "/manual-edit-stash",
  "/modern-screenshot.js",
  "/source",
  "/status",
] as const;

// Any non-empty port works: the adapter catches the URL before the network does.
const FAKE_PORT = 47_123;

let cached: string | null = null;

function readVendor(file: string) {
  for (const dir of VENDOR_DIRS) {
    try {
      return readFileSync(path.join(dir, file), "utf8");
    } catch {
      // Try the next location (dist, then source in dev).
    }
  }
  throw new Error(`Vendored Impeccable file missing: ${file}`);
}

/** Runs in the page before Impeccable's scripts. Treats everything from the parent as untrusted. */
const ADAPTER = String.raw`(function () {
  var BASE = "http://localhost:" + __PORT__ + "/";
  var pending = {}, rid = 0, streams = [], lastClicks = [], picked = {};
  function post(msg) { msg.source = "gs-impeccable"; window.parent.postMessage(msg, "*"); }

  // Remember what John clicked, to find the element Impeccable picked when it asks for versions.
  document.addEventListener("click", function (e) {
    var el = e.target;
    lastClicks = [];
    while (el && el.nodeType === 1 && el !== document.body) { lastClicks.push(el); el = el.parentElement; }
  }, true);
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id) { parts.unshift("#" + CSS.escape(el.id)); break; }
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return parts.join(" > ") || "body";
  }
  function findPicked(ctx) {
    if (!ctx) return null;
    var same = function (el) { return el.outerHTML === ctx.outerHTML; };
    var hit = lastClicks.filter(same)[0];
    if (hit) return hit;
    var all = document.getElementsByTagName(ctx.tagName || "*");
    for (var i = 0; i < all.length; i++) if (same(all[i])) return all[i];
    return lastClicks[0] || null;
  }

  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf(BASE) !== 0) return realFetch.apply(this, arguments);
    var body = init && init.body;
    var method = (init && init.method) || "GET";
    var extra = {};
    if (typeof body === "string" && url.indexOf(BASE + "events") === 0) {
      try {
        var evt = JSON.parse(body);
        if (evt.type === "generate") {
          var el = findPicked(evt.element);
          if (el) { picked[evt.id] = el; extra.selector = selectorOf(el); }
        }
      } catch (e) { /* the helper stand-in rejects bad bodies */ }
    }
    var id = ++rid;
    return new Promise(function (resolve) {
      pending[id] = resolve;
      post({
        kind: "request", rid: id, method: method,
        path: url.slice(BASE.length - 1),
        body: typeof body === "string" ? body.slice(0, 200000) : null,
        extra: extra,
      });
    });
  };

  function FakeEventSource() {
    var self = this;
    self.readyState = 0;
    self.onopen = self.onmessage = self.onerror = null;
    self.close = function () { self.readyState = 2; streams = streams.filter(function (s) { return s !== self; }); };
    streams.push(self);
    post({ kind: "stream-open" });
  }
  window.EventSource = FakeEventSource;

  // Versions arrive as Impeccable's own wrapper; the live element moves into the "original" slot.
  function insertVariants(id, html) {
    var el = picked[id];
    if (!el || !el.isConnected) return;
    var t = document.createElement("template");
    t.innerHTML = String(html);
    var wrapper = t.content.firstElementChild;
    if (!wrapper) return;
    var slot = wrapper.querySelector('[data-impeccable-variant="original"]');
    el.parentNode.replaceChild(wrapper, el);
    if (slot) slot.appendChild(el);
    delete picked[id];
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || !e.data || e.data.source !== "gs-impeccable-host") return;
    var m = e.data;
    if (m.kind === "response" && pending[m.rid]) {
      var resolve = pending[m.rid];
      delete pending[m.rid];
      resolve(new Response(m.body == null ? "" : String(m.body), {
        status: m.status || 200,
        headers: { "content-type": m.contentType || "application/json" },
      }));
    } else if (m.kind === "stream" && m.data) {
      var data = m.data;
      if (data.type === "done" && typeof data.gsVariantsHtml === "string") {
        insertVariants(data.id, data.gsVariantsHtml);
        delete data.gsVariantsHtml;
      }
      streams.forEach(function (s) {
        if (s.readyState === 0) { s.readyState = 1; if (s.onopen) s.onopen({}); }
        if (s.onmessage) s.onmessage({ data: JSON.stringify(data) });
      });
    } else if (m.kind === "stream-error") {
      streams.forEach(function (s) { if (s.onerror) s.onerror({}); });
    }
  });
})();`;

/** Impeccable's page scripts with GSAM's adapter in front, ready to inline in a page. */
export function impeccableLiveScript() {
  if (cached) return cached;
  const globals = JSON.parse(readVendor("globals.json")) as Record<string, unknown>;
  const head = [
    `window.__IMPECCABLE_TOKEN__ = "gsam";`,
    `window.__IMPECCABLE_PORT__ = ${FAKE_PORT};`,
    `window.__IMPECCABLE_APP_ROOT__ = "";`,
    `window.__IMPECCABLE_COMMAND_PREFIX__ = "/";`,
    ...Object.entries(globals).map(([k, v]) => `window.${k} = ${JSON.stringify(v)};`),
    `window.__IMPECCABLE_PROJECT_IGNORES__ = ${JSON.stringify({ ignoreRules: [], ignoreValues: [], ignoreFiles: [], roots: [""], pageFiles: [] })};`,
  ].join("\n");
  cached = `${ADAPTER.replace("__PORT__", String(FAKE_PORT))}\n${head}\n${readVendor("live-browser.js")}`.replace(/<\/script/gi, "<\\/script");
  return cached;
}

/** The page with Impeccable's live tools inside, in place of GSAM's own review bridge. */
export function injectImpeccableLive(html: string) {
  const script = `<script>${impeccableLiveScript()}</script>`;
  const end = html.search(/<\/body>/i);
  return end >= 0 ? html.slice(0, end) + script + html.slice(end) : html + script;
}

export interface HelperRequest {
  method: string;
  path: string;
  body: string | null;
  extra?: { selector?: string };
}

export interface HelperResponse {
  status: number;
  body: string;
  contentType?: string;
}

const json = (status: number, value: unknown): HelperResponse => ({ status, body: JSON.stringify(value) });
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/** One call from the page's Impeccable scripts, answered the way Impeccable's helper would. */
export function handleImpeccableRequest(s: LiveDesignSession, req: HelperRequest): HelperResponse {
  const route = req.path.split("?")[0] ?? "";
  if (route === "/status") {
    return json(200, { agentPolling: isLiveDesignAgentConnected(s), activeSessions: [] });
  }
  if (route === "/events" && req.method === "POST") {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(req.body ?? "") as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    try {
      return handleEvent(s, evt, req.extra ?? {});
    } catch (err) {
      if (err instanceof LiveDesignConflict) return json(409, { error: err.message });
      throw err;
    }
  }
  if (route === "/manual-edit-stash" && req.method === "GET") return json(200, { count: 0, pendingCount: 0 });
  if (route.startsWith("/manual-edit")) {
    return json(501, { error: "Direct text edits are not in GSAM yet. Ask the agent in the chat instead." });
  }
  if (route === "/annotation") return json(200, { ok: true, path: null });
  if (route === "/design-system.json") return json(200, { present: false });
  if (route === "/agent-target-claim") return json(200, { granted: false, pending: false });
  if (route === "/agent-target-result") return json(200, { ok: true });
  return json(404, { error: "not_available_in_gsam" });
}

function handleEvent(s: LiveDesignSession, evt: Record<string, unknown>, extra: { selector?: string }): HelperResponse {
  const id = str(evt.id, 64);
  switch (evt.type) {
    case "generate": {
      const el = (evt.element ?? {}) as Record<string, unknown>;
      const prompt = str(evt.freeformPrompt, 2000).trim();
      const action = str(evt.action, 40) || "impeccable";
      const tag = str(el.tagName, 40) || "element";
      const text = str(el.textContent, 300).replace(/\s+/g, " ").trim();
      requestLiveDesign(
        s,
        {
          selector: str(extra.selector, 500) || str(el.anchor, 500) || tag,
          tag,
          label: text ? `${tag}: “${text.slice(0, 48)}”` : tag,
          text,
          html: str(el.outerHTML, 20_000),
          prompt: prompt || (action === "impeccable" ? "Improve this" : `Apply ${action}`),
          action,
          count: Math.min(Math.max(Number(evt.count) || LIVE_DESIGN_VARIANT_COUNT, 1), 8),
        },
        id,
      );
      return json(200, { ok: true });
    }
    case "accept": {
      const variant = Number(evt.variantId) - 1;
      const params = evt.paramValues && typeof evt.paramValues === "object" ? (evt.paramValues as Record<string, unknown>) : null;
      acceptLiveDesign(s, id, variant, params);
      return json(200, { ok: true });
    }
    case "discard":
      if (s.request?.id === id) discardLiveDesign(s);
      return json(200, { ok: true });
    case "steer":
      steerLiveDesign(s, str(evt.message, 2000));
      return json(200, { ok: true });
    default:
      // checkpoint, variant_mounted, variant_mount_failed, exit, prefetch: nothing for GSAM to do.
      return json(200, { ok: true });
  }
}
