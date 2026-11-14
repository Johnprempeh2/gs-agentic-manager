import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveDesignView } from "@greatstone/shared";
import { ArrowUp, Library, Loader2, Redo2, Undo2 } from "lucide-react";
import { ApiError } from "../api/client";
import { liveDesignApi } from "../api/liveDesign";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { referenceInstruction } from "../api/references";
import { useCompany } from "../context/CompanyContext";
import { ReferencePickerList } from "./ReferenceStudio";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DictationButton, DictationInterim, useComposerDictation } from "./DictationButton";

const isGoneSession = (err: unknown) => err instanceof ApiError && err.status === 404;

// Saved is not live (John, 7 Nov): a finished change sits on staging until he presses Deploy.
const CODE_TASK_STATUS = { working: "Building", preview: "Preview ready", done: "Saved to staging, not live", blocked: "Blocked" } as const;

/** What the agent is building in code for this page, and what is waiting its turn. Nothing here deploys (11 Nov). */
export function AgentWork({ view, onPreview, deployable }: {
  view: LiveDesignView | null;
  onPreview?: (url: string, label: string) => void;
  /** A website page: say where Deploy lives now. */
  deployable?: boolean;
}) {
  const tasks = (view?.codeTasks ?? []).filter((t) => t.kind !== "deploy");
  const queued = view?.queued ?? [];
  if (!tasks.length && !queued.length && !deployable) return null;
  return (
    <section className="space-y-2 border-t border-border px-4 py-2" aria-label="Agent's work">
      <div className="max-h-72 space-y-2 overflow-y-auto">
      {tasks.length ? (
        <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t.identifier} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-mono text-muted-foreground">{t.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
              <span className={cn("text-muted-foreground", t.status === "blocked" && "text-destructive")}>{CODE_TASK_STATUS[t.status]}</span>
              {t.previewUrl && onPreview ? (
                <button type="button" className="underline underline-offset-2" onClick={() => onPreview(t.previewUrl!, `${t.identifier} ${t.title}`)}>Show here</button>
              ) : null}
              {t.previewUrl ? <a href={t.previewUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Preview</a> : null}
              {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Pull request</a> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {queued.length ? (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium">Up next ({queued.length})</p>
          <ol className="list-decimal pl-4">
            {queued.map((q, i) => <li key={i} className="truncate">{q}</li>)}
          </ol>
        </div>
      ) : null}
      </div>
      {deployable ? (
        <p className="text-xs text-muted-foreground">Changes save to staging. John puts them on greatstoneint.com with Deploy, on the Website module under Releases.</p>
      ) : null}
    </section>
  );
}

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
      // A safety net only: the page's event stream asks for a fresh read whenever the session changes
      // (GRE-5369). Every 15s while the tab is visible; nothing while it is hidden.
      if (!idRef.current || document.hidden) return;
      liveDesignApi.get(idRef.current).then(setView).catch((err: unknown) => {
        // A GSAM release forgets open sessions: start a new one instead of leaving a dead editor.
        if (isGoneSession(err)) setAttempt((n) => n + 1);
      });
    }, LIVE_VIEW_POLL_MS);
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
      if (isGoneSession(err)) {
        setAttempt((n) => n + 1);
        return false;
      }
      setError(err instanceof Error ? err.message : "That did not work");
      return false;
    }
  }, []);

  return { view, error, retry, run, sessionId: view?.id ?? null };
}

/** How often an open editor reads its session when nothing on the stream asked it to. */
export const LIVE_VIEW_POLL_MS = 15_000;

/** After this long a save is slow enough to explain (a save GSAM does itself takes well under a second). */
const SLOW_SAVE_SECONDS = 20;

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
/** `deployable`: a website page, so the chat says where Deploy lives. */
export function LiveDesignChat({ live, onPreview, deployable, onEditsChanged, onApprove }: {
  live: ReturnType<typeof useLiveDesign>;
  /** Only for a person with Publish rights on a website page: approves the page's latest saved version. */
  onApprove?: () => Promise<unknown>;
  /** The edits not saved yet changed outside the page (Undo, Redo, Discard, a quick change): reload the frame to show them. */
  onEditsChanged?: () => void;
  onPreview?: (url: string, label: string) => void;
  deployable?: boolean;
}) {
  const { view, error, run } = live;
  const [note, setNote] = useState("");
  const dictation = useComposerDictation(note, setNote);
  const { selectedCompanyId } = useCompany();
  const [picking, setPicking] = useState(false);
  const status = view?.status;
  // While versions are on the page, a comment can be about one of them.
  const versions = status === "ready" ? view?.variants ?? [] : [];
  const [about, setAbout] = useState<number | null>(null);
  useEffect(() => setAbout(null), [view?.request?.id]);
  const elapsed = useElapsed(view?.request?.startedAt, status === "generating");
  // A save by the agent has no start time in the view, so count from when this page saw it begin.
  const [savingSince, setSavingSince] = useState<string>();
  useEffect(() => setSavingSince(status === "applying" ? new Date().toISOString() : undefined), [status]);
  const saving = useElapsed(savingSince, status === "applying");
  const listRef = useRef<HTMLOListElement>(null);
  const messageCount = view?.messages.length ?? 0;

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messageCount, status]);

  const send = () => {
    if (!note.trim() || !view || status === "ended") return;
    dictation.cancel();
    const text = note.trim();
    if (about !== null && versions[about]) {
      const target = `About version ${about + 1} ("${versions[about].name}"): `;
      void run((id) => liveDesignApi.steer(id, target + text)).then((ok) => ok && setNote(""));
      return;
    }
    // A simple change of words is made at once (no agent round trip); anything else goes to the agent.
    let quick = false;
    void run(async (id) => {
      const answer = await liveDesignApi.quick(id, text);
      if (answer.quick.done) {
        quick = true;
        return answer;
      }
      return liveDesignApi.steer(id, text);
    }).then((ok) => {
      if (!ok) return;
      setNote("");
      if (quick) onEditsChanged?.();
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentLine view={view} />

      <ol ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-label="Live design chat" aria-live="polite">
        {messageCount === 0 ? (
          <li className="space-y-2 text-sm text-muted-foreground">
            <p>Pick anything on the page with the bar at the bottom, type what should change and press Go.</p>
            <p>The agent's versions appear in place. Flick through them, tune them, then accept one. The agent saves it into the file.</p>
            <p>Or ask here for anything: a change to the whole page, a new section, a feature. Code changes show below as the agent builds them, and you can keep asking while it works.</p>
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
          <li className="flex items-start gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin" />
            {saving < SLOW_SAVE_SECONDS
              ? `Saving it into the page… ${saving}s`
              : `Still saving… ${saving}s. The agent is writing this change into the page. Nothing is lost: if the agent stops answering, GSAM frees the page and says so here.`}
          </li>
        ) : null}
        {error ? <li className="text-sm text-destructive" role="alert">{error}</li> : null}
      </ol>

      <AgentWork
        view={view}
        onPreview={onPreview}
        deployable={deployable}
      />

      <StagedEdits live={live} onChanged={onEditsChanged} onApprove={onApprove} />

      <form
        className="space-y-1 border-t border-border p-3 pb-(--sz-pad-safe-bottom)"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {versions.length ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Comment on">
            <span className="text-xs text-muted-foreground">Comment on</span>
            {[null, ...versions.map((_, i) => i)].map((i) => (
              <Button
                key={i ?? "all"}
                type="button"
                size="sm"
                variant={about === i ? "secondary" : "ghost"}
                aria-pressed={about === i}
                className="h-7 px-2 text-xs"
                onClick={() => setAbout(i)}
              >
                {i === null ? "All" : `${i + 1} ${versions[i].name}`}
              </Button>
            ))}
          </div>
        ) : null}
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
          placeholder={about !== null ? `Your comment on version ${about + 1}` : "Ask for a change, for example: tighten the spacing on the whole page"}
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
        {about === null ? (
          <p className="text-xs text-muted-foreground">
            Quick change of words: change “old words” to “new words”. It shows on the page at once, ready to save or undo.
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** Cmd or Ctrl Z undoes, Shift with it (or Ctrl Y) redoes; null for any other key. */
export function historyKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.metaKey) return "redo";
  return null;
}

/** Undo and Redo of the person's own edits not saved yet, one edit at a time. `onChanged` reloads the page frame. */
export function useEditHistory(live: ReturnType<typeof useLiveDesign>, onChanged?: () => void) {
  const { view, run } = live;
  const ready = !!view && view.status !== "ended" && view.status !== "applying";
  const canUndo = ready && (view?.stagedCount ?? 0) > 0;
  const canRedo = ready && (view?.redoCount ?? 0) > 0;
  const step = useCallback(
    (redo: boolean) => void run((id) => (redo ? liveDesignApi.redo(id) : liveDesignApi.undo(id))).then((ok) => ok && onChanged?.()),
    [run, onChanged],
  );
  return { canUndo, canRedo, undo: () => step(false), redo: () => step(true) };
}

const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

const SAVE_WAIT_SECONDS = 180;

/**
 * Save and approve: Save to draft, then approve only once that save has landed as a new version. A save GSAM makes
 * itself is done when the commit answers; one the agent makes runs while the view says "applying", so this waits.
 * Any failed, refused or unfinished save throws, and nothing is approved.
 */
export async function saveThenApprove(
  sessionId: string,
  before: string,
  approve: () => Promise<unknown>,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<LiveDesignView> {
  const answer = await liveDesignApi.helper(sessionId, { method: "POST", path: "/manual-edit-commit", body: null, extra: {} });
  if (answer.status >= 300) {
    let reason = "";
    try { reason = String((JSON.parse(answer.body) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
    throw new Error(`The save did not go through${reason ? ` (${reason.replace(/[.\s]+$/, "")})` : ""}, so nothing was approved.`);
  }
  let view = await liveDesignApi.get(sessionId);
  for (let waited = 0; view.status === "applying" && waited < SAVE_WAIT_SECONDS; waited++) {
    await pause(1000);
    view = await liveDesignApi.get(sessionId);
  }
  if (view.status === "applying") throw new Error("The save is still running, so nothing was approved. Approve the page once it has saved.");
  if (view.attachmentId === before || view.stagedCount > 0) throw new Error("The edits were not saved, so nothing was approved. Try Save and approve again.");
  await approve();
  return view;
}

/**
 * Direct edits made on the page wait here until saved, so a removal is never a silent no-op.
 * Undo and Redo step through them one at a time; Discard drops them all; Save to draft saves them as the next version.
 * `onApprove` (people with Publish rights only) adds Save and approve.
 */
export function StagedEdits({ live, onChanged, onApprove }: { live: ReturnType<typeof useLiveDesign>; onChanged?: () => void; onApprove?: () => Promise<unknown> }) {
  const { view, run } = live;
  const history = useEditHistory(live, onChanged);
  const [approving, setApproving] = useState(false);
  const count = view?.stagedCount ?? 0;
  const redo = view?.redoCount ?? 0;
  if (!view || (!count && !redo) || view.status === "ended") return null;
  const saving = view.status === "applying" || approving;
  const helper = (path: string) => (id: string) =>
    liveDesignApi.helper(id, { method: "POST", path, body: null, extra: {} }).then(() => liveDesignApi.get(id));
  return (
    <section className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs" aria-label="Unsaved edits" role="status">
      <span className="w-full font-medium text-foreground">
        {approving
          ? "Saving, then approving…"
          : saving
          ? "Saving to the draft…"
          : count && view.restoredCount
            ? `Restored ${view.restoredCount} unsaved edit${view.restoredCount === 1 ? "" : "s"} from last time`
            : count
              ? `${count} edit${count === 1 ? "" : "s"} not saved yet`
              : "Nothing waiting to save"}
      </span>
      <div className="flex items-center" role="group" aria-label="Edit history">
        <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!history.canUndo}
          aria-label="Undo the last edit" title={`Undo the last edit (${MOD_KEY} Z)`} onClick={history.undo}>
          <Undo2 aria-hidden="true" className="size-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!history.canRedo}
          aria-label="Redo" title={`Redo (Shift ${MOD_KEY} Z)`} onClick={history.redo}>
          <Redo2 aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {count ? (
        <>
          <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" disabled={saving}
            onClick={() => void run(helper("/manual-edit-discard")).then((ok) => ok && onChanged?.())}>
            Discard all
          </Button>
          <Button type="button" size="sm" variant={onApprove ? "outline" : "default"} className="h-7" disabled={saving} onClick={() => void run(helper("/manual-edit-commit"))}>
            Save to draft
          </Button>
          {onApprove ? (
            <Button type="button" size="sm" className="h-7" disabled={saving} onClick={() => {
              setApproving(true);
              void run((id) => saveThenApprove(id, view.attachmentId, onApprove)).finally(() => setApproving(false));
            }}>
              Save and approve
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AgentLine({ view }: { view: LiveDesignView | null }) {
  const text = !view
    ? "Starting live design…"
    : view.status === "ended"
      ? "Live design ended. Go back and open it again to carry on."
      : view.agentConnected
        ? "The agent is connected"
        : view.queued.length
          ? `Waiting for the agent to join: ${view.queued.length} message${view.queued.length === 1 ? "" : "s"} not answered yet`
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
