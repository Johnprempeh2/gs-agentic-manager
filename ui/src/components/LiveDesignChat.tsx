import { useCallback, useEffect, useRef, useState } from "react";
import { LIVE_DEPLOY_REQUEST, type LiveDesignView, type WebsiteDeployChanges } from "@greatstone/shared";
import { ArrowUp, Library, Loader2 } from "lucide-react";
import { ApiError } from "../api/client";
import { liveDesignApi } from "../api/liveDesign";
import { issuesApi } from "../api/issues";
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

const DEPLOY_STATUS = { working: "Getting ready to go live", preview: "Waiting for your yes", done: "Live", blocked: "Blocked" } as const;

const APPROVAL_PREFIX = "Approve production deploy:";

/** The agent's deploy card on its deploy task: what goes out, and John's one yes. */
export function DeployCard({ identifier }: { identifier: string }) {
  const [card, setCard] = useState<{ id: string; details: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      issuesApi.listInteractions(identifier).then((list) => {
        const found = list.find((i) => i.kind === "request_confirmation" && i.status === "pending" &&
          String((i.payload as { detailsMarkdown?: string }).detailsMarkdown ?? "").startsWith(APPROVAL_PREFIX));
        if (live) setCard(found ? { id: found.id, details: String((found.payload as { detailsMarkdown?: string }).detailsMarkdown) } : null);
      }).catch(() => undefined);
    void load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [identifier]);
  if (!card) return null;
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().then(() => setCard(null), (err: unknown) => setError(err instanceof Error ? err.message : "That did not work")).finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2 rounded-md border border-border p-2 text-xs">
      <p className="font-medium text-foreground">Ready to go live</p>
      <p className="whitespace-pre-wrap text-muted-foreground">{card.details}</p>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => act(() => issuesApi.acceptInteraction(identifier, card.id))}>Deploy</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => act(() => issuesApi.rejectInteraction(identifier, card.id, "Not now"))}>Not now</Button>
      </div>
      {error ? <p className="text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

/** What the agent is building in code for this page, what is waiting its turn, and the deploy button. */
/** What the deploy button would put live, from GSAM (cached a minute there). Nothing shown when it cannot say. */
/** Page edits waiting: staging's content release differs from the public site's. */
function contentWaiting(c: WebsiteDeployChanges) {
  return c.stagingContentRelease != null && c.stagingContentRelease !== c.liveContentRelease;
}

function useDeployChanges(load?: () => Promise<WebsiteDeployChanges>) {
  const [changes, setChanges] = useState<WebsiteDeployChanges | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const get = () => load().then((c) => live && setChanges(c), () => live && setChanges(null));
    void get();
    const t = setInterval(get, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [load]);
  return changes;
}

export function AgentWork({ view, onPreview, onDeploy, deployChanges }: {
  view: LiveDesignView | null;
  onPreview?: (url: string, label: string) => void;
  onDeploy?: () => void;
  deployChanges?: () => Promise<WebsiteDeployChanges>;
}) {
  const changes = useDeployChanges(onDeploy ? deployChanges : undefined);
  const tasks = view?.codeTasks ?? [];
  const queued = view?.queued ?? [];
  const deploying = tasks.some((t) => t.kind === "deploy" && (t.status === "working" || t.status === "preview")) ||
    queued.some((q) => q.includes(LIVE_DEPLOY_REQUEST));
  if (!tasks.length && !queued.length && !onDeploy) return null;
  return (
    <section className="space-y-2 border-t border-border px-4 py-2" aria-label="Agent's work">
      <div className="max-h-72 space-y-2 overflow-y-auto">
      {tasks.length ? (
        <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t.identifier} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-mono text-muted-foreground">{t.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
              <span className={cn("text-muted-foreground", t.status === "blocked" && "text-destructive")}>
                {t.kind === "deploy" ? DEPLOY_STATUS[t.status] : t.status === "done" && changes && !changes.commits.length && !contentWaiting(changes) ? "Live" : CODE_TASK_STATUS[t.status]}
              </span>
              {t.previewUrl && onPreview ? (
                <button type="button" className="underline underline-offset-2" onClick={() => onPreview(t.previewUrl!, `${t.identifier} ${t.title}`)}>Show here</button>
              ) : null}
              {t.previewUrl ? <a href={t.previewUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Preview</a> : null}
              {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Pull request</a> : null}
              {t.kind === "deploy" && t.status === "preview" ? <div className="basis-full"><DeployCard identifier={t.identifier} /></div> : null}
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
      {onDeploy && changes ? (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Deploys everything below to greatstoneint.com, not just this page.</p>
          {changes.commits.length || contentWaiting(changes) ? (
            <>
              <p className="font-medium">
                Saved to staging, not live yet ({changes.commits.length + (contentWaiting(changes) ? 1 : 0)})
              </p>
              {contentWaiting(changes) ? (
                <>
                  <p className="mt-1 font-medium">Content (1)</p>
                  <ul className="space-y-0.5">
                    <li className="truncate">
                      Page edits: content release {changes.stagingContentRelease}
                      {changes.liveContentRelease != null ? ` (live has ${changes.liveContentRelease})` : " (first content release)"}
                    </li>
                  </ul>
                </>
              ) : null}
              {changes.commits.length ? (
                <>
                  <p className="mt-1 font-medium">Site code ({changes.commits.length})</p>
                  <ul className="space-y-0.5">
                    {changes.commits.map((c) => (
                      <li key={c.sha} className="truncate"><span className="font-mono">{c.sha.slice(0, 7)}</span> {c.title}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : <p className="font-medium">Everything saved is live</p>}
        </div>
      ) : null}
      </div>
      {onDeploy ? (
        <Button type="button" size="sm" variant="secondary" className="w-full" disabled={deploying} onClick={onDeploy}>
          {deploying ? "Deploy in progress" : "Deploy these changes"}
        </Button>
      ) : null}
      {onDeploy ? (
        <p className="text-xs text-muted-foreground">Changes save to staging. Deploy is the only thing that puts them live.</p>
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
      // Every 5s while the tab is visible; nothing while it is hidden.
      if (!idRef.current || document.hidden) return;
      liveDesignApi.get(idRef.current).then(setView).catch((err: unknown) => {
        // A GSAM release forgets open sessions: start a new one instead of leaving a dead editor.
        if (isGoneSession(err)) setAttempt((n) => n + 1);
      });
    }, 5000);
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
/** `deployable`: a website page, so the chat offers the deploy button. */
export function LiveDesignChat({ live, onPreview, deployable, deployChanges }: {
  live: ReturnType<typeof useLiveDesign>;
  onPreview?: (url: string, label: string) => void;
  deployable?: boolean;
  deployChanges?: () => Promise<WebsiteDeployChanges>;
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
  const listRef = useRef<HTMLOListElement>(null);
  const messageCount = view?.messages.length ?? 0;

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messageCount, status]);

  const send = () => {
    if (!note.trim() || !view || status === "ended") return;
    dictation.cancel();
    const target = about !== null && versions[about] ? `About version ${about + 1} ("${versions[about].name}"): ` : "";
    void run((id) => liveDesignApi.steer(id, target + note.trim())).then((ok) => ok && setNote(""));
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
          <li className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Saving it into the page…
          </li>
        ) : null}
        {error ? <li className="text-sm text-destructive" role="alert">{error}</li> : null}
      </ol>

      <AgentWork
        view={view}
        onPreview={onPreview}
        deployChanges={deployChanges}
        onDeploy={deployable && view && status !== "ended" ? () => void run((id) => liveDesignApi.steer(id, LIVE_DEPLOY_REQUEST)) : undefined}
      />

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
