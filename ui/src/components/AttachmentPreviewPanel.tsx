import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { ExternalLink, Laptop, Maximize2, Smartphone, X } from "lucide-react";
import { HTML_ATTACHMENT_SANDBOX_TOKENS, type IssueAttachment } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  ATTACHMENT_PREVIEW_STATE_KEY,
  attachmentContentPath,
  attachmentPreviewKind,
  parseAttachmentContentHref,
  readAttachmentPreviewState,
  withoutAttachmentPreviewState,
  type AttachmentPreviewState,
  type AttachmentPreviewTarget,
} from "@/lib/attachment-preview";

/**
 * Same tokens the server sends in the CSP of every HTML attachment, so the
 * page in the panel can do no more than the file opened in its own tab.
 */
const HTML_PREVIEW_SANDBOX = HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ");

type HtmlViewport = "fit" | "laptop" | "phone";

const VIEWPORT_WIDTHS: Record<Exclude<HtmlViewport, "fit">, number> = {
  laptop: 1440,
  phone: 390,
};

const VIEWPORT_OPTIONS: Array<{ value: HtmlViewport; label: string; icon: typeof Laptop }> = [
  { value: "fit", label: "Fit to panel", icon: Maximize2 },
  { value: "laptop", label: "Laptop width (1440 px)", icon: Laptop },
  { value: "phone", label: "Phone width (390 px)", icon: Smartphone },
];

/**
 * The issue view's attachment preview (GRE-1036). Returns a stable `open`
 * callback for links and the panel to render. The open panel lives in router
 * state on a new history entry, so browser Back closes it.
 */
export function useAttachmentPreview(attachments: readonly IssueAttachment[] | undefined) {
  const location = useLocation();
  const navigate = useNavigate();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const locationRef = useRef(location);
  locationRef.current = location;
  // Whether this page pushed the history entry the open panel lives on.
  // Closing pops that entry; a panel restored on reload is dropped in place.
  const pendingPushRef = useRef(false);
  const ownsEntryRef = useRef(false);

  const open = useCallback(
    (target: AttachmentPreviewTarget) => {
      const attachmentId = parseAttachmentContentHref(target.href);
      if (!attachmentId) return false;
      const meta = attachmentsRef.current?.find((attachment) => attachment.id === attachmentId);
      const name = meta?.originalFilename?.trim() || target.name?.trim() || "Attachment";
      const kind = attachmentPreviewKind({
        contentType: meta?.contentType ?? target.contentType,
        name: meta?.originalFilename ?? target.name,
      });
      if (!kind) return false;
      const current = locationRef.current;
      const preview: AttachmentPreviewState = {
        attachmentId,
        name,
        kind,
        pathname: current.pathname,
      };
      const baseState = withoutAttachmentPreviewState(current.state);
      // Swapping one preview for another does not stack history entries.
      const replace = readAttachmentPreviewState(current.state, current.pathname) !== null;
      if (!replace) pendingPushRef.current = true;
      navigate(
        { pathname: current.pathname, search: current.search, hash: current.hash },
        {
          replace,
          state: {
            ...(typeof baseState === "object" && baseState !== null ? baseState : {}),
            [ATTACHMENT_PREVIEW_STATE_KEY]: preview,
          },
          preventScrollReset: true,
        },
      );
      return true;
    },
    [navigate],
  );

  const preview = readAttachmentPreviewState(location.state, location.pathname);

  const isOpen = preview !== null;
  useEffect(() => {
    if (!isOpen) {
      ownsEntryRef.current = false;
    } else if (pendingPushRef.current) {
      ownsEntryRef.current = true;
    }
    pendingPushRef.current = false;
  }, [location.key, isOpen]);

  const close = useCallback(() => {
    const current = locationRef.current;
    if (!readAttachmentPreviewState(current.state, current.pathname)) return;
    if (ownsEntryRef.current) {
      ownsEntryRef.current = false;
      navigate(-1);
      return;
    }
    // Opened from a restored history entry: drop the panel in place.
    navigate(
      { pathname: current.pathname, search: current.search, hash: current.hash },
      { replace: true, state: withoutAttachmentPreviewState(current.state), preventScrollReset: true },
    );
  }, [navigate]);

  const panel = <AttachmentPreviewPanel preview={preview} onClose={close} />;
  return { open, close, preview, panel };
}

export function AttachmentPreviewPanel({
  preview,
  onClose,
}: {
  preview: AttachmentPreviewState | null;
  onClose: () => void;
}) {
  // Keep the last file on screen while the sheet slides out.
  const lastPreviewRef = useRef(preview);
  if (preview) lastPreviewRef.current = preview;
  const shown = preview ?? lastPreviewRef.current;
  const [viewport, setViewport] = useState<HtmlViewport>("fit");

  useEffect(() => {
    if (!preview) setViewport("fit");
  }, [preview]);

  const src = shown ? attachmentContentPath(shown.attachmentId) : "";

  return (
    <Sheet open={preview !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="attachment-preview-panel"
        // Full screen on phones; a wide reading pane beside the thread on
        // larger screens.
        className="w-full gap-0 p-0 sm:max-w-none md:w-(--sz-attachment-preview-panel)"
      >
        {shown ? (
          <>
            <div className="border-b border-border pt-(--sz-safe-top)">
            <div className="flex min-h-12 items-center gap-2 px-3 py-2">
              <SheetTitle className="min-w-0 flex-1 truncate text-sm" title={shown.name}>
                {shown.name}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Preview of {shown.name}. Press Escape to close.
              </SheetDescription>
              {shown.kind === "html" ? (
                <div
                  role="group"
                  aria-label="Preview width"
                  className="hidden items-center rounded-md border border-border p-0.5 sm:inline-flex"
                >
                  {VIEWPORT_OPTIONS.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      aria-label={label}
                      aria-pressed={viewport === value}
                      title={label}
                      onClick={() => setViewport(value)}
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
                        viewport === value && "bg-accent text-foreground",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                    </button>
                  ))}
                </div>
              ) : null}
              <Button asChild variant="ghost" size="icon-sm">
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in new tab"
                  title="Open in new tab"
                >
                  <ExternalLink aria-hidden="true" className="size-4" />
                </a>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close preview"
                title="Close (Esc)"
                onClick={onClose}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/40">
              <PreviewBody preview={shown} src={src} viewport={viewport} />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PreviewBody({
  preview,
  src,
  viewport,
}: {
  preview: AttachmentPreviewState;
  src: string;
  viewport: HtmlViewport;
}): ReactNode {
  if (preview.kind === "image") {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto p-4">
        <img src={src} alt={preview.name} className="max-h-full max-w-full object-contain shadow-sm" />
      </div>
    );
  }
  if (preview.kind === "pdf") {
    // Browsers refuse to run their PDF viewer in a sandboxed frame. The PDF
    // is served from our own origin, the same as opening it in a new tab.
    return (
      <iframe
        key={src}
        title={preview.name}
        src={src}
        referrerPolicy="no-referrer"
        data-testid="attachment-preview-frame"
        className="h-full w-full border-0 bg-background"
      />
    );
  }
  return <HtmlPreviewFrame key={src} src={src} title={preview.name} viewport={viewport} />;
}

/**
 * Agent-made HTML in a sandboxed frame. Laptop and phone widths lay the page
 * out at that width and scale it down to fit, which is how mock-ups are
 * reviewed.
 */
function HtmlPreviewFrame({
  src,
  title,
  viewport,
}: {
  src: string;
  title: string;
  viewport: HtmlViewport;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setBox((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameWidth = viewport === "fit" ? null : VIEWPORT_WIDTHS[viewport];
  const scale = frameWidth && box.width > 0 ? Math.min(1, box.width / frameWidth) : 1;
  const frameStyle: React.CSSProperties | undefined = frameWidth
    ? {
        width: frameWidth,
        height: box.height > 0 ? box.height / scale : "100%",
        transform: scale < 1 ? `scale(${scale})` : undefined,
        transformOrigin: "top left",
        left: Math.max(0, (box.width - frameWidth * scale) / 2),
      }
    : undefined;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <iframe
        title={title}
        src={src}
        sandbox={HTML_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        data-testid="attachment-preview-frame"
        data-viewport={viewport}
        style={frameStyle}
        className={cn(
          "absolute top-0 border-0 bg-white",
          frameWidth ? "shadow-sm" : "left-0 h-full w-full",
        )}
      />
    </div>
  );
}
