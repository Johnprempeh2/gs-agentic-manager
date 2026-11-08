import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HTML_ATTACHMENT_SANDBOX_TOKENS, isWebsiteHtmlPage, type LiveDesignView, type WebsiteDeployChanges } from "@greatstone/shared";
import { ArrowLeft, ChevronDown, History, Laptop, Loader2, Maximize2, MousePointerClick, PenLine, RotateCcw, Smartphone, TriangleAlert, Undo2 } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deliverablesApi } from "../api/deliverables";
import { websiteModuleApi } from "../api/website";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { liveDesignApi } from "../api/liveDesign";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { ScaledFrame } from "../components/AttachmentPreviewPanel";
import { LiveDesignChat, useLiveDesign } from "../components/LiveDesignChat";
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
  const { data: page } = useQuery({
    queryKey: ["website-live-page", companyId, siteId, pageId, current],
    queryFn: () => websiteModuleApi.page(companyId, siteId, pageId),
    enabled: !!companyId,
  });
  const { data: sites } = useQuery({
    queryKey: ["website-live-sites", companyId],
    queryFn: () => websiteModuleApi.sites(companyId),
    enabled: !!companyId,
  });
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
    () => ({ siteId, draft: (revisionId: string) => websiteModuleApi.liveDraft(companyId, siteId, pageId, revisionId), deployChanges: () => websiteModuleApi.deployChanges(companyId, siteId) }),
    [companyId, siteId, pageId],
  );
  const { data: pages } = useQuery({
    queryKey: ["website-live-pages", companyId, siteId],
    queryFn: () => websiteModuleApi.pages(companyId, siteId),
    enabled: !!companyId,
  });
  // The current page stays listed even when it is still a planned sitemap page (opened from the Sitemap tab).
  const builtPages = (pages ?? []).filter((p) => !p.archivedAt && (p.status !== "planned" || p.id === pageId));
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
      switcher={
        builtPages.length > 1 ? (
          <NativeSelect
            aria-label="Page"
            value={pageId}
            onChange={(e) => navigate(`/website/sites/${siteId}/pages/${e.currentTarget.value}/design`)}
            className="h-8 max-w-48"
          >
            {/* Only pages that exist on the site; planned sitemap pages are built from the Sitemap tab. */}
            {builtPages.map((p) => (
              <option key={p.id} value={p.id}>{p.title} ({p.slug})</option>
            ))}
          </NativeSelect>
        ) : null
      }
      versions={revisions?.map((r) => ({
        id: r.id,
        version: r.revisionNumber,
        createdAt: r.createdAt,
        restoreId: r.id,
        current: r.id === current,
      }))}
      onRestore={(revisionId) => void live.run(() => websiteModuleApi.liveRestore(companyId, siteId, pageId, revisionId))}
      engine={engine}
      readOnly={readOnly}
    />
  );
}

interface VersionItem {
  id: string;
  version: number;
  createdAt: string;
  /** What Restore brings back; null when it cannot be restored. */
  restoreId: string | null;
  current: boolean;
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
  /** A website page drawn by the site's own engine (its /live-design route): who to greet and where the draft comes from. */
  /** An old block format page: the real page from the site, read-only, with an optional rebuild. */
  readOnly?: { url: string; onRebuild?: () => void };
  engine?: { siteId: string; draft: (revisionId: string) => Promise<Record<string, unknown>>; deployChanges?: () => Promise<WebsiteDeployChanges> };
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<keyof typeof WIDTHS>("fit");
  // What the page reported about itself: blank, or pulling code and styles from the internet.
  const [health, setHealth] = useState<{ blank: boolean; scripts: string[]; styles: string[] } | null>(null);
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

  const toFrame = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ...message, source: "gs-impeccable-host" }, engineOrigin ?? "*");
  }, [engineOrigin]);

  // The engine frame's handshake (the site's frame protocol): hello with a fresh nonce, then the draft.
  const engineNonce = useRef<string | null>(null);
  const sendDraft = useCallback(async () => {
    const win = frameRef.current?.contentWindow;
    if (!engine || !engineOrigin || !win || !engineNonce.current || !pageId) return;
    const payload = await engine.draft(pageId).catch(() => null);
    if (!payload || engineNonce.current === null) return;
    win.postMessage({ gs: "website-frame", id: crypto.randomUUID(), type: "live-draft", payload, protocol: 1, session: engineNonce.current }, engineOrigin);
  }, [engine, engineOrigin, pageId]);
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
  }, [frameSrc, pageId]);
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
      if (m.kind === "page-health") {
        const hosts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : []);
        setHealth({ blank: m.blank === true, scripts: hosts(m.scripts), styles: hosts(m.styles) });
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
      voiceRef.current?.rec.abort();
    };
  }, [sessionId, toFrame]);

  return (
    <div className="fixed inset-0 z-dialog flex flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 pt-(--sz-pad-safe-top)">
        <Link
          to={backTo}
          disableIssueQuicklook
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={backLabel}
          title={backLabel}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {switcher}
        <Button
          type="button"
          size="sm"
          variant={editing ? "secondary" : "outline"}
          aria-pressed={editing}
          disabled={!sessionId}
          title={editing ? "Turn editing off to click through the page (slides, menus)" : "Turn editing back on"}
          onClick={() => {
            const next = !editing;
            setEditing(next);
            toFrame({ kind: "editing", on: next });
          }}
        >
          {editing ? <PenLine aria-hidden="true" className="size-4" /> : <MousePointerClick aria-hidden="true" className="size-4" />}
          <span className="hidden sm:inline">{editing ? "Editing on" : "Editing off"}</span>
        </Button>
        {versions?.length ? (
          <VersionMenu
            versions={versions}
            busy={live.view?.status !== "idle" && live.view?.status !== "waiting_agent"}
            onRestore={onRestore}
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
            {health && (health.blank || health.scripts.length > 0 || health.styles.length > 0) ? (
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
                key={pageId}
                src={frameSrc}
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
          <LiveDesignChat live={live} deployable={!!engine} deployChanges={engine?.deployChanges} onPreview={(url, label) => setPreview({ url, label })} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The page's versions. Restoring one makes it the newest version, so nothing is
 * ever lost and every restore can itself be undone.
 */
function VersionMenu({
  versions,
  busy,
  onRestore,
}: {
  versions: VersionItem[];
  busy: boolean;
  onRestore: (restoreId: string) => void;
}) {
  const newest = versions[0];
  const previous = versions.find((v, i) => i > 0 && v.restoreId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Versions">
          <History aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Version {newest?.version ?? 1}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem disabled={busy || !previous} onSelect={() => previous?.restoreId && onRestore(previous.restoreId)}>
          <Undo2 aria-hidden="true" className="size-4" />
          Undo last change
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Versions</DropdownMenuLabel>
        {versions.map((v) => (
          <DropdownMenuItem
            key={v.id}
            disabled={busy || v.current || !v.restoreId}
            onSelect={() => v.restoreId && onRestore(v.restoreId)}
            className="justify-between"
          >
            <span className="min-w-0">
              <span className="font-medium">Version {v.version}</span>
              <span className="block text-xs text-muted-foreground">{formatDateTime(v.createdAt)}</span>
            </span>
            {v.current ? (
              <span className="text-xs text-muted-foreground">Showing</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <RotateCcw aria-hidden="true" className="size-3.5" /> Restore
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
