import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveDesignView } from "@greatstone/shared";
import { ArrowUp, Library, Loader2 } from "lucide-react";
import { liveDesignApi } from "../api/liveDesign";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { referenceInstruction } from "../api/references";
import { useCompany } from "../context/CompanyContext";
import { ReferencePickerList } from "./ReferenceStudio";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DictationButton, DictationInterim, useComposerDictation } from "./DictationButton";

/**
 * The live session for one page: started on open, polled while open, ended on close.
 * `start` opens it (a task file, a deliverable or a website page); `key` names that page.
 */
export function useLiveDesign(start: () => Promise<LiveDesignView>, key: string, active: boolean) {
  const startRef = useRef(start);
  startRef.current = start;
  const [view, setView] = useState<LiveDesignView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // One place starts and ends the session, so a reload or a slow start can never leave it half open.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError(null);
    startRef
      .current()
      .then((v) => {
        if (cancelled) {
          void liveDesignApi.end(v.id).catch(() => undefined);
          return;
        }
        idRef.current = v.id;
        setView(v);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Live design could not start"));
    return () => {
      cancelled = true;
      const id = idRef.current;
      idRef.current = null;
      setView(null);
      if (id) void liveDesignApi.end(id).catch(() => undefined);
    };
  }, [active, key, attempt]);

  const polling = active && !!view && view.status !== "ended";
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (!idRef.current) return;
      liveDesignApi.get(idRef.current).then(setView).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [polling]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

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

  return { view, error, retry, run, sessionId: view?.id ?? null };
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
  const dictation = useComposerDictation(note, setNote);
  const { selectedCompanyId } = useCompany();
  const [picking, setPicking] = useState(false);
  const status = view?.status;
  const elapsed = useElapsed(view?.request?.startedAt, status === "generating");
  const listRef = useRef<HTMLOListElement>(null);
  const messageCount = view?.messages.length ?? 0;

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messageCount, status]);

  const send = () => {
    if (!note.trim() || !view || status === "ended") return;
    dictation.cancel();
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
            <p>Or ask here for a change to the whole page. Every saved change is a new version you can undo.</p>
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
        className="space-y-1 border-t border-border p-3 pb-(--sz-pad-safe-bottom)"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2">
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
          placeholder="Ask for a change, for example: tighten the spacing on the whole page"
          disabled={!view || status === "ended"}
          aria-label="Message the agent"
        />
        {selectedCompanyId ? (
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>
              <Button type="button" size="icon" variant="ghost" aria-label="Add a reference" title="Add a reference" disabled={!view || status === "ended"}>
                <Library aria-hidden="true" className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" side="top" className="w-80 p-2">
              <ReferencePickerList
                companyId={selectedCompanyId}
                onPick={(item) => {
                  setNote((current) => `${current.trim() ? `${current.trim()} ` : ""}${referenceInstruction(item)} `);
                  setPicking(false);
                }}
              />
            </PopoverContent>
          </Popover>
        ) : null}
        <DictationButton dictation={dictation} disabled={!view || status === "ended"} testId="live-design-dictation" />
        <Button type="submit" size="icon" aria-label="Send" disabled={!note.trim() || !view || status === "ended"}>
          <ArrowUp aria-hidden="true" className="size-4" />
        </Button>
        </div>
        <DictationInterim dictation={dictation} />
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
