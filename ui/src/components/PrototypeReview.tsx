import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useQueryClient } from "@tanstack/react-query";
import { HTML_ATTACHMENT_SANDBOX_TOKENS, PROTOTYPE_REVIEW_STROKE_COLOR, prototypeReviewMarkdown, prototypeReviewMarkupSchema, type PrototypeReviewMarkup } from "@greatstone/shared";
import { Laptop, Maximize2, MessageSquarePlus, MousePointer2, Pencil, Send, Smartphone, Trash2, Type, Undo2, X } from "lucide-react";
import { issuesApi } from "../api/issues";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { ScaledFrame } from "./AttachmentPreviewPanel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Tool = "browse" | "comment" | "draw" | "edit";
type Markup = Omit<PrototypeReviewMarkup, "width" | "note">;
type Change = { kind: "pin" | "stroke" | "edit" };

const SANDBOX = HTML_ATTACHMENT_SANDBOX_TOKENS.join(" ");
const WIDTHS = { fit: null, laptop: 1440, phone: 390 } as const;
const EMPTY: Markup = { pins: [], strokes: [], edits: [] };

const TOOLS: Array<{ value: Tool; label: string; hint: string; icon: typeof Pencil }> = [
  { value: "browse", label: "Browse", hint: "Use the prototype normally", icon: MousePointer2 },
  { value: "comment", label: "Comment", hint: "Click anything to pin a comment", icon: MessageSquarePlus },
  { value: "draw", label: "Draw", hint: "Draw on the page", icon: Pencil },
  { value: "edit", label: "Edit text", hint: "Click any text and retype it", icon: Type },
];

const draftKey = (attachmentId: string) => `gs-prototype-review:${attachmentId}`;
const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

function readDraft(attachmentId: string): { markup: Markup; note: string } {
  try {
    const raw = localStorage.getItem(draftKey(attachmentId));
    if (raw) {
      const parsed = JSON.parse(raw) as { markup?: Markup; note?: string };
      return { markup: { ...EMPTY, ...parsed.markup }, note: parsed.note ?? "" };
    }
  } catch {
    // A blocked or corrupt store starts a fresh review.
  }
  return { markup: EMPTY, note: "" };
}

/**
 * John marks up an agent's HTML prototype in place: numbered comment pins,
 * freehand drawing and text edits, then sends it all to the task as one
 * comment with a marked-up image. The page runs in the attachment sandbox;
 * its messages are treated as untrusted input.
 */
export function PrototypeReview({
  attachmentId,
  issueId,
  companyId,
  name,
  open,
  onOpenChange,
}: {
  attachmentId: string;
  issueId: string;
  companyId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const toast = useOptionalToastActions();
  const queryClient = useQueryClient();
  const [tool, setTool] = useState<Tool>("comment");
  const [viewport, setViewport] = useState<keyof typeof WIDTHS>("fit");
  const [{ markup, note }, setDraft] = useState(() => readDraft(attachmentId));
  const [history, setHistory] = useState<Change[]>([]);
  const [pageWidth, setPageWidth] = useState(1440);
  const [focusPin, setFocusPin] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const src = `/api/attachments/${attachmentId}/annotate`;

  const toFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, source: "gs-review-host" }, "*");
  }, []);

  // Keep the page in step with the draft and the chosen tool.
  useEffect(() => toFrame({ type: "state", state: markup }), [markup, toFrame]);
  useEffect(() => toFrame({ type: "mode", mode: tool }), [tool, toFrame]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(attachmentId), JSON.stringify({ markup, note }));
    } catch {
      // The draft is a convenience; the review still works without it.
    }
  }, [attachmentId, markup, note]);

  const update = useCallback((change: Change["kind"], fn: (m: Markup) => Markup) => {
    setDraft((d) => ({ ...d, markup: fn(d.markup) }));
    setHistory((h) => [...h, { kind: change }]);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || data.source !== "gs-review") return;
      if (data.type === "ready") {
        setPageWidth(Math.min(2560, Math.max(280, num(data.width))));
        toFrame({ type: "state", state: markup });
        toFrame({ type: "mode", mode: tool });
      } else if (data.type === "pick") {
        const pin = { x: num(data.x), y: num(data.y), selector: str(data.selector, 500), tag: str(data.tag, 40) || "element", text: str(data.text, 300), note: "" };
        update("pin", (m) => ({ ...m, pins: [...m.pins, pin].slice(0, 100) }));
        setFocusPin(markup.pins.length);
      } else if (data.type === "stroke" && Array.isArray(data.points)) {
        const points = (data.points as unknown[])
          .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2)
          .slice(0, 2000)
          .map((p) => [num(p[0]), num(p[1])] as [number, number]);
        if (points.length >= 2) update("stroke", (m) => ({ ...m, strokes: [...m.strokes, { color: PROTOTYPE_REVIEW_STROKE_COLOR, points }].slice(0, 200) }));
      } else if (data.type === "edit") {
        const selector = str(data.selector, 500);
        const before = str(data.before, 4000);
        const after = str(data.after, 4000);
        const others = (m: Markup) => m.edits.filter((x) => x.selector !== selector);
        if (before.trim() === after.trim()) setDraft((d) => ({ ...d, markup: { ...d.markup, edits: others(d.markup) } }));
        else update("edit", (m) => ({ ...m, edits: [...others(m), { selector, before, after }].slice(0, 100) }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [markup, tool, toFrame, update]);

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    const key = last.kind === "pin" ? "pins" : last.kind === "stroke" ? "strokes" : "edits";
    setDraft((d) => ({ ...d, markup: { ...d.markup, [key]: d.markup[key].slice(0, -1) } }));
  };

  const count = markup.pins.length + markup.strokes.length + markup.edits.length;
  const fileName = name || "prototype";

  const send = async () => {
    const parsed = prototypeReviewMarkupSchema.safeParse({ ...markup, width: pageWidth, note });
    if (!parsed.success) {
      toast?.pushToast({ title: "This review cannot be sent", body: parsed.error.issues[0]?.message, tone: "error" });
      return;
    }
    setSending(true);
    try {
      let imageIds: string[] = [];
      const response = await fetch(`/api/attachments/${attachmentId}/annotate/render`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (response.status === 200) {
        const file = new File([await response.blob()], `review-${fileName.replace(/\.[a-z]+$/i, "")}.png`, { type: "image/png" });
        imageIds = [(await issuesApi.uploadAttachment(companyId, issueId, file)).id];
      } else if (response.status !== 204) {
        throw new Error(`The marked-up image failed (${response.status})`);
      }
      await issuesApi.addComment(
        issueId,
        prototypeReviewMarkdown(parsed.data, { fileName, imageAttached: imageIds.length > 0 }),
        undefined,
        undefined,
        imageIds,
      );
      try {
        localStorage.removeItem(draftKey(attachmentId));
      } catch {
        // Nothing to clean up.
      }
      setDraft({ markup: EMPTY, note: "" });
      setHistory([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
      toast?.pushToast({ title: "Review sent", body: "The agent gets it on the task now.", tone: "success" });
      onOpenChange(false);
    } catch (err) {
      toast?.pushToast({ title: "The review was not sent", body: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally {
      setSending(false);
    }
  };

  const activeHint = useMemo(() => TOOLS.find((t) => t.value === tool)?.hint ?? "", [tool]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
          onEscapeKeyDown={(e) => {
            // Escape leaves a tool first, then closes.
            if (tool !== "browse") {
              e.preventDefault();
              setTool("browse");
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Review {fileName}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Pin comments, draw and edit text on the prototype, then send your review to the agent.
          </DialogPrimitive.Description>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 pt-(--prototype-review-bar-pt)">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{fileName}</div>
              <div className="truncate text-xs text-muted-foreground">{activeHint}</div>
            </div>
            <div role="toolbar" aria-label="Review tools" className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {TOOLS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tool === value}
                  title={label}
                  onClick={() => setTool(value)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                    tool === value && "bg-accent text-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
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
            <Button type="button" variant="ghost" size="icon-sm" onClick={undo} disabled={history.length === 0} aria-label="Undo" title="Undo">
              <Undo2 aria-hidden="true" className="size-4" />
            </Button>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close review" title="Close (your review is kept)">
                <X aria-hidden="true" className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="relative min-h-(--prototype-review-frame-min-h) flex-1 overflow-hidden bg-muted/40">
              <ScaledFrame src={src} title={`Review of ${fileName}`} width={WIDTHS[viewport]} sandbox={SANDBOX} frameRef={frameRef} viewport={viewport} />
            </div>

            <aside className="flex max-h-(--prototype-review-panel-max-h) w-full flex-col border-t border-border md:max-h-none md:w-80 md:border-l md:border-t-0">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">Overall note (optional)</span>
                  <Textarea
                    value={note}
                    onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                    placeholder="What should change overall?"
                    rows={2}
                  />
                </label>

                {markup.pins.length === 0 && markup.edits.length === 0 && markup.strokes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Pick Comment and click anything on the page, Draw to mark it up, or Edit text to retype a line.
                  </p>
                ) : null}

                {markup.pins.length > 0 ? (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</h3>
                    <ol className="space-y-3">
                      {markup.pins.map((pin, i) => (
                        <li key={`${pin.x}-${pin.y}-${i}`} className="space-y-1.5">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-(length:--text-micro) font-bold text-primary-foreground">
                              {i + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={pin.text}>
                              {pin.tag}{pin.text ? `: ${pin.text}` : ""}
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove comment ${i + 1}`}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setDraft((d) => ({ ...d, markup: { ...d.markup, pins: d.markup.pins.filter((_, j) => j !== i) } }))}
                            >
                              <Trash2 aria-hidden="true" className="size-3.5" />
                            </button>
                          </div>
                          <Textarea
                            autoFocus={focusPin === i}
                            value={pin.note}
                            rows={2}
                            placeholder="Your comment"
                            onFocus={() => setFocusPin(null)}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                markup: { ...d.markup, pins: d.markup.pins.map((p, j) => (j === i ? { ...p, note: e.target.value } : p)) },
                              }))
                            }
                          />
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}

                {markup.edits.length > 0 ? (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Text changes</h3>
                    <ul className="space-y-2 text-sm">
                      {markup.edits.map((edit) => (
                        <li key={edit.selector} className="flex items-start gap-2">
                          <span className="min-w-0 flex-1">
                            <del className="text-muted-foreground">{edit.before}</del>{" "}
                            <ins className="font-medium text-chart-2 no-underline">{edit.after}</ins>
                          </span>
                          <button
                            type="button"
                            aria-label="Remove this text change"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => setDraft((d) => ({ ...d, markup: { ...d.markup, edits: d.markup.edits.filter((x) => x.selector !== edit.selector) } }))}
                          >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {markup.strokes.length > 0 ? (
                  <div className="flex items-center justify-between text-sm">
                    <span>{markup.strokes.length} drawing{markup.strokes.length === 1 ? "" : "s"}</span>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline hover:text-foreground"
                      onClick={() => setDraft((d) => ({ ...d, markup: { ...d.markup, strokes: [] } }))}
                    >
                      Clear drawings
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="border-t border-border p-3 pb-(--prototype-review-footer-pb)">
                <Button type="button" className="w-full" disabled={sending || (count === 0 && !note.trim())} onClick={() => void send()}>
                  <Send aria-hidden="true" className="size-4" />
                  {sending ? "Sending…" : "Send to the agent"}
                </Button>
              </div>
            </aside>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
