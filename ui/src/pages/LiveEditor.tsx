import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HTML_ATTACHMENT_SANDBOX_TOKENS } from "@greatstone/shared";
import { ArrowLeft, Laptop, Maximize2, Smartphone } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { liveDesignApi } from "../api/liveDesign";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { ScaledFrame } from "../components/AttachmentPreviewPanel";
import { LiveDesignChat, useLiveDesign } from "../components/LiveDesignChat";

const SANDBOX = HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ");
const WIDTHS = { fit: null, laptop: 1440, phone: 390 } as const;

/**
 * Live design, full screen (John, 2 Nov): the chat with the agent on the left,
 * the page on the right (stacked on a phone). The page runs Impeccable's own
 * live tools; this page relays their helper calls to GSAM, which stands in for
 * Impeccable's local helper, so it works from any device.
 */
export function LiveEditor() {
  const { issueId = "", attachmentId = "" } = useParams<{ issueId: string; attachmentId: string }>();
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [pageId, setPageId] = useState(attachmentId);
  const [viewport, setViewport] = useState<keyof typeof WIDTHS>("fit");
  const live = useLiveDesign(attachmentId, true);
  const sessionId = live.sessionId;
  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
    enabled: !!issueId,
  });
  const fileName = attachments?.find((a) => a.id === pageId)?.originalFilename ?? "Page";

  const toFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, source: "gs-impeccable-host" }, "*");
  }, []);

  // Leaving the editor ends live design, which lets the agent's run finish.
  const endLive = live.end;
  useEffect(() => endLive, [endLive]);

  // Relay the page's helper calls and its event stream. Everything from the frame is untrusted.
  const streamRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const openStream = async () => {
      streamRef.current?.abort();
      const controller = new AbortController();
      streamRef.current = controller;
      let after: number | "start" = "start";
      while (!controller.signal.aborted) {
        try {
          const { cursor, frames } = await liveDesignApi.stream(sessionId, after, controller.signal);
          for (const f of frames) toFrame({ kind: "stream", data: f.data });
          after = cursor;
        } catch {
          if (controller.signal.aborted) return;
          toFrame({ kind: "stream-error" });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || m.source !== "gs-impeccable") return;
      if (m.kind === "stream-open") {
        void openStream();
      } else if (m.kind === "request" && typeof m.path === "string") {
        const rid = m.rid;
        const extra = m.extra && typeof m.extra === "object" ? (m.extra as { selector?: unknown }) : {};
        liveDesignApi
          .helper(sessionId, {
            method: m.method === "POST" ? "POST" : "GET",
            path: m.path.slice(0, 2000),
            body: typeof m.body === "string" ? m.body : null,
            extra: typeof extra.selector === "string" ? { selector: extra.selector.slice(0, 500) } : {},
          })
          .then((r) => toFrame({ kind: "response", rid, status: r.status, body: r.body, contentType: r.contentType }))
          .catch((err: unknown) =>
            toFrame({ kind: "response", rid, status: 502, body: JSON.stringify({ error: err instanceof Error ? err.message : "relay failed" }) }),
          );
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      streamRef.current?.abort();
    };
  }, [sessionId, toFrame]);

  // When the agent saves an accepted version, show the saved file.
  const applied = live.view?.appliedAttachmentId ?? null;
  useEffect(() => {
    if (!applied || applied === pageId) return;
    setPageId(applied);
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
  }, [applied, pageId, issueId, queryClient]);

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
          {sessionId ? (
            <ScaledFrame
              key={pageId}
              src={`/api/attachments/${pageId}/annotate?live=1`}
              title={`Live design of ${fileName}`}
              width={WIDTHS[viewport]}
              sandbox={SANDBOX}
              frameRef={frameRef}
              viewport={viewport}
            />
          ) : null}
        </div>
        <aside className="flex h-(--sz-42dvh) w-full flex-col border-t border-border md:order-1 md:h-auto md:w-96 md:border-r md:border-t-0">
          <LiveDesignChat live={live} />
        </aside>
      </div>
    </div>
  );
}

export default LiveEditor;
