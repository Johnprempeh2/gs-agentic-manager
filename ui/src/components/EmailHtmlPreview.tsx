import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The fenced-block language the server uses for an HTML email body on a send
 * approval card (GRE-965). Keep in sync with `EMAIL_HTML_FENCE_LANGUAGE` in
 * `server/src/services/tool-send-preview.ts`.
 */
export const EMAIL_HTML_FENCE_LANGUAGE = "email-html";

/**
 * Nothing in the frame may load from the network: no scripts, frames, styles
 * or images from a URL. Inline styles and `data:` images still show, so the
 * mail looks as the author wrote it, minus remote content.
 */
const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'";

/** Mail clients show a white page; a dark app theme must not leak into the frame. */
const FRAME_BASE_STYLE =
  "html{background:#fff;color:#111;}body{margin:12px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.45;overflow-wrap:anywhere;}img{max-width:100%;height:auto;}";

/**
 * Build the frame document. The HTML is parsed inert (no scripts run, nothing
 * loads), then links are switched off, because the sandbox stops scripts and
 * pop-ups but not a click that opens a remote page inside the frame. Each
 * link keeps its address as a tooltip, so the approver can see where it goes.
 */
export function buildEmailPreviewDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, base, meta[http-equiv]").forEach((element) => element.remove());
  doc.querySelectorAll("a, area").forEach((element) => {
    const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
    element.removeAttribute("href");
    element.removeAttribute("xlink:href");
    element.removeAttribute("target");
    if (href) element.setAttribute("title", href);
  });
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_BASE_STYLE}</style>`;
  return `<!doctype html><html><head>${head}${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`;
}

/**
 * An HTML email body shown as the recipient will see it, in a frame with every
 * sandbox restriction on (no scripts, forms, pop-ups or same-origin access),
 * with a toggle to read the source instead.
 */
export function EmailHtmlPreview({ html }: { html: string }) {
  const [showSource, setShowSource] = useState(false);
  const srcDoc = useMemo(() => buildEmailPreviewDocument(html), [html]);

  return (
    <div className="not-prose my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1">
        <span className="text-xs text-muted-foreground">
          {showSource ? "HTML source" : "As the recipient sees it (images from the web are not loaded)"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={showSource}
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? "Show email" : "Show source"}
        </Button>
      </div>
      {showSource ? (
        <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-background p-2 font-mono text-xs">
          <code>{html}</code>
        </pre>
      ) : (
        <iframe
          title="Email preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="block h-80 w-full bg-white"
        />
      )}
    </div>
  );
}
