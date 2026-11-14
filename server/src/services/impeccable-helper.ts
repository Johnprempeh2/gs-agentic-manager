import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { LIVE_DESIGN_VARIANT_COUNT } from "@greatstone/shared";
import {
  acceptLiveDesign,
  applyLiveDesignEdits,
  discardLiveDesign,
  discardLiveDesignEdits,
  liveDesignEditCount,
  stageLiveDesignEdit,
  isLiveDesignAgentConnected,
  liveDesignMarkupFor,
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
  // GSAM starts a new session each time the editor opens and forgets old ones on a restart, so a
  // checkpoint Impeccable saved earlier names a session nothing will answer: it would lock the picker.
  try { window.localStorage.removeItem("impeccable-live-session"); } catch (e) { /* storage denied */ }
  var pending = {}, rid = 0, streams = [], lastClicks = [], picked = {};
  function post(msg) { msg.source = "gs-impeccable"; window.parent.postMessage(msg, "*"); }

  // Cmd or Ctrl Z with the page focused: the editor undoes the last edit not saved yet (Shift, or Ctrl Y, redoes).
  // Never while typing in the page, where the browser's own undo belongs.
  document.addEventListener("keydown", function (e) {
    var key = String(e.key || "").toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || e.altKey || (key !== "z" && !(key === "y" && e.ctrlKey && !e.metaKey))) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    e.preventDefault();
    post({ kind: "history", redo: key === "y" || e.shiftKey });
  }, true);

  // Remember what John clicked, to find the element Impeccable picked when it asks for versions.
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (el && el.closest && el.closest("[id^='impeccable'], [data-impeccable-ui]")) return;
    lastClicks = [];
    while (el && el.nodeType === 1 && el !== document.body) { lastClicks.push(el); el = el.parentElement; }
    pickedEl = e.target;
    setLocked(lockedPart(e.target));
  }, true);

  // A part an island renders (the Two Doors landing on /) is built in the site's code, so a removal or
  // a text edit there could never save. Pick does not offer them, and the editor says why, before anything.
  // Its words are the exception: text the site marks data-gs-field (and data-gs-toggle, a part that can be
  // hidden) is editable from here, and GSAM saves it into the island (the landing's data-copy).
  var pickedEl = null;
  function wordsOf(el) {
    if (!el || !el.closest) return null;
    var toggle = el.closest("[data-gs-toggle]");
    var field = el.closest("[data-gs-field]");
    if (!toggle && !field) return null;
    return { toggle: toggle ? toggle.getAttribute("data-gs-toggle") : null, field: field ? field.getAttribute("data-gs-field") : null, toggleEl: toggle, fieldEl: field, el: toggle || field };
  }
  function lockedPart(el) {
    var hit = el && el.closest ? el.closest("[data-gs-island], gs-island") : null;
    if (!hit || wordsOf(el)) return null;
    return hit.getAttribute("data-gs-island-label") || String(hit.getAttribute("data-gs-island") || hit.getAttribute("name") || "island").replace(/-/g, " ");
  }
  var locked = null;
  function setLocked(label) {
    locked = label;
    if (label) document.documentElement.setAttribute("data-gs-locked-pick", "");
    else document.documentElement.removeAttribute("data-gs-locked-pick");
    post({ kind: "locked-pick", label: label });
  }
  var lockStyle = document.createElement("style");
  lockStyle.textContent = "html[data-gs-locked-pick] #impeccable-live-edit-badge button[aria-label='Remove element'],html[data-gs-locked-pick] #impeccable-live-edit-badge button[aria-label='Edit copy']{display:none!important}";
  (document.head || document.documentElement).appendChild(lockStyle);
  // Delete and Backspace remove the picked element too.
  document.addEventListener("keydown", function (e) {
    if (locked && (e.key === "Delete" || e.key === "Backspace") && !(e.target && e.target.isContentEditable) && !/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || "")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      post({ kind: "locked-pick", label: locked });
    }
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

  // Impeccable expects to be the whole page and pulls focus back to its own box whenever it
  // loses it. Inside GSAM's editor that would steal typing from the chat beside it, so the
  // page may move focus only while John is working inside the page.
  window.focus = function () {};
  var realFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function () {
    if (!document.hasFocus()) return;
    return realFocus.apply(this, arguments);
  };

  // Tell the editor whether the page shows anything. A page that pulls its code or styles from
  // the internet stays blank or bare in the sandbox (no network), and John should know why.
  function pageHealth() {
    var ours = function (n) { return n.closest && n.closest("[id^='impeccable'], [data-impeccable-ui]"); };
    var visible = 0;
    var all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && visible < 3; i++) {
      var n = all[i];
      if (ours(n) || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var hasText = Array.prototype.some.call(n.childNodes, function (c) { return c.nodeType === 3 && c.textContent.trim(); });
      if (hasText || /^(IMG|SVG|CANVAS|VIDEO|svg)$/.test(n.tagName)) visible++;
    }
    var remote = function (sel, attr) {
      return Array.prototype.filter.call(document.querySelectorAll(sel), function (n) { return /^(https?:)?\/\//i.test(n.getAttribute(attr) || ""); })
        .map(function (n) { try { return new URL(n.getAttribute(attr), "https://x").host; } catch (e) { return ""; } });
    };
    post({ kind: "page-health", blank: visible === 0, scripts: remote("script[src]", "src").slice(0, 5), styles: remote("link[rel~=stylesheet][href]", "href").slice(0, 5) });
  }
  window.addEventListener("load", function () { setTimeout(pageHealth, 1200); });

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
        if (evt.type === "generate" && evt.mode === "insert" && evt.insert) {
          // Insert: the new element replaces Impeccable's dotted placeholder; the anchor stays.
          var holder = document.querySelector("[data-impeccable-insert-placeholder]");
          var anchor = findPicked(evt.insert.anchor);
          if (holder) picked[evt.id] = holder;
          if (anchor) extra.selector = selectorOf(anchor);
          extra.position = evt.insert.position === "before" ? "before" : "after";
        } else if (evt.type === "generate") {
          var el = findPicked(evt.element);
          if (el) { picked[evt.id] = el; extra.selector = selectorOf(el); }
        }
      } catch (e) { /* the helper stand-in rejects bad bodies */ }
    }
    // Last guard: an edit on a locked part never stages, so it can never look saved.
    if (locked && url.indexOf(BASE + "manual-edit-stash") === 0 && method === "POST") {
      post({ kind: "locked-pick", label: locked });
      return Promise.resolve(new Response(JSON.stringify({ error: "This part is locked" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    }
    // Edits on the island's words: name the field each op changes, so GSAM saves it into the island.
    var words = wordsOf(pickedEl);
    if (words && url.indexOf(BASE + "manual-edit-stash") === 0 && method === "POST" && typeof body === "string") {
      try {
        var stash = JSON.parse(body);
        var norm = function (t) { return String(t || "").replace(/\s+/g, " ").trim(); };
        (stash.ops || []).forEach(function (op) {
          if (op.removeElement) {
            // The innermost marked part Impeccable removed (a field, or the toggle around it), never a wider selection.
            var tag = String(op.tag || "");
            var inner = [words.fieldEl, words.toggleEl].filter(Boolean).sort(function (x, y) { return x.contains(y) ? 1 : -1; });
            var hitEl = inner.filter(function (n) { return n.tagName.toLowerCase() === tag; })[0];
            if (hitEl && hitEl === words.toggleEl) op.islandToggle = words.toggle;
            else if (hitEl) op.islandField = words.field;
            return;
          }
          var fields = [words.el].concat(Array.prototype.slice.call(words.el.querySelectorAll("[data-gs-field]")));
          var hit = fields.filter(function (f) { return f.hasAttribute("data-gs-field") && norm(f.textContent) === norm(op.originalText); })[0];
          if (hit) op.islandField = hit.getAttribute("data-gs-field");
        });
        body = JSON.stringify(stash);
      } catch (e) { /* the helper stand-in rejects bad bodies */ }
    }
    var id = ++rid;
    var path = url.slice(BASE.length - 1);
    // Binary bodies (the annotation screenshot) travel as base64.
    var encoded = body instanceof Blob
      ? new Promise(function (done) {
          var r = new FileReader();
          r.onload = function () { done(String(r.result).replace(/^data:[^,]*,/, "")); };
          r.onerror = function () { done(null); };
          r.readAsDataURL(body);
        })
      : Promise.resolve(null);
    return encoded.then(function (b64) {
      return new Promise(function (resolve) {
        pending[id] = resolve;
        var msg = { kind: "request", rid: id, method: method, path: path, body: typeof body === "string" ? body.slice(0, 200000) : null, extra: extra };
        if (b64) msg.bodyBase64 = b64;
        post(msg);
      });
    });
  };

  // Voice: the sandbox has no microphone, so speech runs in the GSAM editor and streams back here.
  var voices = {}, vid = 0;
  function RelayedRecognition() {
    var self = this;
    self.id = ++vid;
    self.lang = "en-GB";
    self.continuous = false;
    self.interimResults = false;
    self.maxAlternatives = 1;
    self.onstart = self.onresult = self.onerror = self.onend = null;
    voices[self.id] = self;
    self.start = function () { post({ kind: "voice-start", vid: self.id, lang: String(self.lang || ""), interim: !!self.interimResults }); };
    self.stop = function () { post({ kind: "voice-stop", vid: self.id }); };
    self.abort = function () { post({ kind: "voice-stop", vid: self.id, abort: true }); };
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = RelayedRecognition;

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
    var t0 = document.createElement("template");
    t0.innerHTML = String(html);
    var next = t0.content.firstElementChild;
    // Revised versions (John commented on one): swap them into the open wrapper, keeping which one shows.
    var open = next && Array.prototype.find.call(document.querySelectorAll("[data-impeccable-variants]"), function (w) { return w.getAttribute("data-impeccable-variants") === String(id); });
    if (open) {
      var olds = open.querySelectorAll(':scope > [data-impeccable-variant]:not([data-impeccable-variant="original"]), :scope > style[data-impeccable-css]');
      var shown = {};
      Array.prototype.forEach.call(olds, function (o) { if (o.hasAttribute("data-impeccable-variant")) shown[o.getAttribute("data-impeccable-variant")] = o.style.display; o.remove(); });
      Array.prototype.slice.call(next.children).forEach(function (c) {
        if (c.getAttribute("data-impeccable-variant") === "original") return;
        var n = c.getAttribute("data-impeccable-variant");
        if (n && n in shown) c.style.display = shown[n];
        open.appendChild(c);
      });
      open.setAttribute("data-impeccable-variant-count", next.getAttribute("data-impeccable-variant-count") || "");
      return;
    }
    var el = picked[id];
    if (!el || !el.isConnected) return;
    var t = document.createElement("template");
    t.innerHTML = String(html);
    var wrapper = t.content.firstElementChild;
    if (!wrapper) return;
    var slot = wrapper.querySelector('[data-impeccable-variant="original"]');
    el.parentNode.replaceChild(wrapper, el);
    // Insert mode has no original: the placeholder simply gives way.
    if (slot && wrapper.getAttribute("data-impeccable-mode") !== "insert") slot.appendChild(el);
    delete picked[id];
  }

  // Editing off: Impeccable stops picking and its chrome hides, so the page takes clicks
  // (slides, menus, forms). On: the chrome returns and picking resumes.
  function toggleBtn(id, want) {
    var btn = document.getElementById("impeccable-live-" + id + "-toggle");
    if (btn && (btn.dataset.active === "true") !== want) btn.click();
  }
  function setEditing(on) {
    var style = document.getElementById("gs-editing-off");
    if (on) {
      if (style) style.remove();
      toggleBtn("pick", true);
    } else {
      toggleBtn("pick", false);
      toggleBtn("insert", false);
      if (!style) {
        style = document.createElement("style");
        style.id = "gs-editing-off";
        style.textContent = '[id^="impeccable-live"]{display:none!important}';
        document.head.appendChild(style);
      }
    }
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
    } else if (m.kind === "voice" && voices[m.vid]) {
      var rec = voices[m.vid];
      if (m.event === "start" && rec.onstart) rec.onstart({});
      if (m.event === "result" && rec.onresult) {
        var results = (m.transcripts || []).map(function (t) { var alt = [{ transcript: String(t), confidence: 1 }]; alt.isFinal = !!m.final; return alt; });
        rec.onresult({ results: results, resultIndex: 0 });
      }
      if (m.event === "error" && rec.onerror) rec.onerror({ error: String(m.error || "unknown") });
      if (m.event === "end") { if (rec.onend) rec.onend({}); delete voices[m.vid]; }
    } else if (m.kind === "stream-error") {
      streams.forEach(function (s) { if (s.onerror) s.onerror({}); });
    } else if (m.kind === "editing") {
      setEditing(m.on !== false);
    }
  });
})();`;

const IMPECCABLE_DEFAULT_COUNT = "let selectedCount = 3;";

/**
 * One version per request unless John asks for more with Impeccable's count control (John, 14 Nov:
 * "propose one draft, offer alternatives only when asked"). Impeccable's own default is three; a vendor
 * update that renames it fails loudly here instead of quietly going back to three.
 */
export function oneVersionByDefault(script: string) {
  if (!script.includes(IMPECCABLE_DEFAULT_COUNT)) throw new Error("Impeccable's default version count moved: update oneVersionByDefault");
  return script.replace(IMPECCABLE_DEFAULT_COUNT, `let selectedCount = ${LIVE_DESIGN_VARIANT_COUNT};`);
}

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
  // modern-screenshot (MIT) inline, so Impeccable never tries to load it over the network.
  cached = `${ADAPTER.replace("__PORT__", String(FAKE_PORT))}\n${readVendor("modern-screenshot.umd.js")}\n${head}\n${oneVersionByDefault(readVendor("live-browser.js"))}`.replace(/<\/script/gi, "<\\/script");
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
  extra?: { selector?: string; position?: "before" | "after" };
  /** For /annotation: the saved screenshot's attachment id, set by the route. */
  screenshotAttachmentId?: string;
  /** The person making the request, set by the route: their edits not saved yet are kept under their name. */
  userId?: string | null;
}

export interface HelperResponse {
  status: number;
  body: string;
  contentType?: string;
}

const json = (status: number, value: unknown): HelperResponse => ({ status, body: JSON.stringify(value) });
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

function parseBody(body: string | null): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body ?? "") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The YAML frontmatter of a DESIGN.md as Impeccable's panel reads it, or null when there is none or it does not parse. */
export function designFrontmatter(markdown: string): { frontmatter: Record<string, unknown> } | null {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const data = parseYaml(m[1] ?? "", { maxAliasCount: 50 }) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? { frontmatter: data as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}


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
  try {
    if (route === "/manual-edit-stash" && req.method === "GET") {
      const count = liveDesignEditCount(s);
      return json(200, { count, pendingCount: count });
    }
    if (route === "/manual-edit-stash") {
      const body = parseBody(req.body);
      const ops = Array.isArray(body?.ops) ? (body.ops as Array<Record<string, unknown>>) : [];
      if (!ops.length) return json(400, { error: "no edits" });
      const element = body?.element && typeof body.element === "object" ? (body.element as Record<string, unknown>) : null;
      return json(200, stageLiveDesignEdit(s, { id: str(body?.id, 64) || "edit", element, ops, userId: req.userId ?? null }));
    }
    if (route === "/manual-edit-discard") {
      const ref = new URLSearchParams(req.path.split("?")[1] ?? "").get("ref");
      return json(200, discardLiveDesignEdits(s, ref || null));
    }
    if (route === "/manual-edit-commit") {
      const result = applyLiveDesignEdits(s);
      return json(result.status === "started" ? 202 : 200, result.status === "started" ? result : { applied: [], cleared: 0, remainingCount: 0 });
    }
    if (route === "/manual-edit-repair-decision") {
      // GSAM never writes the source itself, so there is nothing to roll back: the edits stay staged.
      return json(200, { ok: true, remainingCount: liveDesignEditCount(s) });
    }
  } catch (err) {
    if (err instanceof LiveDesignConflict) return json(409, { error: err.message });
    throw err;
  }
  if (route === "/annotation") return json(200, { ok: true, path: req.screenshotAttachmentId ?? null });
  if (route === "/design-system.json") {
    if (!s.designMd) return json(200, { present: false });
    // The DESIGN.md frontmatter tokens drive Impeccable's Visual tab (swatches, type); there is no sidecar in GSAM.
    const parsed = designFrontmatter(s.designMd);
    return json(200, { present: true, hasMd: true, hasSidecar: true, parsed, sidecar: null });
  }
  if (route === "/design-system/raw") {
    return s.designMd ? { status: 200, body: s.designMd, contentType: "text/markdown; charset=utf-8" } : json(404, { error: "no DESIGN.md yet" });
  }
  if (route === "/agent-target-claim") return json(200, { granted: false, pending: false });
  if (route === "/agent-target-result") return json(200, { ok: true });
  return json(404, { error: "not_available_in_gsam" });
}

/** Impeccable's Accept, from a parsed event or an /events body: the request id, the kept version (from 0) and tune values. */
export function acceptOf(evt: Record<string, unknown> | string | null) {
  const body = typeof evt === "string" || evt === null ? parseBody(evt) : evt;
  if (!body || body.type !== "accept") return null;
  return {
    id: str(body.id, 64),
    variant: Number(body.variantId) - 1,
    paramValues: body.paramValues && typeof body.paramValues === "object" ? (body.paramValues as Record<string, unknown>) : null,
  };
}

function handleEvent(s: LiveDesignSession, evt: Record<string, unknown>, extra: { selector?: string; position?: "before" | "after" }): HelperResponse {
  const id = str(evt.id, 64) || randomUUID().slice(0, 8);
  switch (evt.type) {
    case "generate": {
      const inserting = evt.mode === "insert";
      const el = ((inserting ? (evt.insert as Record<string, unknown> | undefined)?.anchor : evt.element) ?? {}) as Record<string, unknown>;
      const prompt = str(evt.freeformPrompt, 2000).trim();
      const action = str(evt.action, 40) || "impeccable";
      const tag = str(el.tagName, 40) || "element";
      const text = str(el.textContent, 300).replace(/\s+/g, " ").trim();
      requestLiveDesign(
        s,
        {
          selector: str(extra.selector, 500) || str(el.anchor, 500) || tag,
          tag,
          label: (inserting ? `a new element ${extra.position ?? "after"} ` : "") + (text ? `${tag}: “${text.slice(0, 48)}”` : tag),
          text,
          html: str(el.outerHTML, 20_000),
          prompt: prompt || (action === "impeccable" ? "Improve this" : `Apply ${action}`),
          action,
          count: Math.min(Math.max(Number(evt.count) || LIVE_DESIGN_VARIANT_COUNT, 1), 8),
          notes: (Array.isArray(evt.comments) ? evt.comments : [])
            .map((c) => str((c as { text?: unknown })?.text, 1000).trim())
            .filter(Boolean)
            .slice(0, 30),
          // Only a screenshot GSAM itself saved for this Go, never an id the page made up.
          ...(liveDesignMarkupFor(s, id) ? { screenshotAttachmentId: liveDesignMarkupFor(s, id)! } : {}),
          ...(inserting ? { insert: { position: extra.position ?? "after" } } : {}),
        },
        id,
      );
      return json(200, { ok: true });
    }
    case "accept": {
      const accept = acceptOf(evt)!;
      acceptLiveDesign(s, accept.id, accept.variant, accept.paramValues);
      return json(200, { ok: true });
    }
    case "discard":
      if (s.request?.id === id) discardLiveDesign(s);
      return json(200, { ok: true });
    case "steer":
      steerLiveDesign(s, str(evt.message, 2000), id || null);
      return json(200, { ok: true });
    default:
      // checkpoint, variant_mounted, variant_mount_failed, exit, prefetch: nothing for GSAM to do.
      return json(200, { ok: true });
  }
}
