// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyRichTextToClipboard,
  richClipboardContent,
  richClipboardContentForSelection,
} from "./rich-clipboard";
import { markdownClipboardContent } from "./markdown-clipboard";

function rendered(html: string): HTMLDivElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("richClipboardContent", () => {
  it("strips styles, classes and backgrounds but keeps list and link structure", () => {
    const host = rendered(`
      <div class="paperclip-markdown prose" style="background-color: rgb(240,240,240); font-family: Inter">
        <p class="x" style="color: #333; line-height: 1.6; overflow-wrap: anywhere">Hello <strong style="color:red">John</strong>, see <a class="link" style="color:blue" href="https://example.com/doc" target="_blank" rel="noopener">the doc<svg aria-hidden="true"></svg></a>.</p>
        <ol style="background: #eee" data-x="1">
          <li style="background: #eee">First</li>
          <li><em>Second</em></li>
        </ol>
        <ul><li>Bullet</li></ul>
      </div>
    `);

    const { html, text } = richClipboardContent(host, "https://gsam.local/issues/GRE-1");

    expect(html).not.toMatch(/style=|class=|data-|target=|rel=|background|color|<svg|<div|<span/);
    expect(html).toContain('<p>Hello <strong>John</strong>, see <a href="https://example.com/doc">the doc</a>.</p>');
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li><em>Second</em></li>");
    expect(html).toContain("<ul>");

    expect(text).toBe(
      "Hello John, see the doc (https://example.com/doc).\n\n1. First\n2. Second\n\n- Bullet",
    );
  });

  it("keeps code blocks as plain monospace text without the copy controls", () => {
    const host = rendered(`
      <div class="paperclip-markdown-codeblock">
        <pre style="overflow-x:auto"><code class="language-ts"><span class="hl">const a = 1;</span>
const b = 2;
</code></pre>
        <div class="paperclip-markdown-codeblock-actions"><button>Wrap</button><button><span>Copy</span></button></div>
      </div>
    `);

    const { html, text } = richClipboardContent(host);

    expect(html.trim()).toBe("<pre>const a = 1;\nconst b = 2;</pre>");
    expect(text).toBe("const a = 1;\nconst b = 2;");
  });

  it("drops unsafe links, makes app links absolute and maps deep headings to h3", () => {
    const host = rendered(`
      <h5>Deep</h5>
      <p><a href="javascript:alert(1)">bad</a> and <a href="/issues/GRE-1">GRE-1</a></p>
    `);

    const { html, text } = richClipboardContent(host, "https://gsam.local/issues/GRE-2");

    expect(html).toContain("<h3>Deep</h3>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://gsam.local/issues/GRE-1">GRE-1</a>');
    expect(text).toBe("Deep\n\nbad and GRE-1");
  });

  it("nests sub-lists and keeps a list's start number", () => {
    const host = rendered(`<ol start="3"><li>Three<ul><li>Child</li></ul></li><li>Four</li></ol>`);

    const { html, text } = richClipboardContent(host);

    expect(html).toContain('<ol start="3">');
    expect(text).toBe("3. Three\n   - Child\n4. Four");
  });
});

describe("richClipboardContentForSelection", () => {
  it("keeps the real number when a selection starts part-way down a numbered list", () => {
    const host = rendered(`<ol><li>One</li><li>Two</li><li>Three</li></ol>`);
    const items = host.querySelectorAll("li");
    const range = document.createRange();
    range.setStart(items[1]!.firstChild!, 0);
    range.setEnd(items[2]!.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const content = richClipboardContentForSelection(selection, host);

    expect(content?.html).toContain('<ol start="2">');
    expect(content?.text).toBe("2. Two\n3. Three");
  });

  it("ignores selections outside the container", () => {
    const host = rendered(`<p>Inside</p>`);
    const outside = rendered(`<p>Outside</p>`);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(richClipboardContentForSelection(selection, host)).toBeNull();
  });
});

describe("markdownClipboardContent", () => {
  it("turns a markdown message into clean html and plain text", () => {
    const { html, text } = markdownClipboardContent(
      "Dear Ama,\n\nPlease send:\n\n1. The **audited** accounts\n2. The [org chart](https://example.com/org)\n\nThanks",
    );

    expect(html).not.toMatch(/style=|class=/);
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>audited</strong>");
    expect(text).toBe(
      "Dear Ama,\n\nPlease send:\n\n1. The audited accounts\n2. The org chart (https://example.com/org)\n\nThanks",
    );
  });
});

describe("copyRichTextToClipboard", () => {
  it("fills a copy event with both formats when the Clipboard API is not available", async () => {
    const setData = vi.fn();
    const execCommand = vi.fn(() => {
      const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      document.dispatchEvent(event);
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await copyRichTextToClipboard({ html: "<p>Hi</p>", text: "Hi" });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(setData).toHaveBeenCalledWith("text/html", "<p>Hi</p>");
    expect(setData).toHaveBeenCalledWith("text/plain", "Hi");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
