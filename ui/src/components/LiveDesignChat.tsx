import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveDesignView } from "@greatstone/shared";
import { ArrowUp, Loader2 } from "lucide-react";
import { liveDesignApi } from "../api/liveDesign";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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

  return { view, error, end, run, sessionId: view?.id ?? null };
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
 * The editor's chat column: what John asked on the page, what the agent says,
 * and a box for notes to the agent. Picking and versions happen in
 * Impeccable's own bar on the page.
 */
export function LiveDesignChat({ live }: { live: ReturnType<typeof useLiveDesign> }) {
  const { view, error, run } = live;
  const [note, setNote] = useState("");
  const status = view?.status;
  const elapsed = useElapsed(view?.request?.startedAt, status === "generating");
  const listRef = useRef<HTMLOListElement>(null);
  const messageCount = view?.messages.length ?? 0;

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messageCount, status]);

  const send = () => {
    if (!note.trim() || !view || status === "ended") return;
    void run((id) => liveDesignApi.steer(id, note.trim())).then((ok) => ok && setNote(""));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentLine view={view} />

      <ol ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-label="Live design chat" aria-live="polite">
        {messageCount === 0 ? (
          <li className="space-y-2 text-sm text-muted-foreground">
            <p>Pick anything on the page with the bar at the bottom, type what should change and press Go.</p>
            <p>The agent's versions appear in place. Flick through them, tune them, then accept one. The agent saves it into the file.</p>
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
        {status === "applying" ? (
          <li className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Saving it into the page…
          </li>
        ) : null}
        {error ? <li className="text-sm text-destructive" role="alert">{error}</li> : null}
      </ol>

      <form
        className="flex items-end gap-2 border-t border-border p-3 pb-(--sz-pad-safe-bottom)"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          className="min-h-0 flex-1 resize-none"
          placeholder="Message the agent, for example: make the second one calmer"
          disabled={!view || status === "ended"}
          aria-label="Message the agent"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={!note.trim() || !view || status === "ended"}>
          <ArrowUp aria-hidden="true" className="size-4" />
        </Button>
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
