import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HTML_ATTACHMENT_SANDBOX_TOKENS, isWebsiteHtmlPage, type LiveDesignView } from "@greatstone/shared";
import { ArrowLeft, Check, ChevronDown, History, Laptop, Loader2, Lock, Maximize2, MousePointerClick, PenLine, Smartphone, TriangleAlert, Undo2 } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { deliverablesApi } from "../api/deliverables";
import { websiteModuleApi } from "../api/website";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { liveDesignApi } from "../api/liveDesign";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { ScaledFrame } from "../components/AttachmentPreviewPanel";
import { historyKey, LiveDesignChat, useEditHistory, useLiveDesign } from "../components/LiveDesignChat";
import { useDecisionCardContext } from "../components/website/WebsiteHub";
import { useWebsiteContentLive, WEBSITE_STATUS_TONE, websiteStatusWord } from "../lib/website-status";
import { getSpeechRecognitionConstructor, type BrowserSpeechRecognition } from "../hooks/useDictation";

// Impeccable asks "Apply 2 edits?" with confirm(), so the live page may open modals.
const SANDBOX = [...HTML_ATTACHMENT_SANDBOX_TOKENS, "allow-modals"].join(" ");
const WIDTHS = { fit: null, laptop: 1440, phone: 390 } as const;
const ENGINE_SANDBOX = "allow-scripts allow-same-origin allow-modals allow-popups allow-forms";

/**
 * Live design, full screen (John, 2 Nov): the chat with the agent on the left,
 * the page on the right (stacked on a phone). The page runs Impeccable's own
 * live tools; this page relays their helper calls to GSAM, which stands in for
 * Impeccable's local helper, so it works from any device.
 */
export function LiveEditor() {
  const { issueId = "", attachmentId = "" } = useParams<{ issueId: string; attachmentId: string }>();
  const queryClient = useQueryClient();
  // Opened from Deliverables: every saved change becomes the deliverable's next version.
  const [searchParams] = useSearchParams();
  const openedDeliverable = searchParams.get("deliverable");
  const live = useLiveDesign(
    () => liveDesignApi.start(attachmentId, openedDeliverable),
    `${attachmentId}:${openedDeliverable ?? ""}`,
    true,
  );
  // The page shown is the session's: it moves on when the agent saves or you restore a version.
  const pageId = live.view?.attachmentId ?? attachmentId;
  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
    enabled: !!issueId,
  });
  const fileName = attachments?.find((a) => a.id === pageId)?.originalFilename ?? "Page";
  const { selectedCompanyId } = useCompany();
  const deliverableId = live.view?.deliverableId ?? null;
  const { data: deliverable } = useQuery({
    queryKey: ["live-design-deliverable", selectedCompanyId, deliverableId],
    queryFn: () => deliverablesApi.get(selectedCompanyId!, deliverableId!),
    enabled: !!selectedCompanyId && !!deliverableId,
  });
  // A new saved page also lists among the task's files.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
  }, [pageId, issueId, queryClient]);

  return (
    <LiveEditorShell
      live={live}
      title={deliverable?.title ?? fileName}
      subtitle={deliverable ? `Live design · version ${deliverable.versions[0]?.version ?? 1}` : "Live design"}
      backTo={`/issues/${issueId}`}
      backLabel="Back to the task"
      fallbackSrc={`/api/attachments/${pageId}/annotate?live=1`}
      versions={deliverable?.versions.map((v) => ({
        id: v.id,
        version: v.version,
        createdAt: v.createdAt,
        restoreId: v.attachmentId,
        current: v.attachmentId === pageId,
      }))}
      onRestore={(id) => void live.run((sid) => liveDesignApi.restore(sid, id))}
    />
  );
}

/** A website page in live design (plan revision 8 on GRE-1831): every kept change is a new page version. */
export function WebsitePageLiveEditor() {
  const { siteId = "", pageId = "" } = useParams<{ siteId: string; pageId: string }>();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const live = useLiveDesign(() => websiteModuleApi.liveStart(companyId, siteId, pageId), `${siteId}:${pageId}`, !!companyId);
  const current = live.view?.attachmentId ?? null;
  const { data: page, refetch: refetchPage } = useQuery({
    queryKey: ["website-live-page", companyId, siteId, pageId, current],
    queryFn: () => websiteModuleApi.page(companyId, siteId, pageId),
    enabled: !!companyId,
  });
  // Save and approve and Approve: people with Publish rights on this site only (the server refuses agents too).
  const { data: access } = useQuery({
    queryKey: queryKeys.website.access(companyId, siteId),
    queryFn: () => websiteModuleApi.access(companyId, siteId),
    enabled: !!companyId,
    retry: false,
  });
  const queryClient = useQueryClient();
  const approve = useCallback(async () => {
    await websiteModuleApi.approvePage(companyId, siteId, pageId);
    void queryClient.invalidateQueries({ queryKey: ["website-live-pages", companyId, siteId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, siteId) });
    await refetchPage();
  }, [companyId, siteId, pageId, queryClient, refetchPage]);
  const canApprove = !!access?.publish;
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const { data: sites } = useQuery({
    queryKey: ["website-live-sites", companyId],
    queryFn: () => websiteModuleApi.sites(companyId),
    enabled: !!companyId,
  });
  const onLive = useWebsiteContentLive(companyId, sites?.find((s) => s.id === siteId));
  const statusWord = page ? websiteStatusWord(page.status, onLive) : null;
  // A page still in the old block format shows as it is on the site (the address the frame already uses for its assets), read-only.
  const site = sites?.find((s) => s.id === siteId);
  const siteBase = site?.devPreviewUrl ?? site?.livePreviewUrl ?? null;
  const oldBlocks = !!page && !isWebsiteHtmlPage(page.content) && Array.isArray((page.content as { content?: unknown[] } | null)?.content) &&
    (page.content as { content: unknown[] }).content.length > 0;
  const readOnly = oldBlocks && siteBase?.startsWith("https://") && page
    ? {
        url: new URL(page.slug, siteBase).href,
        // The home page (Two Doors) is frozen by John: never offer to rebuild it.
        onRebuild: page.slug === "/" ? undefined : () => void live.run((id) => liveDesignApi.steer(id, "Rebuild this page from its blocks, same look")),
      }
    : undefined;
  const navigate = useNavigate();
  const engine = useMemo(
    () => ({ siteId, draft: (revisionId: string, sessionId: string | null) => websiteModuleApi.liveDraft(companyId, siteId, pageId, revisionId, sessionId) }),
    [companyId, siteId, pageId],
  );
  const { data: pages } = useQuery({
    queryKey: ["website-live-pages", companyId, siteId],
    queryFn: () => websiteModuleApi.pages(companyId, siteId),
    enabled: !!companyId,
  });
  // The current page stays listed even when it is still a planned sitemap page (opened from the Sitemap tab).
  const builtPages = (pages ?? []).filter((p) => !p.archivedAt && (p.status !== "planned" || p.id === pageId));
  const { agentMap, currentUserId } = useDecisionCardContext(companyId);
  const { data: revisions } = useQuery({
    queryKey: ["website-live-revisions", companyId, siteId, pageId, current],
    queryFn: () => websiteModuleApi.revisions(companyId, siteId, pageId),
    enabled: !!companyId && !!current,
  });
  return (
    <LiveEditorShell
      live={live}
      title={page?.title ?? "Page"}
      subtitle={`Live design · ${page?.slug ?? ""}${revisions?.[0] ? ` · version ${revisions[0].revisionNumber}` : ""}`}
      backTo="/website"
      backLabel="Back to the website"
      onApprove={canApprove ? approve : undefined}
      switcher={
        <>
          {statusWord ? (
            <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", WEBSITE_STATUS_TONE[statusWord])} data-testid="live-page-status">
              {statusWord}
            </span>
          ) : null}
          {/* Nothing waiting to save: an approver approves the saved version here (with edits waiting, Save and approve does both). */}
          {canApprove && page && (page.status === "draft" || page.status === "review") && !live.view?.stagedCount && live.view?.status !== "applying" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={approving}
              title={approveError ?? "Approve the saved version. Publish then puts it on staging."}
              onClick={() => {
                setApproving(true);
                setApproveError(null);
                approve().catch((err: unknown) => setApproveError(err instanceof Error ? `Not approved: ${err.message}` : "Not approved")).finally(() => setApproving(false));
              }}
            >
              <Check />
              Approve
            </Button>
          ) : null}
          {approveError ? <span role="alert" className="max-w-48 truncate text-xs text-destructive" title={approveError}>{approveError}</span> : null}
          {builtPages.length > 1 ? (
          <NativeSelect
            aria-label="Page"
            value={pageId}
            onChange={(e) => {
              // Edits not saved yet are kept on the server and come back when the page is opened again.
              navigate(`/website/sites/${siteId}/pages/${e.currentTarget.value}/design`);
            }}
            className="h-8 max-w-48"
          >
            {/* Only pages that exist on the site; planned sitemap pages are built from the Sitemap tab. */}
            {builtPages.map((p) => (
              <option key={p.id} value={p.id}>{p.title} ({p.slug})</option>
            ))}
          </NativeSelect>
          ) : null}
        </>
      }
      versions={revisions?.map((r) => ({
        id: r.id,
        version: r.revisionNumber,
        createdAt: r.createdAt,
        restoreId: r.id,
        current: r.id === current,
        what: r.changeSummary,
        by: r.createdByUserId
          ? r.createdByUserId === currentUserId ? "you" : "a person"
          : r.createdByAgentId ? agentMap.get(r.createdByAgentId)?.name ?? "an agent" : null,
      }))}
      onRestore={(revisionId) => void live.run(() => websiteModuleApi.liveRestore(companyId, siteId, pageId, revisionId))}
      engine={engine}
      readOnly={readOnly}
    />
  );
}

export interface VersionItem {
  id: string;
  version: number;
  createdAt: string;
  /** What Restore brings back; null when it cannot be restored. */
  restoreId: string | null;
  current: boolean;
  /** Who saved it, in plain words ("you", an agent's name), when known. */
  by?: string | null;
  /** What the save was ("Edited by hand", "Live design"), when known. */
  what?: string | null;
}

/**
 * The full-screen live editor: the chat with the agent on the left, the page on
 * the right (stacked on a phone). The page runs Impeccable's own live tools; this
 * relays their helper calls to GSAM, which stands in for Impeccable's local helper,
 * so it works from any device.
 */
function LiveEditorShell({
  live,
  title,
  subtitle,
  backTo,
  backLabel,
  fallbackSrc,
  versions,
  onRestore,
  switcher,
  engine,
  readOnly,
  onApprove,
}: {
  live: ReturnType<typeof useLiveDesign>;
  title: string;
  subtitle: string;
  backTo: string;
  backLabel: string;
  fallbackSrc?: string;
  versions?: VersionItem[];
  onRestore: (restoreId: string) => void;
  /** Moves to another page of the same site. */
  switcher?: ReactNode;
  /** A person with Publish rights on a website page: Save and approve in the unsaved edits bar. */
  onApprove?: () => Promise<unknown>;
  /** A website page drawn by the site's own engine (its /live-design route): who to greet and where the draft comes from. */
  /** An old block format page: the real page from the site, read-only, with an optional rebuild. */
  readOnly?: { url: string; onRebuild?: () => void };
  engine?: { siteId: string; draft: (revisionId: string, sessionId: string | null) => Promise<Record<string, unknown>> };
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<keyof typeof WIDTHS>("fit");
  // What the page reported about itself: blank, or pulling code and styles from the internet.
  const [health, setHealth] = useState<{ blank: boolean; scripts: string[]; styles: string[] } | null>(null);
  /** The part John picked is locked (an island, such as the Two Doors landing): its name, or null. */
  const [locked, setLocked] = useState<string | null>(null);
  const [frameReload, setFrameReload] = useState(0);
  const sessionId = live.sessionId;
  const pageId = live.view?.attachmentId ?? "";
  const frameSrc = live.view?.frameSrc ?? fallbackSrc ?? "";
  // The site's engine draws the page on its own https origin; GSAM's sandbox frames are same-site paths.
  const engineOrigin = engine && frameSrc.startsWith("https://") ? new URL(frameSrc).origin : null;
  // Editing off lets clicks reach the page (change slides, open menus); a new version reloads with editing on.
  const [editing, setEditing] = useState(true);
  useEffect(() => setEditing(true), [pageId]);
  // An agent's code change shown in place of the page, to compare before it goes anywhere.
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  // An earlier version on show, to look at before deciding to restore it. Nothing in it can be changed.
  const [viewing, setViewing] = useState<VersionItem | null>(null);
  useEffect(() => setViewing(null), [pageId]);
  const viewId = viewing?.restoreId ?? null;
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const busy = live.view?.status !== "idle" && live.view?.status !== "waiting_agent";
  const unsaved = (live.view?.stagedCount ?? 0) > 0;
  // No warning on leaving: edits not saved yet are kept on the server and come back on the next open.
  const refresh = live.run;
  // The frame reloads after Undo, Redo, Discard or a quick change, and draws the page with the edits not saved yet.
  const reloadFrame = useCallback(() => setFrameReload((n) => n + 1), []);
  const editHistory = useEditHistory(live, reloadFrame);
  const historyRef = useRef(editHistory);
  historyRef.current = editHistory;
  const looking = !!viewing || !!preview;
  const lookingRef = useRef(looking);
  lookingRef.current = looking;
  const stepHistory = useCallback((step: "undo" | "redo") => {
    const h = historyRef.current;
    if (lookingRef.current || !(step === "undo" ? h.canUndo : h.canRedo)) return false;
    if (step === "undo") h.undo();
    else h.redo();
    return true;
  }, []);
  // Cmd or Ctrl Z and Shift Cmd or Ctrl Z, except while typing (the box keeps its own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = historyKey(e);
      const t = e.target as HTMLElement | null;
      if (!step || (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)))) return;
      if (stepHistory(step)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepHistory]);
  // GSAM's own frame adds the session, so the page shows the edits not saved yet; the site's engine gets them with the draft.
  const editSrc = !engineOrigin && sessionId && frameSrc ? `${frameSrc}${frameSrc.includes("?") ? "&" : "?"}session=${encodeURIComponent(sessionId)}` : frameSrc;

  const toFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, source: "gs-impeccable-host" }, engineOrigin ?? "*");
  }, [engineOrigin]);

  // The engine frame's handshake (the site's frame protocol): hello with a fresh nonce, then the draft.
  const engineNonce = useRef<string | null>(null);
  const sendDraft = useCallback(async () => {
    const win = frameRef.current?.contentWindow;
    if (!engine || !engineOrigin || !win || !engineNonce.current || !pageId) return;
    // The page being edited comes with its edits not saved yet; an earlier version comes as it was saved.
    const payload = await engine.draft(viewId ?? pageId, viewId ? null : sessionId).catch(() => null);
    if (!payload || engineNonce.current === null) return;
    win.postMessage({ gs: "website-frame", id: crypto.randomUUID(), type: "live-draft", payload, protocol: 1, session: engineNonce.current }, engineOrigin);
    // An earlier version is for looking at: its editing tools stay hidden.
    if (viewId) toFrame({ kind: "editing", on: false });
  }, [engine, engineOrigin, pageId, viewId, toFrame, sessionId]);
  const sayHello = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!engine || !engineOrigin || !win) return;
    // One nonce per frame load: the frame binds to the first hello it sees and ignores a different
    // nonce after that, so a repeated hello (load and live-waiting both send one) must repeat it.
    if (!engineNonce.current) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      engineNonce.current = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    win.postMessage({ gs: "website-frame", id: crypto.randomUUID(), type: "hello", payload: { nonce: engineNonce.current, protocols: [1], siteId: engine.siteId } }, engineOrigin);
  }, [engine, engineOrigin]);
  // A new page or version is a new frame load, so it gets a fresh nonce.
  useEffect(() => {
    engineNonce.current = null;
  }, [frameSrc, pageId, viewId]);
  useEffect(() => {
    if (!engineOrigin) return;
    const onEngine = (e: MessageEvent) => {
      if (e.origin !== engineOrigin || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as { gs?: unknown; type?: unknown; session?: unknown } | null;
      if (!m || m.gs !== "website-frame") return;
      if (m.type === "live-waiting") sayHello();
      else if (m.type === "live-ready" && m.session === engineNonce.current) void sendDraft();
    };
    window.addEventListener("message", onEngine);
    return () => window.removeEventListener("message", onEngine);
  }, [engineOrigin, sayHello, sendDraft]);


  // Relay the page's helper calls and its event stream. Everything from the frame is untrusted.
  const streamRef = useRef<AbortController | null>(null);
  // Voice for Impeccable's mic buttons: the sandbox has no microphone, so speech runs here.
  const voiceRef = useRef<{ vid: unknown; rec: BrowserSpeechRecognition } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const openStream = async () => {
      streamRef.current?.abort();
      const controller = new AbortController();
      streamRef.current = controller;
      let after: number | "start" = "start";
      while (!controller.signal.aborted) {
        try {
          const { cursor, frames, ended } = await liveDesignApi.stream(sessionId, after, controller.signal);
          for (const f of frames) toFrame({ kind: "stream", data: f.data });
          after = cursor;
          if (ended) return;
        } catch (err) {
          if (controller.signal.aborted) return;
          // The session is gone (ended and cleared): the chat says so; stop asking.
          if (err instanceof ApiError && err.status === 404) return;
          toFrame({ kind: "stream-error" });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || m.source !== "gs-impeccable") return;
      // An earlier version on show is read-only: nothing its frame asks for reaches the page's session.
      if (viewIdRef.current) {
        if (m.kind === "request") toFrame({ kind: "response", rid: m.rid, status: 409, body: JSON.stringify({ error: "This is an earlier version, shown to look at only." }) });
        return;
      }
      if (m.kind === "locked-pick") {
        setLocked(typeof m.label === "string" && m.label ? m.label.slice(0, 80) : null);
      } else if (m.kind === "page-health") {
        const hosts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : []);
        setHealth({ blank: m.blank === true, scripts: hosts(m.scripts), styles: hosts(m.styles) });
      } else if (m.kind === "history") {
        // Cmd or Ctrl Z pressed while the page had the keyboard (and not while typing in it).
        stepHistory(m.redo === true ? "redo" : "undo");
      } else if (m.kind === "stream-open") {
        void openStream();
      } else if (m.kind === "voice-start") {
        const vid = m.vid;
        // The page is untrusted: listen only right after John tapped its mic, and never for long.
        if (!navigator.userActivation?.isActive) {
          toFrame({ kind: "voice", vid, event: "error", error: "not-allowed" });
          toFrame({ kind: "voice", vid, event: "end" });
          return;
        }
        const Recognition = getSpeechRecognitionConstructor();
        if (!Recognition) {
          toFrame({ kind: "voice", vid, event: "error", error: "not-supported" });
          toFrame({ kind: "voice", vid, event: "end" });
          return;
        }
        voiceRef.current?.rec.abort();
        const rec = new Recognition();
        rec.lang = typeof m.lang === "string" && m.lang ? m.lang.slice(0, 20) : navigator.language;
        rec.interimResults = m.interim === true;
        rec.continuous = false;
        rec.onresult = (event) => {
          const transcripts = Array.from(event.results, (r) => r[0]?.transcript ?? "");
          const final = Array.from(event.results).every((r) => r.isFinal);
          toFrame({ kind: "voice", vid, event: "result", transcripts, final });
        };
        rec.onerror = (event) => toFrame({ kind: "voice", vid, event: "error", error: event.error });
        rec.onend = () => {
          if (voiceRef.current?.rec === rec) voiceRef.current = null;
          toFrame({ kind: "voice", vid, event: "end" });
        };
        voiceRef.current = { vid, rec };
        setTimeout(() => {
          if (voiceRef.current?.rec === rec) rec.stop();
        }, 60_000);
        try {
          rec.start();
          toFrame({ kind: "voice", vid, event: "start" });
        } catch {
          toFrame({ kind: "voice", vid, event: "error", error: "start-failed" });
        }
      } else if (m.kind === "voice-stop") {
        const current = voiceRef.current;
        if (current && current.vid === m.vid) {
          if (m.abort === true) current.rec.abort();
          else current.rec.stop();
        }
      } else if (m.kind === "request" && typeof m.path === "string") {
        const rid = m.rid;
        const extra = m.extra && typeof m.extra === "object" ? (m.extra as { selector?: unknown; position?: unknown }) : {};
        liveDesignApi
          .helper(sessionId, {
            method: m.method === "POST" ? "POST" : "GET",
            path: m.path.slice(0, 2000),
            body: typeof m.body === "string" ? m.body : null,
            ...(typeof m.bodyBase64 === "string" ? { bodyBase64: m.bodyBase64 } : {}),
            extra: {
              ...(typeof extra.selector === "string" ? { selector: extra.selector.slice(0, 500) } : {}),
              ...(extra.position === "before" || extra.position === "after" ? { position: extra.position } : {}),
            },
          })
          .then((r) => {
            toFrame({ kind: "response", rid, status: r.status, body: r.body, contentType: r.contentType });
            // A direct edit was staged, saved or dropped: show it here at once instead of at the next poll.
            if (m.method === "POST" && String(m.path).startsWith("/manual-edit")) void refresh((id) => liveDesignApi.get(id));
          })
          .catch((err: unknown) =>
            toFrame({ kind: "response", rid, status: 502, body: JSON.stringify({ error: err instanceof Error ? err.message : "relay failed" }) }),
          );
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      streamRef.current?.abort();
      voiceRef.current?.rec.abort();
    };
  }, [sessionId, toFrame, refresh, stepHistory]);

  // The event stream belongs to the page being edited: it stops while an earlier version is on show,
  // and the page's own frame opens it again when it comes back.
  useEffect(() => {
    if (viewId) streamRef.current?.abort();
  }, [viewId]);

  return (
    <div className="fixed inset-0 z-dialog flex flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 pt-(--sz-pad-safe-top) md:flex-nowrap">
        <Link
          to={backTo}
          disableIssueQuicklook
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={backLabel}
          title={backLabel}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <div className="min-w-0 flex-1 basis-(--sz-live-editor-title-phone) md:basis-0">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {switcher}
        {/* A read-only old block page has nothing to edit, so it has no editing switch. */}
        {readOnly ? null : <Button
          type="button"
          size="sm"
          variant={editing ? "secondary" : "outline"}
          aria-pressed={editing}
          disabled={!sessionId || !!viewing}
          title={editing ? "Turn editing off to click through the page (slides, menus)" : "Turn editing back on"}
          onClick={() => {
            const next = !editing;
            setEditing(next);
            toFrame({ kind: "editing", on: next });
          }}
        >
          {editing ? <PenLine aria-hidden="true" className="size-4" /> : <MousePointerClick aria-hidden="true" className="size-4" />}
          <span className="hidden sm:inline">{editing ? "Editing on" : "Editing off"}</span>
        </Button>}
        {versions?.length ? (
          <VersionMenu
            versions={versions}
            busy={busy}
            unsaved={unsaved}
            onRestore={onRestore}
            onView={(v) => {
              setPreview(null);
              setViewing(v);
            }}
          />
        ) : null}
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
          {!sessionId ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
              {live.error ? (
                <>
                  <p className="text-sm font-medium">The page could not open for live design.</p>
                  <p className="max-w-sm text-sm text-muted-foreground">{live.error}</p>
                  <Button type="button" size="sm" onClick={live.retry}>Try again</Button>
                </>
              ) : (
                <>
                  <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Opening the page…</p>
                </>
              )}
            </div>
          ) : (
            <>
            {/* The health notice sits over the top of the frame, so on a read-only page it would hide the banner. */}
            {!readOnly && !viewing && health && (health.blank || health.scripts.length > 0 || health.styles.length > 0) ? (
              <PageHealthNotice
                health={health}
                onFix={() =>
                  void live.run((id) =>
                    liveDesignApi.steer(
                      id,
                      "Make this page self-contained so it shows in GSAM's safe preview: put the CSS, scripts and fonts it loads from the internet into the page itself (or use the site's own fonts), keep the design the same, and save it.",
                    ),
                  )
                }
              />
            ) : null}
            {locked && !preview && !viewing && !readOnly ? (
              <div className="absolute inset-x-3 top-3 z-raised flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm shadow-sm" role="alert">
                <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1">This part is locked (the {locked}). Ask in the chat, or add sections below. Its words can still be changed: pick the text itself.</p>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLocked(null)}>Dismiss</Button>
              </div>
            ) : null}
            {preview ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs" role="status">
                  <span className="min-w-0 flex-1 truncate">Preview of {preview.label}. Nothing here is live.</span>
                  <a href={preview.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">Open in a tab</a>
                  <Button type="button" size="sm" className="h-7" onClick={() => setPreview(null)}>Back to the page</Button>
                </div>
                <div className="min-h-0 flex-1">
                  <ScaledFrame key={preview.url} src={preview.url} title={`Preview of ${preview.label}`} width={WIDTHS[viewport]} sandbox={ENGINE_SANDBOX} frameRef={frameRef} viewport={viewport} />
                </div>
              </div>
            ) : viewing && viewId && frameSrc ? (
              <div className="flex h-full flex-col">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs" role="status">
                  <span className="min-w-0 flex-1">
                    Looking at version {viewing.version}, saved {formatDateTime(viewing.createdAt)}{viewing.by ? ` by ${viewing.by}` : ""}. Nothing changes until you restore it.
                  </span>
                  <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setViewing(null)}>Back to the current page</Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={busy || unsaved}
                    title={busy ? "The agent is working on the page. Restore when it has finished." : unsaved ? "Save or undo your edits first" : undefined}
                    onClick={() => {
                      setViewing(null);
                      onRestore(viewId);
                    }}
                  >
                    Restore this version
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  <ScaledFrame
                    key={`view:${viewId}`}
                    // The same frame the page uses, pointed at the earlier version.
                    src={frameSrc.split(encodeURIComponent(pageId)).join(encodeURIComponent(viewId))}
                    title={`Version ${viewing.version} of ${title}`}
                    width={WIDTHS[viewport]}
                    sandbox={engineOrigin ? ENGINE_SANDBOX : SANDBOX}
                    frameRef={frameRef}
                    viewport={viewport}
                    onLoad={engineOrigin ? sayHello : () => toFrame({ kind: "editing", on: false })}
                  />
                </div>
              </div>
            ) : readOnly ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs" role="status">
                  <span className="min-w-0 flex-1">Shown as it is on the site. This page is built from older blocks, so chat edits can't change it yet.</span>
                  {readOnly.onRebuild ? <Button type="button" size="sm" className="h-7" onClick={readOnly.onRebuild}>Rebuild as editable</Button> : null}
                </div>
                <div className="min-h-0 flex-1">
                  <ScaledFrame key={readOnly.url} src={readOnly.url} title={`${title} as it is on the site`} width={WIDTHS[viewport]} sandbox={ENGINE_SANDBOX} frameRef={frameRef} viewport={viewport} />
                </div>
              </div>
            ) : frameSrc ? (
              <ScaledFrame
                key={`${pageId}:${frameReload}`}
                src={editSrc}
                title={`Live design of ${title}`}
                width={WIDTHS[viewport]}
                // The engine runs on the site's own origin (never GSAM's), so it keeps its origin to run.
                sandbox={engineOrigin ? ENGINE_SANDBOX : SANDBOX}
                frameRef={frameRef}
                viewport={viewport}
                onLoad={engineOrigin ? sayHello : undefined}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Opening the page…
              </div>
            )}
            </>
          )}
        </div>
        <aside className="flex h-(--sz-42dvh) w-full flex-col border-t border-border md:order-1 md:h-auto md:w-96 md:border-r md:border-t-0">
          <LiveDesignChat live={live} deployable={!!engine} onPreview={(url, label) => {
            setViewing(null);
            setPreview({ url, label });
          }} onEditsChanged={reloadFrame} onApprove={onApprove} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The page's versions: who saved each one, when and how. Restoring one makes it the
 * newest version, so nothing is ever lost and every restore can itself be undone.
 */
function VersionMenu(props: Parameters<typeof VersionList>[0]) {
  const [open, setOpen] = useState(false);
  const close = <T,>(fn: (value: T) => void) => (value: T) => {
    setOpen(false);
    fn(value);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Versions">
          <History aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Version {props.versions[0]?.version ?? 1}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <VersionList {...props} onRestore={close(props.onRestore)} onView={close(props.onView)} />
      </PopoverContent>
    </Popover>
  );
}

export function VersionList({
  versions,
  busy,
  unsaved,
  onRestore,
  onView,
}: {
  versions: VersionItem[];
  /** The agent is working on the page: nothing can be restored until it has finished. */
  busy: boolean;
  /** Edits wait to be saved: looking at or restoring another version would drop them from view. */
  unsaved: boolean;
  onRestore: (restoreId: string) => void;
  onView: (version: VersionItem) => void;
}) {
  const previous = versions.find((v, i) => i > 0 && v.restoreId);
  const held = busy ? "The agent is working on the page. Try again when it has finished." : unsaved ? "Save or undo your edits first." : null;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        disabled={!!held || !previous}
        onClick={() => previous?.restoreId && onRestore(previous.restoreId)}
      >
        <Undo2 aria-hidden="true" className="size-4" />
        Undo last change
      </Button>
      {held ? <p className="px-2 text-xs text-muted-foreground" role="status">{held}</p> : null}
      <ol className="max-h-80 space-y-1 overflow-y-auto border-t border-border pt-2" aria-label="Versions">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                Version {v.version}{v.what ? <span className="font-normal text-muted-foreground"> · {v.what}</span> : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {formatDateTime(v.createdAt)}{v.by ? ` · by ${v.by}` : ""}
              </p>
            </div>
            {v.current ? (
              <span className="text-xs text-muted-foreground">Showing</span>
            ) : v.restoreId ? (
              <>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={unsaved} aria-label={`Look at version ${v.version}`} onClick={() => onView(v)}>
                  Look
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2" disabled={!!held} aria-label={`Restore version ${v.version}`} onClick={() => v.restoreId && onRestore(v.restoreId)}>
                  Restore
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The safe preview has no internet, so a page that loads its code or styles from
 * outside shows blank or bare. Say why, and let the agent fix it in one press.
 */
function PageHealthNotice({
  health,
  onFix,
}: {
  health: { blank: boolean; scripts: string[]; styles: string[] };
  onFix: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const hosts = [...new Set([...health.scripts, ...health.styles])].filter(Boolean);
  return (
    <div className="absolute inset-x-3 top-3 z-raised flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm shadow-sm" role="status">
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        {health.blank ? "This page shows nothing in the safe preview" : "Some of this page's look is missing in the safe preview"}
        {hosts.length ? `: it loads code or styles from ${hosts.join(", ")}, and the preview has no internet.` : "."}
      </p>
      <Button type="button" size="sm" onClick={onFix}>Ask the agent to fix it</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setHidden(true)}>Dismiss</Button>
    </div>
  );
}

export default LiveEditor;
