/**
 * Clean copy for rendered markdown (GRE-1585).
 *
 * When a person copies from a markdown view, the browser puts the rendered
 * HTML on the clipboard with GSAM's computed styles inlined: background,
 * colour, font and line height. Outlook and Word paste that as grey boxes in
 * GSAM's font. These helpers rebuild the copied content as semantic HTML with
 * no styles or classes, plus a clean plain-text version, so the target app
 * uses its own look.
 */

export interface RichClipboardContent {
  html: string;
  text: string;
}

const KEPT_TAGS = new Set([
  "P", "BR", "OL", "UL", "LI", "STRONG", "EM", "A", "H1", "H2", "H3",
  "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "PRE", "CODE", "BLOCKQUOTE", "HR", "DEL",
]);

const RENAMED_TAGS: Record<string, string> = {
  B: "STRONG",
  I: "EM",
  S: "DEL",
  STRIKE: "DEL",
  H4: "H3",
  H5: "H3",
  H6: "H3",
};

// Controls, icons and embedded frames are UI, not content.
const DROPPED_TAGS = new Set([
  "BUTTON", "SVG", "SCRIPT", "STYLE", "IFRAME", "IMG", "INPUT", "TEXTAREA", "SELECT",
  "NOSCRIPT", "TEMPLATE", "VIDEO", "AUDIO", "CANVAS", "OBJECT", "EMBED",
]);

const BLOCK_TAGS = new Set([
  "P", "OL", "UL", "LI", "H1", "H2", "H3", "TABLE", "PRE", "BLOCKQUOTE", "HR",
]);

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

function absoluteHref(raw: string | null, baseUrl: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function cleanChildren(source: Node, target: Node, doc: Document, baseUrl: string | undefined) {
  for (const child of Array.from(source.childNodes)) {
    cleanNode(child, target, doc, baseUrl);
  }
}

function cleanNode(node: Node, target: Node, doc: Document, baseUrl: string | undefined) {
  if (isText(node)) {
    target.appendChild(doc.createTextNode(node.data));
    return;
  }
  if (!isElement(node)) {
    if (node.nodeType === 11) cleanChildren(node, target, doc, baseUrl);
    return;
  }

  const tag = node.tagName.toUpperCase();
  if (DROPPED_TAGS.has(tag)) return;
  if (node.getAttribute("aria-hidden") === "true") return;

  const keptTag = RENAMED_TAGS[tag] ?? tag;
  if (keptTag === "PRE") {
    // Code stays plain monospace text: no highlighting spans, no copy buttons.
    const pre = doc.createElement("pre");
    const code = node.querySelector("code") ?? node;
    pre.textContent = (code.textContent ?? "").replace(/\n$/, "");
    target.appendChild(pre);
    return;
  }
  if (!KEPT_TAGS.has(keptTag)) {
    cleanChildren(node, target, doc, baseUrl);
    return;
  }

  if (keptTag === "A") {
    const href = absoluteHref(node.getAttribute("href"), baseUrl);
    if (!href) {
      cleanChildren(node, target, doc, baseUrl);
      return;
    }
    const anchor = doc.createElement("a");
    anchor.setAttribute("href", href);
    cleanChildren(node, anchor, doc, baseUrl);
    target.appendChild(anchor);
    return;
  }

  const element = doc.createElement(keptTag.toLowerCase());
  if (keptTag === "OL") {
    const start = Number.parseInt(node.getAttribute("start") ?? "", 10);
    if (Number.isFinite(start) && start !== 1) element.setAttribute("start", String(start));
  }
  if (keptTag === "TD" || keptTag === "TH") {
    for (const name of ["colspan", "rowspan"]) {
      const value = node.getAttribute(name);
      if (value && /^\d+$/.test(value)) element.setAttribute(name, value);
    }
  }
  cleanChildren(node, element, doc, baseUrl);
  target.appendChild(element);
}

/**
 * Rebuild `source` as a fragment of semantic tags only: no `style`, `class`,
 * `data-*` or other attributes, except `href` on links, `start` on numbered
 * lists, and cell spans on tables.
 */
export function cleanClipboardFragment(source: Node, baseUrl?: string): DocumentFragment {
  const doc = source.ownerDocument ?? (source as Document);
  const fragment = doc.createDocumentFragment();
  cleanNode(source, fragment, doc, baseUrl ?? doc.baseURI ?? undefined);
  return fragment;
}

function isBlock(node: Node): node is Element {
  return isElement(node) && BLOCK_TAGS.has(node.tagName.toUpperCase());
}

function inlineText(node: Node, baseUrl: string | undefined): string {
  if (isText(node)) return node.data.replace(/\s+/g, " ");
  if (!isElement(node)) return "";
  const tag = node.tagName.toUpperCase();
  if (tag === "BR") return "\n";
  const inner = Array.from(node.childNodes).map((child) => inlineText(child, baseUrl)).join("");
  if (tag === "A") {
    const href = node.getAttribute("href") ?? "";
    const label = inner.trim();
    // Keep web addresses a reader needs; in-app links read as their label.
    const external = /^https?:/i.test(href) && !isSameOrigin(href, baseUrl);
    if (external && label && label !== href) return `${inner} (${href})`;
  }
  return inner;
}

function isSameOrigin(href: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(href).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function tidyInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
}

function indent(text: string, by: string): string {
  return text.split("\n").map((line) => (line ? by + line : line)).join("\n");
}

function blockText(element: Element, baseUrl: string | undefined): string {
  const tag = element.tagName.toUpperCase();
  if (tag === "PRE") return element.textContent ?? "";
  if (tag === "HR") return "---";
  if (tag === "BLOCKQUOTE") return indent(blocksText(element, baseUrl).join("\n\n"), "> ");
  if (tag === "TABLE") {
    return Array.from(element.querySelectorAll("tr"))
      .map((row) => Array.from(row.children).map((cell) => tidyInline(inlineText(cell, baseUrl))).join("\t"))
      .join("\n");
  }
  if (tag === "OL" || tag === "UL") {
    const start = Number.parseInt(element.getAttribute("start") ?? "1", 10) || 1;
    const items = Array.from(element.children).filter((child) => child.tagName.toUpperCase() === "LI");
    return items
      .map((item, index) => {
        const marker = tag === "OL" ? `${start + index}.` : "-";
        const body = blocksText(item, baseUrl).join("\n");
        return marker + " " + indent(body, " ".repeat(marker.length + 1)).trimStart();
      })
      .join("\n");
  }
  if (tag === "LI") return blocksText(element, baseUrl).join("\n");
  return tidyInline(inlineText(element, baseUrl));
}

function blocksText(parent: Node, baseUrl: string | undefined): string[] {
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    const text = tidyInline(inline);
    if (text) blocks.push(text);
    inline = "";
  };
  for (const child of Array.from(parent.childNodes)) {
    if (isBlock(child)) {
      flush();
      const text = blockText(child, baseUrl);
      if (text.trim()) blocks.push(text);
    } else {
      inline += inlineText(child, baseUrl);
    }
  }
  flush();
  return blocks;
}

/** Plain text for a cleaned fragment: blank line between paragraphs, list numbers kept. */
export function clipboardPlainText(fragment: Node, baseUrl?: string): string {
  return blocksText(fragment, baseUrl).join("\n\n");
}

export function clipboardHtml(fragment: DocumentFragment): string {
  const doc = fragment.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.appendChild(fragment.cloneNode(true));
  return wrapper.innerHTML;
}

/** Clean HTML and plain text for any rendered markdown node or fragment. */
export function richClipboardContent(source: Node, baseUrl?: string): RichClipboardContent {
  const base = baseUrl ?? source.ownerDocument?.baseURI ?? undefined;
  const fragment = cleanClipboardFragment(source, base);
  return { html: clipboardHtml(fragment), text: clipboardPlainText(fragment, base) };
}

/**
 * Clean content for the current selection inside `container`, or null when
 * the selection is empty or reaches outside it.
 */
export function richClipboardContentForSelection(
  selection: Selection | null,
  container: Element,
): RichClipboardContent | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const doc = container.ownerDocument;
  const holder = doc.createDocumentFragment();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const contents = withStructuralParents(range, container, range.cloneContents());
    keepListNumbering(range, container, contents);
    const ancestor = isElement(range.commonAncestorContainer)
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const pre = ancestor?.closest("pre");
    if (pre && container.contains(pre)) {
      // A selection inside one code block clones as bare text; keep it monospace.
      const wrapper = doc.createElement("pre");
      wrapper.appendChild(contents);
      holder.appendChild(wrapper);
    } else {
      holder.appendChild(contents);
    }
  }
  const content = richClipboardContent(holder);
  return content.text ? content : null;
}

const STRUCTURAL_TAGS = new Set(["OL", "UL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

/**
 * A range whose common ancestor is a list or table clones bare `li` or `td`
 * nodes without their parent, so the list or table would be lost. Wrap the
 * clone in shallow copies of the missing parents.
 */
function withStructuralParents(range: Range, container: Element, contents: DocumentFragment): DocumentFragment {
  let node: Element | null = isElement(range.commonAncestorContainer)
    ? range.commonAncestorContainer
    : null;
  if (!node || !STRUCTURAL_TAGS.has(node.tagName.toUpperCase())) return contents;
  const doc = container.ownerDocument;
  let wrapped: Node = contents;
  while (node && node !== container && STRUCTURAL_TAGS.has(node.tagName.toUpperCase())) {
    const shell = node.cloneNode(false);
    shell.appendChild(wrapped);
    wrapped = shell;
    if (node.tagName.toUpperCase() === "OL" || node.tagName.toUpperCase() === "UL" || node.tagName.toUpperCase() === "TABLE") break;
    node = node.parentElement;
  }
  const fragment = doc.createDocumentFragment();
  fragment.appendChild(wrapped);
  return fragment;
}

/**
 * A selection that starts on item 3 of a numbered list clones a list without
 * its position, so it would paste as "1.". Carry the real number across.
 */
function keepListNumbering(range: Range, container: Element, contents: DocumentFragment) {
  const startNode = range.startContainer;
  const startElement = isElement(startNode) ? startNode : startNode.parentElement;
  const item = startElement?.closest("li");
  const list = item?.parentElement;
  if (!item || !list || list.tagName.toUpperCase() !== "OL" || !container.contains(list)) return;
  const clonedList = contents.querySelector("ol");
  if (!clonedList) return;
  const listStart = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const position = Array.from(list.children).indexOf(item);
  if (position > 0 || listStart !== 1) clonedList.setAttribute("start", String(listStart + position));
}

/** Put both formats on the clipboard from inside a `copy` event. */
export function writeRichClipboardEvent(event: ClipboardEvent | { clipboardData: DataTransfer | null; preventDefault(): void }, content: RichClipboardContent): boolean {
  if (!event.clipboardData) return false;
  event.clipboardData.setData("text/html", content.html);
  event.clipboardData.setData("text/plain", content.text);
  event.preventDefault();
  return true;
}

/** Copy both formats from a button click. */
export async function copyRichTextToClipboard(content: RichClipboardContent): Promise<void> {
  const isSecure = typeof window === "undefined" || window.isSecureContext !== false;
  if (
    isSecure
    && typeof navigator !== "undefined"
    && typeof navigator.clipboard?.write === "function"
    && typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([content.html], { type: "text/html" }),
          "text/plain": new Blob([content.text], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Fall through to the copy-event path (plain HTTP, blocked permission).
    }
  }

  if (typeof document === "undefined") throw new Error("Clipboard unavailable");

  // execCommand("copy") fires a copy event we can fill with both formats. The
  // selected textarea keeps plain text working if the listener cannot run.
  const onCopy = (event: ClipboardEvent) => {
    writeRichClipboardEvent(event, content);
  };
  const textarea = document.createElement("textarea");
  textarea.value = content.text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  const previouslyFocused = document.activeElement as (Element & {
    focus?: (options?: FocusOptions) => void;
  }) | null;
  document.addEventListener("copy", onCopy, true);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    const success = document.execCommand("copy");
    if (!success) throw new Error("execCommand copy failed");
  } finally {
    document.removeEventListener("copy", onCopy, true);
    document.body.removeChild(textarea);
    if (previouslyFocused !== document.activeElement && typeof previouslyFocused?.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}
