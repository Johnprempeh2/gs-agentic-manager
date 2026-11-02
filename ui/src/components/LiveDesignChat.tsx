import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveDesignView } from "@greatstone/shared";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Expand, Loader2, X } from "lucide-react";
import { liveDesignApi } from "../api/liveDesign";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface LiveSelection {
  selector: string;
  tag: string;
  text: string;
  cls: string;
  role: string;
  alt: string;
  looksButton: boolean;
  html: string;
  hasParent: boolean;
}

const KINDS: Record<string, string> = {
  a: "Link", button: "Button", p: "Paragraph", img: "Image", svg: "Graphic", nav: "Navigation",
  header: "Header", footer: "Footer", main: "Main page area", section: "Section", article: "Card",
  aside: "Side panel", ul: "List", ol: "List", li: "List item", form: "Form", input: "Field",
  textarea: "Field", select: "Field", table: "Table", label: "Label", blockquote: "Quote", figure: "Figure",
};

/** "Button: “Book the diagnostic”" rather than a.btn.primary. */
export function liveLabel(s: Pick<LiveSelection, "tag" | "text" | "cls" | "role" | "alt" | "looksButton">) {
  const kind =
    s.tag === "button" || s.role === "button" || s.looksButton || /\b(btn|button)\b/i.test(s.cls)
      ? "Button"
      : /^h[1-6]$/.test(s.tag)
        ? "Heading"
        : KINDS[s.tag] ?? "Block";
  const words = (s.alt || s.text).trim();
  return words ? `${kind}: “${words.length > 48 ? `${words.slice(0, 47)}…` : words}”` : kind;
}

/** The live session for one page: started on open, polled while open, ended on close. */
export function useLiveDesign(attachmentId: string, active: boolean) {
  const [view, setView] = useState<LiveDesignView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active || idRef.current) return;
    let cancelled = false;
    liveDesignApi
      .start(attachmentId)
      .then((v) => {
        if (cancelled) return;
        idRef.current = v.id;
        setView(v);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Live design could not start"));
    return () => {
      cancelled = true;
    };
  }, [active, attachmentId]);

  const polling = active && !!view && view.status !== "ended";
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (!idRef.current) return;
      liveDesignApi.get(idRef.current).then(setView).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [polling]);

  const end = useCallback(() => {
    const id = idRef.current;
    idRef.current = null;
    setView(null);
    if (id) void liveDesignApi.end(id).catch(() => undefined);
  }, []);

  const run = useCallback(async (fn: (id: string) => Promise<LiveDesignView>) => {
    if (!idRef.current) return false;
    setError(null);
    try {
      setView(await fn(idRef.current));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work");
      return false;
    }
  }, []);

  return { view, error, end, run };
}

function useElapsed(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0;
}

/**
 * The editor's chat column: what John asked, what the agent says and the
 * versions to choose from. The page beside it shows each version in place.
 */
export function LiveDesignChat({
  live,
  selection,
  toFrame,
  onApplied,
}: {
  live: ReturnType<typeof useLiveDesign>;
  selection: LiveSelection | null;
  toFrame: (message: Record<string, unknown>) => void;
  onApplied: (attachmentId: string) => void;
}) {
  const { view, error, run } = live;
  const [prompt, setPrompt] = useState("");
  const [index, setIndex] = useState(0);
  // On a phone the request box hides while John chooses, so the chat keeps its room.
  const [asking, setAsking] = useState(false);
  const variants = view?.variants ?? [];
  const status = view?.status;
  const choosing = status === "ready" || status === "applying";
  const busy = status === "generating" || status === "applying";
  const elapsed = useElapsed(view?.request?.startedAt, status === "generating");
  const listRef = useRef<HTMLOListElement>(null);
  const messageCount = view?.messages.length ?? 0;

  // Show the chosen version in the page; the original comes back otherwise.
  useEffect(() => {
    toFrame({ type: "live-version", version: choosing ? variants[index] ?? null : null });
  }, [choosing, variants, index, toFrame]);
  useEffect(() => {
    setIndex(0);
    setAsking(false);
  }, [view?.request?.id]);
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messageCount, status]);

  const applied = view?.appliedAttachmentId ?? null;
  const seenApplied = useRef(applied);
  useEffect(() => {
    if (applied && applied !== seenApplied.current) {
      seenApplied.current = applied;
      onApplied(applied);
    }
  }, [applied, onApplied]);

  const send = () => {
    if (!selection || !prompt.trim() || busy) return;
    void run((id) =>
      liveDesignApi.request(id, {
        selector: selection.selector,
        tag: selection.tag,
        label: liveLabel(selection),
        text: selection.text,
        html: selection.html,
        prompt: prompt.trim(),
      }),
    ).then((ok) => ok && setPrompt(""));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentLine view={view} />

      <ol ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-label="Live design chat" aria-live="polite">
        {messageCount === 0 ? (
          <li className="text-sm text-muted-foreground">
            Tap anything on the page, then tell the agent what to change. You will see a few versions in place and keep the one you like.
          </li>
        ) : null}
        {view?.messages.map((m, i) =>
          m.from === "gsam" ? (
            <li key={i} className="text-center text-xs text-muted-foreground">{m.text}</li>
          ) : (
            <li key={i} className={cn("flex", m.from === "john" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-(--sz-bubble-max) whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                  m.from === "john" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                )}
              >
                {m.text}
              </div>
            </li>
          ),
        )}
        {status === "generating" ? (
          <li className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {view?.agentConnected ? `Making versions… ${elapsed}s` : `Waiting for the agent to join… ${elapsed}s`}
          </li>
        ) : null}
        {error ? <li className="text-sm text-destructive" role="alert">{error}</li> : null}
      </ol>

      {choosing ? (
        <section className="space-y-3 border-t border-border p-3" aria-label="Versions">
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="Previous version" disabled={index === 0 || status === "applying"} onClick={() => setIndex((i) => i - 1)}>
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <div className="min-w-0 text-center">
              <div className="text-sm font-semibold">Version {index + 1} of {variants.length}</div>
              <div className="truncate text-xs text-muted-foreground">{variants[index]?.name || " "}</div>
            </div>
            <Button type="button" variant="outline" size="icon" aria-label="Next version" disabled={index >= variants.length - 1 || status === "applying"} onClick={() => setIndex((i) => i + 1)}>
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <div className="flex gap-1.5" aria-hidden="true">
            {variants.map((_, i) => (
              <span key={i} className={cn("h-1 flex-1 rounded-full bg-muted", i === index && "bg-primary")} />
            ))}
          </div>
          {status === "applying" ? (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Saving it into the page…
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => void run((id) => liveDesignApi.discard(id))}>
                <X aria-hidden="true" className="size-4" /> Discard
              </Button>
              <Button type="button" onClick={() => view?.request && void run((id) => liveDesignApi.accept(id, view.request!.id, index))}>
                <Check aria-hidden="true" className="size-4" /> Keep this
              </Button>
              {!asking ? (
                <button type="button" className="col-span-2 text-xs text-muted-foreground underline hover:text-foreground md:hidden" onClick={() => setAsking(true)}>
                  Ask for something different
                </button>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <form
        className={cn("space-y-2 border-t border-border p-3 pb-(--sz-pad-safe-bottom)", choosing && !asking && "hidden md:block")}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {selection ? (
          <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium" title={liveLabel(selection)}>{liveLabel(selection)}</span>
            {selection.hasParent && !busy ? (
              <button type="button" className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => toFrame({ type: "live-parent" })}>
                <Expand aria-hidden="true" className="size-3.5" /> Bigger
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            className="min-h-0 flex-1 resize-none"
            placeholder={selection ? "What should change? For example: make it glow" : "Tap something on the page first"}
            disabled={!selection || busy || status === "ended"}
            aria-label="Your request"
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!selection || !prompt.trim() || busy || !view || status === "ended"}>
            <ArrowUp aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function AgentLine({ view }: { view: LiveDesignView | null }) {
  const text = !view
    ? "Starting live design…"
    : view.status === "ended"
      ? "Live design ended. Go back and open it again to carry on."
      : view.agentConnected
        ? "The agent is connected"
        : "Waking the agent (about 40 seconds the first time)";
  return (
    <p className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
      <span
        className={cn("size-2 shrink-0 rounded-full", view?.agentConnected ? "bg-chart-2" : "bg-muted-foreground animate-pulse")}
        aria-hidden="true"
      />
      {text}
    </p>
  );
}
