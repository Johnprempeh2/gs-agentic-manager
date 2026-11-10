import { JSDOM } from "jsdom";

/**
 * Writes the editor's own edits (changed words, removed elements) straight into a page's HTML, so
 * saving them does not need an agent. The page arrives as the frame saw it (a DOM path and the old
 * words), which is not trusted: every edit must be found AND checked against the saved HTML, the new
 * words are escaped, and anything unclear fails so the caller can hand the edits to the agent instead.
 *
 * The saved HTML is changed by cutting the original string at the parser's source positions, never
 * by writing the parsed page back out, so every byte the edits do not touch stays as it was.
 */

type Op = Record<string, unknown>;
export type DirectEditResult = { html: string; applied: number } | { failed: string };

const MAX_TEXT = 5000;
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "template", "noscript"]);
const norm = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const refToken = (value: string) => value.replace(/[>\s]+/g, "_");

/** The id and class part of a ref segment, as the editor writes it for an element (first two classes). */
function refName(el: Element) {
  const classes = [...el.classList].filter((cls) => !cls.startsWith("impeccable-")).slice(0, 2).map(refToken);
  return (el.id ? `#${refToken(el.id)}` : "") + (classes.length ? `.${classes.join(".")}` : "");
}

function parseSegment(segment: string) {
  const found = segment.match(/^([a-z][a-z0-9-]*)(.*):nth-of-type\((\d+)\)$/);
  return found ? { tag: found[1]!, name: found[2]!, n: Number(found[3]) } : null;
}

const isText = (node: Node) => node.nodeType === 3;
const hasWords = (node: Node) => isText(node) && /\S/.test(node.nodeValue ?? "");
/** A text leaf, as the editor's pencil sees one: only text inside, with some words. */
const isLeaf = (el: Element) => el.childNodes.length > 0 && [...el.childNodes].every(isText) && [...el.childNodes].some(hasWords);
const touchesIsland = (el: Element) => el.localName === "gs-island" || !!el.querySelector("gs-island") || !!el.closest("gs-island");

export function applyEditsToPage(html: string, ops: Op[]): DirectEditResult {
  if (!ops.length) return { failed: "no edits" };
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const doc = dom.window.document;
  const page = doc.querySelector("#gs-page");
  const root: Element = page ?? doc.body;
  const at = (node: Node) => dom.nodeLocation(node) as { startOffset: number; endOffset: number } | null | undefined;

  /**
   * Follows a ref from the page root. `el` is where it ended (null when it ran out), `clean` says every
   * step also matched the id and classes the editor saw, and `deepest` is the last element it reached
   * (null when the ref never enters the page: the shared header and footer are not in this document).
   */
  function walk(ref: unknown) {
    const parsed = String(ref ?? "").split(">");
    let start = 0;
    let islandsAsDivs = false;
    if (page) {
      // The public site's frame wraps the page as main > div#gs-page; GSAM's own frame is main#gs-page.
      start = parsed.findIndex((segment) => /^[a-z][a-z0-9-]*#gs-page(\.|:)/.test(segment));
      if (start < 0) return { el: null, clean: false, deepest: null as Element | null };
      islandsAsDivs = parsed[start]!.startsWith("div#");
    } else if (parsed[0] !== "body") {
      return { el: null, clean: false, deepest: null as Element | null };
    }
    let el: Element | null = root;
    let deepest: Element = root;
    let clean = true;
    for (const raw of parsed.slice(start + 1)) {
      const segment = parseSegment(raw);
      if (!segment || !el) return { el: null, clean: false, deepest };
      // That frame also shows each island inside a div, so an island counts as a div there.
      const same: Element[] = [...el.children].filter((child) => child.localName === segment.tag || (islandsAsDivs && segment.tag === "div" && child.localName === "gs-island"));
      const next: Element | null = same[segment.n - 1] ?? null;
      if (!next) return { el: null, clean: false, deepest };
      if (!segment.name.startsWith(refName(next))) clean = false;
      el = next;
      deepest = next;
    }
    return { el, clean, deepest };
  }

  /** One element out of `found`: the only one, or the only one inside where the ref got to. */
  function only<T extends Node>(found: T[], within: Element | null) {
    if (found.length === 1) return found[0]!;
    const inside = within ? found.filter((node) => within.contains(node)) : [];
    return inside.length === 1 ? inside[0]! : null;
  }

  // What will be cut out of the original string: [start, end) replaced by `text`.
  const textCuts = new Map<Node, { start: number; end: number; text: string }>();
  const removed = new Set<Element>();

  function setWords(key: Node, nodes: Node[], newText: string) {
    const first = at(nodes[0]!);
    const last = at(nodes[nodes.length - 1]!);
    const cut = textCuts.get(key);
    if (!cut && (!first || !last)) return false;
    const old = nodes.map((node) => node.nodeValue ?? "").join("");
    // Keep the space around the words (a gap before a link, the indent of the source).
    const text = (old.match(/^\s*/)?.[0] ?? "") + newText.trim() + (old.match(/\s*$/)?.[0] ?? "");
    nodes[0]!.nodeValue = text;
    for (const extra of nodes.slice(1)) extra.parentNode?.removeChild(extra);
    if (cut) cut.text = text;
    else textCuts.set(key, { start: first!.startOffset, end: last!.endOffset, text });
    return true;
  }

  function editText(op: Op): string | null {
    const newText = String(op.newText ?? "");
    const original = norm(op.originalText);
    if (!newText.trim() || newText.length > MAX_TEXT || !original) return "the new words are empty or too long";
    const restore = op.restore as { kind?: unknown; parentRef?: unknown; textIndex?: unknown } | undefined;
    if (restore?.kind === "mixedTextNode") {
      // Words that sit beside other elements (a sentence with a link in it): one text node of the parent.
      const parent = walk(restore.parentRef);
      const mine = (el: Element) => [...el.childNodes].filter(hasWords);
      const byIndex = parent.el ? mine(parent.el)[Number(restore.textIndex)] : undefined;
      const node = byIndex && norm(byIndex.nodeValue) === original
        ? byIndex
        : parent.deepest && only([...root.querySelectorAll("*")].filter((el) => el.children.length > 0).flatMap(mine).filter((text) => norm(text.nodeValue) === original), parent.el ?? parent.deepest);
      if (!node?.parentElement || RAW_TEXT.has(node.parentElement.localName) || touchesIsland(node.parentElement)) return "the words were not found";
      return setWords(node, [node], newText) ? null : "the words have no place in the saved page";
    }
    const tag = String((op.leaf as { tagName?: unknown } | undefined)?.tagName ?? "").toLowerCase();
    const matches = (el: Element) => isLeaf(el) && norm(el.textContent) === original && (!tag || el.localName === tag);
    const path = walk(op.ref);
    const el = path.el && matches(path.el) ? path.el : path.deepest && only([...root.querySelectorAll("*")].filter(matches), path.deepest);
    if (!el || el === root || RAW_TEXT.has(el.localName) || touchesIsland(el)) return "the words were not found";
    return setWords(el, [...el.childNodes], newText) ? null : "the words have no place in the saved page";
  }

  function removeElement(op: Op): string | null {
    const tag = String(op.tag ?? "").toLowerCase();
    const id = typeof op.elementId === "string" ? op.elementId : "";
    const text = norm(op.originalText);
    const leaf = op.leaf as { textContent?: unknown } | undefined;
    const whole = typeof leaf?.textContent === "string" ? leaf.textContent : null;
    if (!tag || !text) return "nothing identifies the element";
    const matches = (el: Element) => {
      if (el.localName !== tag || el.id !== id) return false;
      const words = norm(el.textContent);
      // The editor sends up to 500 characters of the element's words: they must be the saved ones.
      if (whole !== null && !(whole.length >= 500 ? words.startsWith(norm(whole)) : words === norm(whole))) return false;
      const file = (name: string) => (el.getAttribute(name) ?? "").split(/[?#]/)[0]!.split("/").filter(Boolean).pop();
      return words.includes(text)
        || ["alt", "aria-label", "title"].some((name) => norm(el.getAttribute(name)) === text)
        || file("src") === text || file("href") === text
        || el.id === text || el.classList.contains(text);
    };
    const all = [...root.querySelectorAll(tag)].filter(matches);
    const path = walk(op.ref);
    // Twins (three cards with the same words) are told apart only by position, so the path must be exact.
    const el = path.el && matches(path.el) && (path.clean || all.length === 1) ? path.el : path.deepest && only(all, null);
    if (!el || el === root) return "the element was not found";
    if (touchesIsland(el)) return "the element holds a built-in part";
    if (!at(el)) return "the element has no place in the saved page";
    removed.add(el);
    return null;
  }

  for (const op of ops) {
    const failed = op.removeElement === true ? removeElement(op) : typeof op.newText === "string" ? editText(op) : "an edit of a kind that is not known";
    if (failed) return { failed };
  }

  // Removals first take their text edits with them, then everything is cut from the end backwards.
  const gone = [...removed].filter((el) => ![...removed].some((other) => other !== el && other.contains(el)));
  const cuts = gone.map((el) => ({ start: at(el)!.startOffset, end: at(el)!.endOffset, text: "" }));
  for (const [node, cut] of textCuts) if (!gone.some((el) => el.contains(node))) cuts.push(cut);
  cuts.sort((a, b) => b.start - a.start);
  let out = html;
  let before = html.length;
  for (const cut of cuts) {
    if (cut.end > before || cut.start > cut.end) return { failed: "two edits overlap" };
    out = out.slice(0, cut.start) + (cut.text ? escapeText(cut.text) : "") + out.slice(cut.end);
    before = cut.start;
  }

  // The check: the cut string, read again, must be exactly the page with the edits made on it.
  for (const el of gone) el.remove();
  const again = new JSDOM(out).window.document;
  const expected = page ? root.innerHTML : doc.body.innerHTML;
  const got = page ? again.querySelector("#gs-page")?.innerHTML : again.body.innerHTML;
  if (expected !== got) return { failed: "the saved page would not match the edits" };
  return { html: out, applied: ops.length };
}
