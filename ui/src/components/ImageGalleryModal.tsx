import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { attachmentDownloadPath, attachmentFilename } from "@/lib/issue-attachments";
import { isVideoLikeOutput } from "@/lib/issue-output";

export interface GalleryMediaItem {
  id: string;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
  contentType: string;
  originalFilename: string | null;
}

const BEFORE_AFTER = /(^|[-_ .])(before|after)(?=[-_ .]|$)/i;

/**
 * The other half of a before/after pair, matched by filename
 * ("before-dashboard-dark.png" and "after-dashboard-dark.png"), so a design
 * change can be judged side by side. Null when the item has no partner.
 */
export function beforeAfterPair(
  items: GalleryMediaItem[],
  index: number,
): { before: GalleryMediaItem; after: GalleryMediaItem } | null {
  const current = items[index];
  const name = current?.originalFilename;
  const match = name ? BEFORE_AFTER.exec(name) : null;
  if (!current || !name || !match) return null;
  const isBefore = match[2]!.toLowerCase() === "before";
  const partnerName = name.toLowerCase().replace(BEFORE_AFTER, (_whole, lead: string) => lead + (isBefore ? "after" : "before"));
  const partner = items.find((item) => item !== current && item.originalFilename?.toLowerCase() === partnerName);
  if (!partner) return null;
  return isBefore ? { before: current, after: partner } : { before: partner, after: current };
}

interface ImageGalleryModalProps {
  items: GalleryMediaItem[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageGalleryModal({
  items,
  initialIndex,
  open,
  onOpenChange,
}: ImageGalleryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const setMediaRef = useCallback((node: HTMLImageElement | HTMLVideoElement | null) => {
    mediaRef.current = node;
  }, []);

  useEffect(() => {
    if (open) setCurrentIndex(initialIndex);
  }, [open, initialIndex]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % items.length);
  }, [items.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + items.length) % items.length);
  }, [items.length]);

  useEffect(() => {
    if (currentIndex < items.length) return;
    setCurrentIndex(0);
  }, [currentIndex, items.length]);

  const pair = useMemo(() => beforeAfterPair(items, currentIndex), [items, currentIndex]);
  const [comparing, setComparing] = useState(false);
  const [split, setSplit] = useState(50);
  useEffect(() => {
    if (!pair) setComparing(false);
  }, [pair]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // The compare slider uses the arrow keys itself.
      if ((e.target as HTMLElement | null)?.tagName === "INPUT" && e.key !== "Escape") return;
      if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, goNext, goPrev, onOpenChange]);

  /** Close when clicking empty curtain space (not interactive elements or the image) */
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("button") ||
        target.closest("a") ||
        target.closest("[data-gallery-compare]") ||
        target === mediaRef.current
      )
        return;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  if (items.length === 0) return null;

  const current = items[currentIndex];
  if (!current) return null;
  const filename = attachmentFilename(current);
  const isVideo = isVideoLikeOutput(current.contentType, current.originalFilename);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Full-screen curtain */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200"
          onClick={handleBackdropClick}
        >
          {/* Top bar */}
          <div className="flex items-center justify-between px-5 py-3 text-white/80 text-sm shrink-0">
            <span className="truncate max-w-(--pct-50) font-medium" title={filename}>
              {filename}
            </span>
            <div className="flex items-center gap-4">
              {pair && !isVideo && (
                <button
                  type="button"
                  onClick={() => setComparing((value) => !value)}
                  aria-pressed={comparing}
                  className="rounded-full border border-white/20 px-3 py-1 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {comparing ? "Single view" : "Compare before and after"}
                </button>
              )}
              <span className="text-white/40 tabular-nums text-xs">
                {currentIndex + 1} / {items.length}
              </span>
              <a
                href={attachmentDownloadPath(current)}
                download={filename}
                className="text-white/50 hover:text-white transition-colors"
                title="Download"
                aria-label={`Download ${filename}`}
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="h-4.5 w-4.5" />
              </a>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-white/50 hover:text-white transition-colors"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Main area: nav buttons outside image */}
          <div className="flex-1 flex items-center min-h-0">
            {/* Left nav zone */}
            <div className="w-16 md:w-24 shrink-0 flex items-center justify-center h-full">
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={goPrev}
                  className="rounded-full bg-white/10 p-3 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                  title="Previous"
                >
                  <ChevronLeft className="h-7 w-7" />
                </button>
              )}
            </div>

            {/* Media */}
            <div className="flex-1 flex items-center justify-center min-w-0 min-h-0 h-full px-2">
              {comparing && pair ? (
                <div className="relative max-w-full max-h-full" data-gallery-compare>
                  <img
                    ref={setMediaRef}
                    src={pair.after.contentPath}
                    alt={attachmentFilename(pair.after)}
                    className="block max-w-full max-h-full object-contain select-none rounded-lg"
                    draggable={false}
                  />
                  <img
                    src={pair.before.contentPath}
                    alt={attachmentFilename(pair.before)}
                    className="absolute inset-0 h-full w-full object-contain select-none rounded-lg"
                    style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                    draggable={false}
                  />
                  <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80 shadow" style={{ left: `${split}%` }} />
                  <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">Before</span>
                  <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">After</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    onChange={(e) => setSplit(Number(e.target.value))}
                    aria-label="Move the divider between before and after"
                    className="absolute inset-x-6 bottom-4 accent-white"
                  />
                </div>
              ) : isVideo ? (
                <video
                  ref={setMediaRef}
                  src={current.contentPath}
                  className="max-w-full max-h-full rounded-lg"
                  controls
                  playsInline
                />
              ) : (
                <img
                  ref={setMediaRef}
                  src={current.contentPath}
                  alt={filename}
                  className="max-w-full max-h-full object-contain select-none rounded-lg"
                  draggable={false}
                />
              )}
            </div>

            {/* Right nav zone */}
            <div className="w-16 md:w-24 shrink-0 flex items-center justify-center h-full">
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={goNext}
                  className="rounded-full bg-white/10 p-3 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                  title="Next"
                >
                  <ChevronRight className="h-7 w-7" />
                </button>
              )}
            </div>
          </div>

          {/* Bottom padding for balance */}
          <div className="h-6 shrink-0" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
