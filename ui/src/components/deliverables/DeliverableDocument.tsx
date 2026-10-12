import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import type { Deliverable } from "@/api/deliverables";
import { getOutputFileGlyph } from "@/lib/issue-output";
import { cn } from "@/lib/utils";

/**
 * The iframe sandbox for agent-made HTML. It uses the same tokens the server
 * puts in the Content-Security-Policy of every HTML attachment, so a preview
 * here can do no more than the file opened on its own: scripts run in an
 * opaque origin, with no forms, no app cookies or storage, and no network.
 */
export const DELIVERABLE_IFRAME_SANDBOX = HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ");

/** Virtual viewport the thumbnail renders before it is scaled into the card. */
const THUMBNAIL_VIEWPORT = { width: 1280, height: 720 };

type DocumentSource = Pick<Deliverable, "contentType" | "contentPath" | "title" | "originalFilename">;

function normalizedType(contentType: string) {
  return contentType.toLowerCase().split(";")[0]!.trim();
}

export function isHtmlDeliverable(source: Pick<Deliverable, "contentType">) {
  const type = normalizedType(source.contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

export function isImageDeliverable(source: Pick<Deliverable, "contentType">) {
  return normalizedType(source.contentType).startsWith("image/");
}

function FileTile({ source, large = false }: { source: DocumentSource; large?: boolean }) {
  const glyph = getOutputFileGlyph(source.contentType);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/40 text-muted-foreground">
      <FileText className={large ? "h-12 w-12" : "h-8 w-8"} aria-hidden="true" />
      <span className="text-xs font-medium uppercase tracking-wide">{glyph.label}</span>
      {large ? (
        <span className="max-w-sm px-6 text-center text-sm">
          This file type has no in-app preview. Download it or open it in a new tab.
        </span>
      ) : null}
    </div>
  );
}

// Frames use bg-white on purpose: it is the browser's default page canvas, so a
// document with no background of its own looks the same here as in its own tab,
// in both themes. It is not a theme colour.

/** Live first screen of the document, scaled down into a card. */
export function DeliverableThumbnail({ source, className }: { source: DocumentSource; className?: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.25);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = box.getBoundingClientRect().width;
      if (width > 0) setScale(width / THUMBNAIL_VIEWPORT.width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      className={cn("relative aspect-video w-full overflow-hidden border-b border-border bg-background", className)}
    >
      {isHtmlDeliverable(source) ? (
        <iframe
          title={`${source.title} thumbnail`}
          src={source.contentPath}
          sandbox={DELIVERABLE_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="deliverable-thumbnail-frame"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white"
          style={{
            width: THUMBNAIL_VIEWPORT.width,
            height: THUMBNAIL_VIEWPORT.height,
            transform: `scale(${scale})`,
          }}
        />
      ) : isImageDeliverable(source) ? (
        <img src={source.contentPath} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
      ) : (
        <FileTile source={source} />
      )}
    </div>
  );
}

/** The document at full size, for Quick Look. */
export function DeliverableDocumentView({ source }: { source: DocumentSource }) {
  if (isHtmlDeliverable(source)) {
    return (
      <iframe
        key={source.contentPath}
        title={source.title}
        src={source.contentPath}
        sandbox={DELIVERABLE_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        data-testid="deliverable-preview-frame"
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  if (isImageDeliverable(source)) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-muted/40 p-6">
        <img src={source.contentPath} alt={source.title} className="max-h-full max-w-full object-contain shadow-sm" />
      </div>
    );
  }
  return <FileTile source={source} large />;
}
