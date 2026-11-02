import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import { ArrowLeft, Laptop, Maximize2, Smartphone } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { ScaledFrame } from "../components/AttachmentPreviewPanel";
import { LiveDesignChat, useLiveDesign, type LiveSelection } from "../components/LiveDesignChat";

const SANDBOX = HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ");
const WIDTHS = { fit: null, laptop: 1440, phone: 390 } as const;
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * Live design, full screen (John, 2 Nov): the chat with the agent on the left,
 * the page on the right (stacked on a phone). Tap anything, ask for a change,
 * flick through the agent's versions in place and keep one.
 */
export function LiveEditor() {
  const { issueId = "", attachmentId = "" } = useParams<{ issueId: string; attachmentId: string }>();
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [pageId, setPageId] = useState(attachmentId);
  const [selection, setSelection] = useState<LiveSelection | null>(null);
  const [viewport, setViewport] = useState<keyof typeof WIDTHS>("fit");
  const live = useLiveDesign(pageId, true);
  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
    enabled: !!issueId,
  });
  const fileName = attachments?.find((a) => a.id === pageId)?.originalFilename ?? "Page";

  const toFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, source: "gs-review-host" }, "*");
  }, []);

  // Leaving the editor ends live design, which lets the agent's run finish.
  const endLive = live.end;
  useEffect(() => endLive, [endLive]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || data.source !== "gs-review") return;
      if (data.type === "ready") {
        toFrame({ type: "mode", mode: "live" });
      } else if (data.type === "select") {
        setSelection({
          selector: str(data.selector, 500),
          tag: str(data.tag, 40) || "element",
          text: str(data.text, 300),
          cls: str(data.cls, 200),
          role: str(data.role, 40),
          alt: str(data.alt, 120),
          looksButton: data.looksButton === true,
          html: str(data.html, 20000),
          hasParent: data.hasParent === true,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [toFrame]);

  const onApplied = useCallback(
    (id: string) => {
      setSelection(null);
      setPageId(id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
    },
    [issueId, queryClient],
  );

  return (
    <div className="fixed inset-0 z-dialog flex flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 pt-(--sz-pad-safe-top)">
        <Link
          to={`/issues/${issueId}`}
          disableIssueQuicklook
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Back to the task"
          title="Back to the task"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{fileName}</h1>
          <p className="truncate text-xs text-muted-foreground">Live design</p>
        </div>
        <div role="group" aria-label="Page width" className="hidden items-center rounded-md border border-border p-0.5 md:inline-flex">
          {([
            ["fit", "Fit", Maximize2],
            ["laptop", "Laptop width (1440 px)", Laptop],
            ["phone", "Phone width (390 px)", Smartphone],
          ] as const).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={viewport === value}
              title={label}
              onClick={() => setViewport(value)}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground",
                viewport === value && "bg-accent text-foreground",
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/40 md:order-2">
          <ScaledFrame
            key={pageId}
            src={`/api/attachments/${pageId}/annotate`}
            title={`Live design of ${fileName}`}
            width={WIDTHS[viewport]}
            sandbox={SANDBOX}
            frameRef={frameRef}
            viewport={viewport}
          />
        </div>
        <aside className="flex h-(--sz-42dvh) w-full flex-col border-t border-border md:order-1 md:h-auto md:w-96 md:border-r md:border-t-0">
          <LiveDesignChat live={live} selection={selection} toFrame={toFrame} onApplied={onApplied} />
        </aside>
      </div>
    </div>
  );
}

export default LiveEditor;
