// Review mode for HTML deliverables (GRE-982). The viewer shows the document in
// an opaque-origin sandbox, so the app cannot read its DOM or selection. This
// script is added to the copy served for review: it reports what the reader
// selects and draws comment markers, talking to the app only by postMessage.
//
// Only quotes, numbers and ids cross into the frame, never the notes: the
// document's own scripts share this frame and could read anything sent here.
//
// Messages carry `gsamReview: 1`. Frame to app: "ready", "selection" (quote,
// prefix, suffix, textStart, or quote null when cleared; or for a picked
// element or drawn area, kind "element" | "region", a label as the quote and
// a locator), "focus" (id), "pickCancel" (Escape in pick mode). App to frame:
// "marks" (list of anchors), "scrollTo" (id), "clearSelection", "pickMode" (on).
//
// Picking (GRE-1223): in pick mode, or with Alt/Option held, a click picks the
// element under the pointer (an image, chart, table or the nearest block) and
// a drag draws an area. Element and area markers are boxes in a layer outside
// the document body, so they never change the document's own layout or text.

const REVIEW_SCRIPT = String.raw`(function () {
  if (window.__gsamReview) return;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var QUOTE_MAX = 1000;
  var CONTEXT = 48;
  var LABEL_MAX = 120;
  var DRAG_MIN = 8;
  var KINDS = {
    IMG: "Image", PICTURE: "Image", SVG: "Graphic", CANVAS: "Chart", VIDEO: "Video", AUDIO: "Audio",
    IFRAME: "Embed", OBJECT: "Embed", EMBED: "Embed", TABLE: "Table", FIGURE: "Figure",
    BUTTON: "Button", A: "Link", UL: "List", OL: "List", FORM: "Form", INPUT: "Field", SELECT: "Field"
  };
  var lastSent = "";
  var pickMode = false;
  // True while a picked element or area is the current selection, so a
  // collapsed text selection does not clear it.
  var holdPick = false;
  var lastMarks = [];

  function post(message) {
    message.gsamReview = 1;
    try { window.parent.postMessage(message, "*"); } catch (e) {}
  }

  function root() { return document.body || document.documentElement; }

  function accept(node) {
    for (var p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
      if (SKIP[p.tagName] || p.hasAttribute("data-gsam-review-badge")) return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_ACCEPT;
  }

  // The document's visible text with runs of whitespace collapsed to one
  // space. raw[i] is the offset in the raw text of normalized character i.
  function model() {
    var nodes = [];
    var walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT, { acceptNode: accept });
    var node, pos = 0, rawText = "";
    while ((node = walker.nextNode())) {
      nodes.push({ node: node, start: pos });
      pos += node.data.length;
      rawText += node.data;
    }
    var text = "", raw = [], space = true;
    for (var i = 0; i < rawText.length; i++) {
      var ch = rawText.charAt(i);
      if (/\s/.test(ch)) {
        if (!space) { text += " "; raw.push(i); space = true; }
      } else {
        text += ch; raw.push(i); space = false;
      }
    }
    raw.push(rawText.length);
    return { nodes: nodes, text: text, raw: raw, rawLength: rawText.length };
  }

  function normIndex(m, rawOffset) {
    var lo = 0, hi = m.raw.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (m.raw[mid] < rawOffset) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function readSelection() {
    var selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    var range = selection.getRangeAt(0);
    var m = model();
    var start = -1, end = -1;
    for (var i = 0; i < m.nodes.length; i++) {
      var entry = m.nodes[i];
      if (!range.intersectsNode(entry.node)) continue;
      var from = entry.node === range.startContainer ? range.startOffset : 0;
      var to = entry.node === range.endContainer ? range.endOffset : entry.node.data.length;
      if (to <= from) continue;
      if (start < 0) start = entry.start + from;
      end = entry.start + to;
    }
    if (start < 0) return null;
    var s = normIndex(m, start), e = normIndex(m, end);
    while (s < e && m.text.charAt(s) === " ") s++;
    while (e > s && m.text.charAt(e - 1) === " ") e--;
    if (e <= s) return null;
    if (e - s > QUOTE_MAX) e = s + QUOTE_MAX;
    return {
      quote: m.text.slice(s, e),
      prefix: m.text.slice(Math.max(0, s - CONTEXT), s),
      suffix: m.text.slice(e, e + CONTEXT),
      textStart: s,
    };
  }

  function reportSelection() {
    var found = readSelection();
    if (!found && holdPick) return;
    if (found) holdPick = false;
    var key = found ? found.textStart + ":" + found.quote : "";
    if (key === lastSent) return;
    lastSent = key;
    post(found ? { type: "selection", quote: found.quote, prefix: found.prefix, suffix: found.suffix, textStart: found.textStart } : { type: "selection", quote: null });
  }

  var timer = null;
  function scheduleReport() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reportSelection, 200);
  }
  document.addEventListener("selectionchange", scheduleReport);
  document.addEventListener("mouseup", scheduleReport);
  document.addEventListener("touchend", scheduleReport);
  document.addEventListener("keyup", scheduleReport);

  function tagOf(el) { return String(el.localName || el.tagName || "").toLowerCase(); }

  function squash(text) { return String(text || "").replace(/\s+/g, " ").trim(); }

  function clip(text, max) { return text.length > max ? text.slice(0, max - 1) + "\u2026" : text; }

  // Our own layer and badges are never picked.
  function isOurs(el) {
    for (; el && el.nodeType === 1; el = el.parentNode) {
      if (el.hasAttribute("data-gsam-review-layer") || el.hasAttribute("data-gsam-review-badge")) return true;
    }
    return false;
  }

  // Visible text of el, without scripts, styles or our badges.
  function textOf(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: accept });
    var text = "", node;
    while ((node = walker.nextNode()) && text.length < 4 * LABEL_MAX) text += node.data + " ";
    return text;
  }

  function childText(el, tag) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (tagOf(c) === tag) return textOf(c);
    return "";
  }

  // What a click on target picks: the outermost SVG, else the table it is
  // in, else the nearest image, media or control, else the nearest block.
  function pickable(target) {
    var el = target && target.nodeType === 1 ? target : target && target.parentNode;
    if (!el || el.nodeType !== 1 || isOurs(el) || !document.body || !document.body.contains(el)) return null;
    var svg = null, table = null;
    for (var p = el; p && p !== document.body; p = p.parentNode) {
      var tag = tagOf(p);
      if (tag === "svg") svg = p;
      else if (tag === "table" && !table) table = p;
    }
    if (svg) return svg;
    if (table) return table;
    for (var q = el; q && q !== document.body; q = q.parentNode) {
      if (KINDS[tagOf(q).toUpperCase()]) return q;
      var display = window.getComputedStyle ? window.getComputedStyle(q).display : "block";
      if (display && display !== "inline" && display !== "contents") return q;
    }
    return document.body;
  }

  // A readable label such as "Image: Q3 revenue chart".
  function describe(el) {
    if (el === document.body) return "Page";
    var tag = tagOf(el);
    var kind = KINDS[tag.toUpperCase()] || (/^h[1-6]$/.test(tag) ? "Heading" : "Block");
    var name = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
    if (!name && tag === "svg") name = childText(el, "title");
    if (!name && tag === "table") name = childText(el, "caption");
    if (!name && tag === "figure") name = childText(el, "figcaption");
    if (!name && el.parentNode && el.parentNode.nodeType === 1 && tagOf(el.parentNode) === "figure") name = childText(el.parentNode, "figcaption");
    if (!name && tag === "img") name = String(el.getAttribute("src") || "").split(/[?#]/)[0].split("/").pop();
    if (!name && kind === "Block") {
      var heading = el.querySelector("h1,h2,h3,h4,h5,h6");
      if (heading && !isOurs(heading)) name = textOf(heading);
    }
    if (!name && tag !== "img") name = textOf(el);
    name = squash(name);
    return clip(name ? kind + ": " + name : kind, LABEL_MAX);
  }

  // body > tag:nth-of-type(n) > ... from the body down to el.
  function pathOf(el) {
    var steps = [];
    for (var p = el; p && p.nodeType === 1 && p !== document.body; p = p.parentNode) {
      var tag = tagOf(p), n = 1;
      for (var s = p.previousElementSibling; s; s = s.previousElementSibling) if (tagOf(s) === tag) n++;
      steps.unshift(tag + ":nth-of-type(" + n + ")");
    }
    steps.unshift("body");
    return steps.join(" > ");
  }

  // The element a locator names: its path when the tag and label still
  // match, else the first element of that tag with the same label, else the
  // element at the path if its tag matches.
  function findElement(locator) {
    if (!locator || typeof locator.path !== "string" || !document.body) return null;
    var tag = String(locator.tag || "").toLowerCase();
    var atPath = null;
    try { atPath = locator.path === "body" ? document.body : document.body.parentNode.querySelector(locator.path); } catch (e) {}
    if (atPath && tagOf(atPath) !== tag) atPath = null;
    if (atPath && (!locator.label || describe(atPath) === locator.label)) return atPath;
    if (locator.label && tag) {
      var all = document.body.getElementsByTagName(tag);
      for (var i = 0; i < all.length; i++) {
        if (!isOurs(all[i]) && describe(all[i]) === locator.label) return all[i];
      }
    }
    return atPath;
  }

  function locatorFor(el, box) {
    return { path: pathOf(el), tag: tagOf(el), label: describe(el), box: box || null };
  }

  function clamp(value) { return Math.max(0, Math.min(1, value)); }

  function round(value) { return Math.round(value * 10000) / 10000; }

  // The smallest block that holds the whole drawn rectangle (viewport pixels).
  function regionContainer(rect) {
    var a = document.elementFromPoint ? document.elementFromPoint(rect.left + 1, rect.top + 1) : null;
    var b = document.elementFromPoint ? document.elementFromPoint(rect.right - 1, rect.bottom - 1) : null;
    var el = a || b || document.body;
    if (!document.body.contains(el)) el = document.body;
    while (el && el !== document.body && (isOurs(el) || (b && !el.contains(b)))) el = el.parentNode;
    for (; el && el !== document.body; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      var r = el.getBoundingClientRect();
      var display = window.getComputedStyle ? window.getComputedStyle(el).display : "block";
      if (display !== "inline" && display !== "contents" && r.width > 0 && r.height > 0 &&
        r.left <= rect.left + 1 && r.top <= rect.top + 1 && r.right >= rect.right - 1 && r.bottom >= rect.bottom - 1) return el;
    }
    return document.body;
  }

  // The drawn rectangle as fractions of its container.
  function regionLocator(rect) {
    var el = regionContainer(rect);
    var r = el.getBoundingClientRect();
    var width = r.width || 1, height = r.height || 1;
    var x = clamp((rect.left - r.left) / width), y = clamp((rect.top - r.top) / height);
    var box = {
      x: round(x),
      y: round(y),
      width: round(clamp((rect.right - r.left) / width) - x),
      height: round(clamp((rect.bottom - r.top) / height) - y)
    };
    return locatorFor(el, box);
  }

  function reportPick(kind, locator) {
    holdPick = true;
    lastSent = "pick";
    var selection = window.getSelection && window.getSelection();
    if (selection) selection.removeAllRanges();
    var quote = kind === "region" ? clip("Area on " + locator.label, LABEL_MAX) : locator.label;
    post({ type: "selection", kind: kind, quote: quote, locator: locator });
  }

  // The layer for element and area markers, the hover outline and the drag box.
  var layer = null;
  function getLayer() {
    if (layer && layer.parentNode) return layer;
    layer = document.createElement("div");
    layer.setAttribute("data-gsam-review-layer", "");
    layer.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(layer);
    return layer;
  }

  function placeBox(div, rect) {
    div.style.left = (rect.left + window.scrollX) + "px";
    div.style.top = (rect.top + window.scrollY) + "px";
    div.style.width = Math.max(rect.width, 4) + "px";
    div.style.height = Math.max(rect.height, 4) + "px";
  }

  function anchorRect(anchor) {
    var el = findElement(anchor.locator);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var box = anchor.kind === "region" ? anchor.locator.box : null;
    if (!box) return { left: r.left, top: r.top, width: r.width, height: r.height };
    return { left: r.left + box.x * r.width, top: r.top + box.y * r.height, width: box.width * r.width, height: box.height * r.height };
  }

  function drawBoxes() {
    var host = getLayer();
    var old = host.querySelectorAll("[data-gsam-review-box],[data-gsam-review-badge]");
    for (var i = 0; i < old.length; i++) host.removeChild(old[i]);
    for (var j = 0; j < lastMarks.length; j++) {
      var anchor = lastMarks[j];
      if (anchor.kind !== "element" && anchor.kind !== "region") continue;
      var rect = anchorRect(anchor);
      if (!rect) continue;
      var div = document.createElement("div");
      div.setAttribute("data-gsam-review-box", anchor.id);
      div.setAttribute("data-gsam-state", anchor.sent ? "sent" : "draft");
      if (anchor.active) div.setAttribute("data-gsam-active", "true");
      placeBox(div, rect);
      host.appendChild(div);
      var badge = document.createElement("span");
      badge.setAttribute("data-gsam-review-badge", anchor.id);
      badge.textContent = String(anchor.n);
      badge.style.left = Math.max(0, rect.left + window.scrollX - 8) + "px";
      badge.style.top = Math.max(0, rect.top + window.scrollY - 8) + "px";
      host.appendChild(badge);
    }
  }

  var hoverBox = null, dragBox = null;
  function showHover(el) {
    if (!el) { if (hoverBox) hoverBox.style.display = "none"; return; }
    if (!hoverBox) {
      hoverBox = document.createElement("div");
      hoverBox.setAttribute("data-gsam-review-hover", "");
      getLayer().appendChild(hoverBox);
    }
    hoverBox.setAttribute("data-label", describe(el));
    placeBox(hoverBox, el.getBoundingClientRect());
    hoverBox.style.display = "block";
  }

  function dragRect(start, x, y) {
    var left = Math.min(start.x, x), top = Math.min(start.y, y);
    var width = Math.abs(x - start.x), height = Math.abs(y - start.y);
    return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
  }

  function showDrag(rect) {
    if (!rect) { if (dragBox) dragBox.style.display = "none"; return; }
    if (!dragBox) {
      dragBox = document.createElement("div");
      dragBox.setAttribute("data-gsam-review-drag", "");
      getLayer().appendChild(dragBox);
    }
    placeBox(dragBox, rect);
    dragBox.style.display = "block";
  }

  var press = null, swallowClick = false;
  function picking(event) { return pickMode || event.altKey; }

  window.addEventListener("mousedown", function (event) {
    if (event.button !== 0 || !picking(event) || isOurs(event.target)) return;
    press = { x: event.clientX, y: event.clientY, target: event.target, dragging: false };
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("mousemove", function (event) {
    if (press) {
      if (!press.dragging && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) >= DRAG_MIN) press.dragging = true;
      if (press.dragging) { showHover(null); showDrag(dragRect(press, event.clientX, event.clientY)); }
      event.preventDefault();
      return;
    }
    showHover(picking(event) && !isOurs(event.target) ? pickable(event.target) : null);
  }, true);

  window.addEventListener("mouseup", function (event) {
    if (!press) return;
    var done = press;
    press = null;
    showDrag(null);
    swallowClick = true;
    setTimeout(function () { swallowClick = false; }, 0);
    event.preventDefault();
    event.stopPropagation();
    if (done.dragging) {
      var rect = dragRect(done, event.clientX, event.clientY);
      if (rect.width >= DRAG_MIN && rect.height >= DRAG_MIN) reportPick("region", regionLocator(rect));
      return;
    }
    var el = pickable(done.target);
    if (el) reportPick("element", locatorFor(el, null));
  }, true);

  // In pick mode a click picks; it must not also follow a link or press a button.
  window.addEventListener("click", function (event) {
    if (isOurs(event.target)) return;
    if (swallowClick || picking(event)) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && pickMode) { showHover(null); post({ type: "pickCancel" }); }
  }, true);
  window.addEventListener("keyup", function (event) {
    if (event.key === "Alt" && !pickMode) showHover(null);
  }, true);

  var relayout = null;
  function scheduleRelayout() {
    if (relayout) clearTimeout(relayout);
    relayout = setTimeout(drawBoxes, 100);
  }
  window.addEventListener("resize", scheduleRelayout);
  window.addEventListener("load", scheduleRelayout);
  document.addEventListener("load", scheduleRelayout, true);

  window.__gsamReview = { pathOf: pathOf, describe: describe, pickable: pickable, findElement: findElement, regionLocator: regionLocator };

  function locate(m, anchor) {
    var quote = anchor.quote;
    if (!quote) return -1;
    var best = -1, bestScore = -1, seen = 0, at = m.text.indexOf(quote);
    while (at >= 0 && seen < 200) {
      seen++;
      var score = 0;
      if (anchor.prefix && m.text.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix) score += 2;
      if (anchor.suffix && m.text.slice(at + quote.length, at + quote.length + anchor.suffix.length) === anchor.suffix) score += 2;
      if (typeof anchor.textStart === "number") score += 1 / (1 + Math.abs(at - anchor.textStart));
      if (score > bestScore) { best = at; bestScore = score; }
      at = m.text.indexOf(quote, at + 1);
    }
    return best;
  }

  function clearMarks() {
    var badges = root().querySelectorAll("[data-gsam-review-badge]");
    for (var i = 0; i < badges.length; i++) badges[i].parentNode.removeChild(badges[i]);
    var marks = root().querySelectorAll("mark[data-gsam-review]");
    for (var j = 0; j < marks.length; j++) {
      var mark = marks[j], parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function wrap(m, anchor, rawStart, rawEnd) {
    var first = null;
    var targets = [];
    for (var i = 0; i < m.nodes.length; i++) {
      var entry = m.nodes[i];
      var a = Math.max(rawStart, entry.start) - entry.start;
      var b = Math.min(rawEnd, entry.start + entry.node.data.length) - entry.start;
      if (b > a && entry.node.data.slice(a, b).trim()) targets.push({ node: entry.node, a: a, b: b });
    }
    for (var k = 0; k < targets.length; k++) {
      var t = targets[k], node = t.node;
      if (t.b < node.data.length) node.splitText(t.b);
      if (t.a > 0) node = node.splitText(t.a);
      var mark = document.createElement("mark");
      mark.setAttribute("data-gsam-review", anchor.id);
      mark.setAttribute("data-gsam-state", anchor.sent ? "sent" : "draft");
      if (anchor.active) mark.setAttribute("data-gsam-active", "true");
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      if (!first) first = mark;
    }
    if (first) {
      var badge = document.createElement("sup");
      badge.setAttribute("data-gsam-review-badge", anchor.id);
      badge.textContent = String(anchor.n);
      first.parentNode.insertBefore(badge, first);
    }
  }

  function applyMarks(list) {
    clearMarks();
    lastMarks = list;
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === "element" || list[i].kind === "region") continue;
      var m = model();
      var at = locate(m, list[i]);
      if (at < 0) continue;
      wrap(m, list[i], m.raw[at], m.raw[at + list[i].quote.length - 1] + 1);
    }
    drawBoxes();
  }

  var style = document.createElement("style");
  style.textContent =
    "mark[data-gsam-review]{background:rgba(250,204,21,.45)!important;color:inherit!important;border-radius:2px;cursor:pointer;padding:0!important}" +
    "mark[data-gsam-review][data-gsam-state=sent]{background:rgba(59,130,246,.22)!important}" +
    "mark[data-gsam-review][data-gsam-active=true]{outline:2px solid rgba(217,119,6,.9);outline-offset:1px}" +
    "sup[data-gsam-review-badge]{display:inline-block;min-width:1.4em;margin:0 2px;padding:0 4px;border-radius:9px;background:#d97706;color:#fff!important;font:600 11px/1.4 system-ui,sans-serif!important;text-align:center;vertical-align:super;cursor:pointer;user-select:none}" +
    "div[data-gsam-review-layer]{position:absolute!important;top:0!important;left:0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;pointer-events:none!important}" +
    "div[data-gsam-review-layer]>*{position:absolute;box-sizing:border-box;pointer-events:none}" +
    "div[data-gsam-review-box]{border:2px solid rgba(217,119,6,.9);background:rgba(250,204,21,.14);border-radius:3px}" +
    "div[data-gsam-review-box][data-gsam-state=sent]{border-color:rgba(59,130,246,.8);background:rgba(59,130,246,.08)}" +
    "div[data-gsam-review-box][data-gsam-active=true]{border-width:3px;box-shadow:0 0 0 3px rgba(217,119,6,.35)}" +
    "div[data-gsam-review-layer]>span[data-gsam-review-badge]{min-width:1.4em;padding:0 4px;border-radius:9px;background:#d97706;color:#fff;font:600 11px/1.4 system-ui,sans-serif;text-align:center;cursor:pointer;user-select:none;pointer-events:auto}" +
    "div[data-gsam-review-hover]{border:2px dashed #2563eb;background:rgba(37,99,235,.08);border-radius:3px}" +
    "div[data-gsam-review-hover]::after{content:attr(data-label);position:absolute;left:-2px;bottom:100%;max-width:320px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:1px 6px;border-radius:3px 3px 0 0;background:#2563eb;color:#fff;font:500 11px/1.5 system-ui,sans-serif}" +
    "div[data-gsam-review-drag]{border:2px dashed #2563eb;background:rgba(37,99,235,.12)}" +
    "html[data-gsam-picking],html[data-gsam-picking] *{cursor:crosshair!important}";
  (document.head || document.documentElement).appendChild(style);

  document.addEventListener("click", function (event) {
    var el = event.target;
    while (el && el.nodeType === 1) {
      var id = el.getAttribute("data-gsam-review") || el.getAttribute("data-gsam-review-badge");
      if (id) { post({ type: "focus", id: id }); return; }
      el = el.parentNode;
    }
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.gsamReview !== 1) return;
    if (data.type === "marks" && Array.isArray(data.marks)) applyMarks(data.marks);
    else if (data.type === "scrollTo") {
      var id = String(data.id).replace(/[^a-zA-Z0-9-]/g, "");
      var target = root().querySelector('mark[data-gsam-review="' + id + '"]') ||
        getLayer().querySelector('div[data-gsam-review-box="' + id + '"]');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (data.type === "clearSelection") {
      var selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      lastSent = "";
      holdPick = false;
    } else if (data.type === "pickMode") {
      pickMode = data.on === true;
      if (pickMode) document.documentElement.setAttribute("data-gsam-picking", "");
      else { document.documentElement.removeAttribute("data-gsam-picking"); showHover(null); }
    }
  });

  post({ type: "ready" });
})();`;

/** The HTML with the review script added at the end of its body. */
export function injectDeliverableReviewScript(html: string): string {
  const tag = `<script data-gsam-review-script>${REVIEW_SCRIPT}</script>`;
  const closeBody = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return closeBody >= 0 ? `${html.slice(0, closeBody)}${tag}${html.slice(closeBody)}` : `${html}${tag}`;
}
