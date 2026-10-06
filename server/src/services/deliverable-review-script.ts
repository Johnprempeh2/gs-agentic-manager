// Review mode for HTML deliverables (GRE-982). The viewer shows the document in
// an opaque-origin sandbox, so the app cannot read its DOM or selection. This
// script is added to the copy served for review: it reports what the reader
// selects and draws comment markers, talking to the app only by postMessage.
//
// Only quotes, numbers and ids cross into the frame, never the notes: the
// document's own scripts share this frame and could read anything sent here.
//
// Messages carry `gsamReview: 1`. Frame to app: "ready", "selection" (quote,
// prefix, suffix, textStart, or quote null when cleared), "focus" (id). App to
// frame: "marks" (list of anchors), "scrollTo" (id), "clearSelection".

const REVIEW_SCRIPT = String.raw`(function () {
  if (window.__gsamReview) return;
  window.__gsamReview = true;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var QUOTE_MAX = 1000;
  var CONTEXT = 48;
  var lastSent = "";

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
    for (var i = 0; i < list.length; i++) {
      var m = model();
      var at = locate(m, list[i]);
      if (at < 0) continue;
      wrap(m, list[i], m.raw[at], m.raw[at + list[i].quote.length - 1] + 1);
    }
  }

  var style = document.createElement("style");
  style.textContent =
    "mark[data-gsam-review]{background:rgba(250,204,21,.45)!important;color:inherit!important;border-radius:2px;cursor:pointer;padding:0!important}" +
    "mark[data-gsam-review][data-gsam-state=sent]{background:rgba(59,130,246,.22)!important}" +
    "mark[data-gsam-review][data-gsam-active=true]{outline:2px solid rgba(217,119,6,.9);outline-offset:1px}" +
    "sup[data-gsam-review-badge]{display:inline-block;min-width:1.4em;margin:0 2px;padding:0 4px;border-radius:9px;background:#d97706;color:#fff!important;font:600 11px/1.4 system-ui,sans-serif!important;text-align:center;vertical-align:super;cursor:pointer;user-select:none}";
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
      var target = root().querySelector('mark[data-gsam-review="' + String(data.id).replace(/[^a-zA-Z0-9-]/g, "") + '"]');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (data.type === "clearSelection") {
      var selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      lastSent = "";
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
