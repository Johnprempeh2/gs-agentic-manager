import type { PrototypeReviewMarkup } from "@greatstone/shared";
import { enqueueScreenshot, loadChromium } from "./deliverable-links.js";
import { logger } from "../middleware/logger.js";

/**
 * Runs inside the agent's page, in the same opaque-origin sandbox as any
 * attachment. It talks to the GSAM window only by postMessage; the parent
 * treats everything it sends as untrusted input. With a preset state
 * (`window.__GS_REVIEW_STATE__`) it just draws the markup, for the server's
 * marked-up screenshot.
 */
const BRIDGE = String.raw`(function () {
  if (window.__gsReview) return;
  window.__gsReview = true;
  var NS = "http://www.w3.org/2000/svg";
  var preset = window.__GS_REVIEW_STATE__ || null;
  var mode = "browse";
  var state = preset || { pins: [], strokes: [], edits: [] };
  var applied = [];
  var root, svg, hover, catcher, drawing = null, editing = null;
  // Live design: the picked element, what is showing in its place, and that version's CSS.
  var picked = null, shown = null, liveStyle = null, selBox;

  function post(msg) { msg.source = "gs-review"; window.parent.postMessage(msg, "*"); }
  function size() {
    var d = document.documentElement, b = document.body;
    return { w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0), h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0) };
  }
  function ours(el) { return el && root && (el === root || root.contains(el)); }
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
  function textOf(el) { return ((el && el.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 300); }
  function find(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  function place(frame, el) {
    var r = el.getBoundingClientRect();
    frame.style.display = "block";
    frame.style.left = r.left + window.scrollX + "px";
    frame.style.top = r.top + window.scrollY + "px";
    frame.style.width = r.width + "px";
    frame.style.height = r.height + "px";
  }
  function box(el, color) {
    place(hover, el);
    hover.style.borderColor = color;
  }

  function describe(el) {
    return {
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: textOf(el),
      cls: (el.getAttribute("class") || "").slice(0, 200),
      // A link drawn as a pill or a filled box reads as a button to John.
      looksButton: (function () {
        var cs = getComputedStyle(el);
        return el.tagName === "A" && (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0) && parseFloat(cs.paddingLeft) >= 8;
      })(),
      role: el.getAttribute("role") || "",
      alt: (el.getAttribute("alt") || el.getAttribute("aria-label") || "").slice(0, 120),
      html: el.outerHTML.slice(0, 20000),
    };
  }
  function pick(el) {
    if (!el || el === document.body || el === document.documentElement || ours(el)) return;
    showVersion(null);
    picked = el;
    shown = el;
    place(selBox, el);
    var d = describe(el);
    d.type = "select";
    d.hasParent = !!(el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement);
    post(d);
  }
  // Swap a version in for the picked element, or put the original back (null).
  function showVersion(v) {
    if (liveStyle) { liveStyle.remove(); liveStyle = null; }
    if (!picked) return;
    var next = picked;
    if (v) {
      var t = document.createElement("template");
      t.innerHTML = String(v.html || "").trim();
      next = t.content.firstElementChild || picked;
      if (v.css) {
        liveStyle = document.createElement("style");
        liveStyle.setAttribute("data-gs-live", "");
        liveStyle.textContent = String(v.css);
        document.head.appendChild(liveStyle);
      }
    }
    if (next !== shown && shown && shown.parentNode) shown.parentNode.replaceChild(next, shown);
    shown = next;
    requestAnimationFrame(function () {
      if (!shown || !shown.isConnected) return;
      if (v) shown.scrollIntoView({ block: "nearest", behavior: "smooth" });
      place(selBox, shown);
      setTimeout(function () { if (shown && shown.isConnected) place(selBox, shown); }, 400);
    });
  }
  function clearPick() {
    showVersion(null);
    picked = shown = null;
    selBox.style.display = "none";
  }

  function render() {
    var s = size();
    svg.setAttribute("width", s.w);
    svg.setAttribute("height", s.h);
    catcher.style.width = s.w + "px";
    catcher.style.height = s.h + "px";
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    Array.prototype.forEach.call(root.querySelectorAll("[data-gs-pin]"), function (n) { n.remove(); });
    (state.strokes || []).forEach(function (st) {
      var p = document.createElementNS(NS, "polyline");
      p.setAttribute("points", st.points.map(function (pt) { return pt[0] + "," + pt[1]; }).join(" "));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", st.color);
      p.setAttribute("stroke-width", "4");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
    });
    (state.pins || []).forEach(function (pin, i) {
      var n = document.createElement("div");
      n.setAttribute("data-gs-pin", "");
      n.textContent = String(i + 1);
      n.style.cssText = "position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#c8ff00;color:#121212;font:700 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #121212,0 0 0 4px #fff,0 2px 8px rgba(0,0,0,.5);left:" + pin.x + "px;top:" + pin.y + "px";
      root.appendChild(n);
    });
    // Show text edits in place, marked so the reader can tell what changed.
    applied.forEach(function (a) { if (a.el.isConnected) { a.el.innerText = a.before; a.el.style.outline = a.outline; } });
    applied = [];
    (state.edits || []).forEach(function (ed) {
      var el = find(ed.selector);
      if (!el || el === editing) return;
      applied.push({ el: el, before: ed.before, outline: el.style.outline });
      el.innerText = ed.after;
      el.style.outline = "2px dashed #2a9d8f";
      el.style.outlineOffset = "2px";
    });
  }

  function setMode(next) {
    mode = next;
    hover.style.display = "none";
    catcher.style.pointerEvents = mode === "draw" ? "auto" : "none";
    catcher.style.cursor = mode === "draw" ? "crosshair" : "";
    document.documentElement.style.cursor = mode === "comment" || mode === "live" ? "crosshair" : mode === "edit" ? "text" : "";
  }

  function textTarget(el) {
    while (el && el !== document.body) {
      for (var i = 0; i < el.childNodes.length; i++) {
        var c = el.childNodes[i];
        if (c.nodeType === 3 && c.textContent.trim()) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function start() {
    root = document.createElement("div");
    root.setAttribute("data-gs-review", "");
    root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none";
    svg = document.createElementNS(NS, "svg");
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
    hover = document.createElement("div");
    hover.style.cssText = "position:absolute;display:none;border:2px solid #c8ff00;border-radius:3px;pointer-events:none";
    selBox = document.createElement("div");
    selBox.style.cssText = "position:absolute;display:none;outline:3px solid #c8ff00;outline-offset:2px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);border-radius:3px;pointer-events:none;transition:all .12s ease";
    catcher = document.createElement("div");
    catcher.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;touch-action:none";
    root.appendChild(svg);
    root.appendChild(hover);
    root.appendChild(selBox);
    root.appendChild(catcher);
    document.body.appendChild(root);
    render();
    if (preset) return;

    document.addEventListener("mousemove", function (e) {
      if ((mode !== "comment" && mode !== "edit" && mode !== "live") || ours(e.target)) return;
      var el = mode === "edit" ? textTarget(e.target) : e.target;
      if (el) box(el, mode === "edit" ? "#2a9d8f" : "#c8ff00"); else hover.style.display = "none";
    }, true);

    document.addEventListener("click", function (e) {
      if (mode === "browse" || mode === "draw" || ours(e.target)) return;
      if (mode === "edit" && editing && editing.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "live") {
        hover.style.display = "none";
        pick(e.target);
        return;
      }
      if (mode === "comment") {
        var el = e.target;
        post({ type: "pick", x: Math.round(e.pageX), y: Math.round(e.pageY), selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: textOf(el) });
        return;
      }
      var t = textTarget(e.target);
      if (!t) return;
      // Edit from the agent's original wording, not a previous edit shown in place.
      var prior = applied.filter(function (a) { return a.el === t; })[0];
      var before = prior ? prior.before : t.innerText;
      editing = t;
      t.contentEditable = "true";
      t.focus();
      t.addEventListener("blur", function done() {
        t.removeEventListener("blur", done);
        t.contentEditable = "false";
        editing = null;
        post({ type: "edit", selector: selectorOf(t), before: before.slice(0, 4000), after: t.innerText.slice(0, 4000) });
      });
    }, true);

    // Links and forms do nothing while reviewing.
    document.addEventListener("submit", function (e) { if (mode !== "browse") e.preventDefault(); }, true);

    catcher.addEventListener("pointerdown", function (e) {
      catcher.setPointerCapture(e.pointerId);
      drawing = document.createElementNS(NS, "polyline");
      drawing.setAttribute("fill", "none");
      drawing.setAttribute("stroke", "#ff4d4d");
      drawing.setAttribute("stroke-width", "4");
      drawing.setAttribute("stroke-linecap", "round");
      drawing.__pts = [[Math.round(e.pageX), Math.round(e.pageY)]];
      svg.appendChild(drawing);
    });
    catcher.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var pts = drawing.__pts, last = pts[pts.length - 1], x = Math.round(e.pageX), y = Math.round(e.pageY);
      if (Math.abs(x - last[0]) + Math.abs(y - last[1]) < 3 || pts.length >= 2000) return;
      pts.push([x, y]);
      drawing.setAttribute("points", pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "));
    });
    function endStroke() {
      if (!drawing) return;
      var pts = drawing.__pts;
      drawing = null;
      if (pts.length >= 2) post({ type: "stroke", points: pts });
      else render();
    }
    catcher.addEventListener("pointerup", endStroke);
    catcher.addEventListener("pointercancel", endStroke);

    window.addEventListener("message", function (e) {
      if (e.source !== window.parent || !e.data || e.data.source !== "gs-review-host") return;
      if (e.data.type === "mode") setMode(e.data.mode);
      if (e.data.type === "state") { state = e.data.state; render(); }
      if (e.data.type === "live-parent" && shown && shown.parentElement) pick(shown.parentElement);
      if (e.data.type === "live-version") showVersion(e.data.version || null);
      if (e.data.type === "live-clear") clearPick();
    });
    window.addEventListener("resize", function () {
      render();
      if (shown && shown.isConnected) place(selBox, shown);
      post({ type: "ready", width: window.innerWidth });
    });
    post({ type: "ready", width: window.innerWidth });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`;

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The page with the review bridge appended; a preset state draws the markup only. */
export function injectReviewBridge(html: string, preset?: PrototypeReviewMarkup) {
  const script = `${preset ? `<script>window.__GS_REVIEW_STATE__=${scriptJson(preset)};</script>` : ""}<script>${BRIDGE}</script>`;
  const end = html.search(/<\/body>/i);
  return end >= 0 ? html.slice(0, end) + script + html.slice(end) : html + script;
}

const MAX_SHOT_HEIGHT = 12_000;

/** A PNG of the page with the markup drawn on it, or null when no headless browser is available. */
export function renderReviewImage(html: string, markup: PrototypeReviewMarkup): Promise<Buffer | null> {
  return enqueueScreenshot(async () => {
    const chromium = await loadChromium();
    if (!chromium) return null;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      const options = { headless: true, args: ["--disable-dev-shm-usage"] };
      // A Playwright upgrade can leave its own browser build undownloaded; an installed Chrome still works.
      browser = await chromium.launch(options).catch(() => chromium.launch({ ...options, channel: "chrome" }));
      const context = await browser.newContext({
        viewport: { width: markup.width, height: 900 },
        serviceWorkers: "block",
        acceptDownloads: false,
        // The same rule the browser applies to an attachment: no network at all.
        offline: true,
      });
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        const url = route.request().url();
        return url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
      });
      await page.setContent(injectReviewBridge(html, markup), { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      return await page.screenshot({
        type: "png",
        fullPage: height <= MAX_SHOT_HEIGHT,
        ...(height > MAX_SHOT_HEIGHT ? { clip: { x: 0, y: 0, width: markup.width, height: MAX_SHOT_HEIGHT } } : {}),
      });
    } catch (err) {
      logger.warn({ err }, "prototype review render failed");
      return null;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  });
}
