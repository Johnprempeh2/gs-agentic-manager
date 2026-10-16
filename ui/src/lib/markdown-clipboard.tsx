import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSoftBreaks } from "./remark-soft-breaks";
import { copyRichTextToClipboard, richClipboardContent, type RichClipboardContent } from "./rich-clipboard";

/**
 * Clean HTML and plain text for a whole markdown body (GRE-1585). Renders the
 * markdown off-screen with plain tags, then runs the same sanitiser as a
 * selection copy, so a Copy button and Ctrl+C paste the same way.
 */
export function markdownClipboardContent(markdown: string): RichClipboardContent {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(<Markdown remarkPlugins={[remarkGfm, remarkSoftBreaks]}>{markdown}</Markdown>);
    });
    return richClipboardContent(host, window.location.href);
  } finally {
    root.unmount();
  }
}

export async function copyMarkdownToClipboard(markdown: string): Promise<void> {
  await copyRichTextToClipboard(markdownClipboardContent(markdown));
}
