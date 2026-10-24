import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, Film, History, Image as ImageIcon, PenLine, Plus, RefreshCw } from "lucide-react";
import {
  WEBSITE_FRAME_SANDBOX,
  createWebsiteFrameNonce,
  websiteFrameSrc,
  type WebsiteFrameInsertMediaResult,
  type WebsiteMediaItem,
  type WebsitePage,
  type WebsiteProperty,
  type WebsiteRevision,
  type WebsiteSite,
} from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { useConfirm } from "../../context/ConfirmContext";
import { useCompanyLiveEvent } from "../../context/LiveUpdatesProvider";
import { queryKeys } from "../../lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { cn, formatTime, relativeTime } from "@/lib/utils";
import {
  WebsiteFrameHostSession,
  type WebsiteFrameBlockPick,
  type WebsiteFrameConnection,
  type WebsiteFrameSaveAnswer,
  type WebsiteFrameSaveState,
} from "../../lib/website-frame-host";
import {
  editorOpenProblem,
  fetchAssetBlob,
  frameConnectionMessage,
  frameDraft,
  insertMediaAssetUrl,
  insertMediaEntry,
  insertMediaField,
  insertMediaMessage,
  saveThroughGsam,
} from "../../lib/website-editor";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ScaledFrame } from "../AttachmentPreviewPanel";
import { EmptyState } from "../EmptyState";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { WebsiteChangeRequestPanel } from "./WebsiteChangeRequest";
import { WEBSITE_PREVIEW_DEVICES, type WebsitePreviewDevice, type WebsiteTab } from "./WebsiteHub";
import { useWebsiteSite } from "./WebsiteSiteConnection";
import { WebsiteMediaCard, WebsiteMediaPicker, type MediaPickerKind, type PickedWebsiteMedia } from "./WebsiteStudioMedia";

// The Website page's editor workspace (GRE-2118, plan 3.4): the site's pages,
// the site's own Puck editor in a frame (GRE-1916 contract), save states,
// history and restore, preview at three widths, and the site's media. Every
// save goes through GSAM's API; the frame holds no login.

const ORIGIN_CHANGED_NOTICE = "The editor address for this site changed. Reload to continue.";

type Mode = "edit" | "preview";
type Source = "draft" | "live";
type Panel = "history" | "media" | null;

export function WebsiteEditorTab({
  companyId,
  property,
  onOpenTab,
}: {
  companyId: string;
  property: WebsiteProperty;
  onOpenTab: (tab: WebsiteTab) => void;
}) {
  const { site, isLoading, error, refetch } = useWebsiteSite(companyId, property.id);
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the site</p>;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!site) {
    return (
      <EmptyState
        icon={FileText}
        title="Connect the site first"
        message="Pages are edited here once the site is connected. Connect it under Overview, Site connection."
        action="Open Overview"
        onAction={() => onOpenTab("overview")}
      />
    );
  }
  if (!site.editorFrameOrigin) {
    return (
      <EmptyState
        icon={PenLine}
        title="Set the editor address"
        message="The site's editor runs on its own address, for example https://editor.example.com. A company owner or admin sets it under Overview, Site connection."
        action="Open Overview"
        onAction={() => onOpenTab("overview")}
      />
    );
  }
  return <EditorWorkspace companyId={companyId} site={site} />;
}

function EditorWorkspace({ companyId, site }: { companyId: string; site: WebsiteSite }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const pagesQuery = useQuery({
    queryKey: queryKeys.website.pages(companyId, site.id),
    queryFn: () => websiteModuleApi.pages(companyId, site.id),
  });
  const pages = pagesQuery.data ?? [];
  const page = pages.find((entry) => entry.id === searchParams.get("page")) ?? pages[0] ?? null;
  const [mode, setMode] = useState<Mode>("edit");
  const [source, setSource] = useState<Source>("draft");
  const [device, setDevice] = useState<WebsitePreviewDevice>("laptop");
  const [panel, setPanel] = useState<Panel>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Click to change: the block to select once the editor has the draft. */
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [focusBlockName, setFocusBlockName] = useState("");
  const sessionRef = useRef<WebsiteFrameHostSession<Window> | null>(null);

  // Warn before the browser leaves with unsaved edits in the frame.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Rule C2.3: a changed editor address ends this editor session.
  useCompanyLiveEvent((event) => {
    if (event.type !== "activity.logged") return;
    const payload = event.payload as { action?: unknown; entityId?: unknown };
    if (payload.action !== "website.site_editor_origin_changed" || payload.entityId !== site.id) return;
    sessionRef.current?.teardown();
    setNotice(dirty ? `${ORIGIN_CHANGED_NOTICE} Edits that were not saved are lost.` : ORIGIN_CHANGED_NOTICE);
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.sites(companyId) });
  });

  const leaveUnsaved = useCallback(async () => {
    if (!dirty) return true;
    return confirm({
      title: "Leave without saving?",
      description: "The editor has changes that are not saved. They are lost if you continue.",
      confirmLabel: "Leave",
      tone: "destructive",
    });
  }, [confirm, dirty]);

  const openPage = async (pageId: string) => {
    if (pageId === page?.id || !(await leaveUnsaved())) return;
    const params = new URLSearchParams(searchParams);
    params.set("page", pageId);
    setSearchParams(params, { replace: true });
    setDirty(false);
    setFocusBlockId(null);
  };

  const switchView = async (next: { mode?: Mode; source?: Source }) => {
    if (!(await leaveUnsaved())) return false;
    if (next.mode) setMode(next.mode);
    if (next.source) setSource(next.source);
    setDirty(false);
    return true;
  };

  // A words or image change goes straight into the draft: open the block in the editor.
  const editBlock = async (blockId: string, blockName: string) => {
    setFocusBlockId(blockId);
    setFocusBlockName(blockName);
    if (!(await switchView({ mode: "edit", source: "draft" }))) setFocusBlockId(null);
  };

  const reload = () => {
    setNotice(null);
    setDirty(false);
    setFrameKey((key) => key + 1);
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.sites(companyId) });
  };

  if (pagesQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading pages</p>;
  if (pagesQuery.error) return <ErrorState error={pagesQuery.error} onRetry={() => void pagesQuery.refetch()} />;
  if (!page) {
    return <EmptyState icon={FileText} title="No pages yet" message="Pages appear here once the sitemap is approved and its pages are created." />;
  }

  // The block opened from click to change is the editor's selected block: the
  // frame does not tell GSAM about selections made inside the editor.
  const insertBlockId = mode === "edit" ? focusBlockId : null;
  const insertMedia = async (media: PickedWebsiteMedia, kind: MediaPickerKind): Promise<WebsiteFrameInsertMediaResult | null> => {
    const session = sessionRef.current;
    if (!session || !insertBlockId) return null;
    // Size from the Website media list when it has the entry; a new entry is not in it yet.
    const known = queryClient
      .getQueryData<WebsiteMediaItem[]>(queryKeys.website.media(companyId, site.id))
      ?.find((item) => item.assetId === media.assetId);
    const entry = await insertMediaEntry(
      { contentPath: media.contentPath, alt: media.alt, width: known?.width ?? null, height: known?.height ?? null },
      fetchAssetBlob,
    );
    return session.insertMedia({
      blockId: insertBlockId,
      field: insertMediaField(session.shownPageData, insertBlockId, kind),
      // The GSAM asset id: the frame stores `media:<id>`, and draft media and releases key media by it.
      mediaEntryId: media.assetId,
      assetUrl: insertMediaAssetUrl(media.contentPath, window.location.origin),
      alt: media.alt,
      ...(entry ? { media: entry } : {}),
    });
  };

  const width = mode === "preview" ? WEBSITE_PREVIEW_DEVICES.find((entry) => entry.value === device)!.width : null;

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row" data-testid="website-editor">
      <PageList pages={pages} selectedId={page.id} onOpen={(id) => void openPage(id)} />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
            <h2 className="truncate text-lg font-semibold">{page.title}</h2>
            <p className="truncate font-mono text-xs text-muted-foreground">{page.slug}</p>
          </div>
          <Segmented
            label="Mode"
            value={mode}
            options={[
              { value: "edit", label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
            onChange={(value) => void switchView({ mode: value })}
          />
          {mode === "preview" ? (
            <>
              <Segmented
                label="Preview version"
                value={source}
                options={[
                  { value: "draft", label: "Draft" },
                  { value: "live", label: "Live" },
                ]}
                onChange={(value) => void switchView({ source: value })}
              />
              <Segmented
                label="Preview width"
                value={device}
                options={WEBSITE_PREVIEW_DEVICES.map((entry) => ({ value: entry.value, label: `${entry.label} ${entry.width}` }))}
                onChange={setDevice}
              />
            </>
          ) : null}
          <Button type="button" size="sm" variant={panel === "history" ? "secondary" : "outline"} aria-pressed={panel === "history"} onClick={() => setPanel(panel === "history" ? null : "history")}>
            <History />
            History
          </Button>
          <Button type="button" size="sm" variant={panel === "media" ? "secondary" : "outline"} aria-pressed={panel === "media"} onClick={() => setPanel(panel === "media" ? null : "media")}>
            <ImageIcon />
            Media
          </Button>
        </div>
        {notice ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-status-warning/40 bg-status-warning-soft px-4 py-3 text-sm text-status-warning-foreground">
            <span className="min-w-0 flex-1">{notice}</span>
            <Button type="button" size="sm" variant="outline" onClick={reload}>Reload</Button>
          </div>
        ) : (
          <EditorFrame
            key={`${page.id}:${mode}:${source}:${frameKey}`}
            companyId={companyId}
            site={site}
            page={page}
            mode={mode}
            source={source}
            width={width}
            device={device}
            dirty={dirty}
            sessionRef={sessionRef}
            focusBlockId={mode === "edit" ? focusBlockId : null}
            onEditBlock={(blockId, blockName) => void editBlock(blockId, blockName)}
            onDirty={setDirty}
            onOriginChanged={() => setNotice(ORIGIN_CHANGED_NOTICE)}
            onReload={reload}
          />
        )}
      </div>
      {panel === "history" ? (
        <HistoryPanel
          companyId={companyId}
          site={site}
          page={page}
          beforeRestore={leaveUnsaved}
          onRestored={() => {
            setDirty(false);
            setFrameKey((key) => key + 1);
          }}
        />
      ) : null}
      {panel === "media" ? (
        <MediaPanel
          companyId={companyId}
          site={site}
          dirty={dirty}
          insertBlockId={insertBlockId}
          insertBlockName={focusBlockName}
          insertMedia={insertMedia}
          onInserted={() => setDirty(true)}
          onMediaAdded={() => {
            // The frame gets the site's media with load-draft, so a clean editor reloads to pick up the new item.
            if (!dirty) setFrameKey((key) => key + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function PageList({ pages, selectedId, onOpen }: { pages: WebsitePage[]; selectedId: string; onOpen: (pageId: string) => void }) {
  return (
    <nav aria-label="Pages" className="min-w-0 lg:w-60 lg:shrink-0">
      <label className="block lg:hidden">
        <span className="sr-only">Page</span>
        <NativeSelect value={selectedId} onChange={(event) => onOpen(event.target.value)}>
          {pages.map((entry) => (
            <option key={entry.id} value={entry.id}>{`${entry.title} (${entry.slug})`}</option>
          ))}
        </NativeSelect>
      </label>
      <ul className="hidden space-y-0.5 lg:block">
        {pages.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              aria-current={entry.id === selectedId ? "page" : undefined}
              onClick={() => onOpen(entry.id)}
              className={cn(
                "flex w-full min-w-0 flex-col rounded-md px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                entry.id === selectedId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span className="truncate text-sm font-medium">{entry.title}</span>
              <span className="truncate font-mono text-xs">{entry.slug}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex h-8 items-center px-2.5 text-xs font-medium first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EditorFrame({
  companyId,
  site,
  page,
  mode,
  source,
  width,
  device,
  dirty,
  sessionRef,
  focusBlockId,
  onEditBlock,
  onDirty,
  onOriginChanged,
  onReload,
}: {
  companyId: string;
  site: WebsiteSite;
  page: WebsitePage;
  mode: Mode;
  source: Source;
  width: number | null;
  device: WebsitePreviewDevice;
  dirty: boolean;
  sessionRef: React.MutableRefObject<WebsiteFrameHostSession<Window> | null>;
  focusBlockId: string | null;
  onEditBlock: (blockId: string, blockName: string) => void;
  onDirty: (dirty: boolean) => void;
  onOriginChanged: () => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [connection, setConnection] = useState<WebsiteFrameConnection>({ phase: "connecting" });
  const [saveState, setSaveState] = useState<WebsiteFrameSaveState>({ status: "idle" });
  const [frameError, setFrameError] = useState<string | null>(null);
  /** Click to change: the block picked in the preview; each pick starts a fresh request. */
  const [pick, setPick] = useState<{ n: number; pick: WebsiteFrameBlockPick } | null>(null);
  const editorOrigin = site.editorFrameOrigin!;
  const problem = editorOpenProblem(site, window.location.origin, import.meta.env.DEV);
  const notLive = mode === "preview" && source === "live" && !page.publishedRevisionId;

  useEffect(() => {
    const listener = (event: MessageEvent) => sessionRef.current?.handleMessage(event as MessageEvent & { source: Window | null });
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      sessionRef.current?.teardown();
      sessionRef.current = null;
    };
  }, [sessionRef]);

  const start = () => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow || sessionRef.current) return;
    const session = new WebsiteFrameHostSession<Window>({
      siteId: site.id,
      pageId: page.id,
      mode: mode === "edit" ? "editor" : "preview",
      editorOrigin,
      nonce: createWebsiteFrameNonce(),
      source: frameWindow,
      post: (message, targetOrigin) => frameWindow.postMessage(message, targetOrigin),
      loadDraft: async () => {
        const load = await websiteModuleApi.pageEditor(companyId, site.id, page.id);
        if (mode === "preview" && source === "live" && load.page.publishedRevisionId) {
          const live = await websiteModuleApi.revision(companyId, site.id, page.id, load.page.publishedRevisionId);
          return frameDraft(load, fetchAssetBlob, { revisionId: live.revision.id, data: live.content });
        }
        return frameDraft(load, fetchAssetBlob);
      },
      saveDraft: async (request): Promise<WebsiteFrameSaveAnswer> => {
        const answer = await saveThroughGsam(request, {
          save: (body) => websiteModuleApi.savePageContent(companyId, site.id, page.id, body),
          latest: async () => {
            const [detail, revisions] = await Promise.all([
              websiteModuleApi.page(companyId, site.id, page.id),
              websiteModuleApi.revisions(companyId, site.id, page.id),
            ]);
            return { content: detail.content, revisions };
          },
        });
        if (answer.outcome === "saved") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.website.revisions(companyId, site.id, page.id) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, site.id) });
        }
        if (answer.outcome === "failed" && answer.code === "origin-changed") onOriginChanged();
        return answer;
      },
      onConnection: setConnection,
      onSaveState: setSaveState,
      onDirty,
      onBlockPicked: (picked) => {
        setPick((current) => ({ n: (current?.n ?? 0) + 1, pick: picked }));
        sessionRef.current?.highlight(picked.ref.blockId);
      },
      onDraftLoaded: () => {
        if (focusBlockId) sessionRef.current?.highlight(focusBlockId);
      },
      onFrameError: (error) => setFrameError(error.message),
      onDrop: (reason) => console.warn(`[website editor] dropped a frame message: ${reason}`),
    });
    sessionRef.current = session;
    session.start();
  };

  if (problem) {
    return (
      <div role="alert" className="rounded-lg border border-status-danger/40 bg-status-danger-soft px-4 py-3 text-sm text-status-danger-foreground">
        GSAM will not open the editor from {editorOrigin}: it must be its own https address, not the public site or a GSAM address. A company owner or admin can change it under Overview, Site connection.
      </div>
    );
  }
  if (notLive) {
    return <EmptyState icon={FileText} title="This page is not live yet" message="It has no published version. Preview the draft instead." />;
  }

  const connectionMessage = frameConnectionMessage(connection, editorOrigin);
  return (
    <div className="space-y-3">
      <SaveBanner
        mode={mode}
        connection={connection}
        connectionMessage={connectionMessage}
        saveState={saveState}
        dirty={dirty}
        frameError={frameError}
        canRetry={Boolean(sessionRef.current?.canRetry)}
        onRetrySave={() => void sessionRef.current?.retry()}
        onReconnect={onReload}
      />
      {mode === "preview" && connection.phase === "ready" && pick ? (
        <WebsiteChangeRequestPanel
          key={pick.n}
          companyId={companyId}
          siteId={site.id}
          page={page}
          pick={pick.pick}
          onCancel={() => {
            setPick(null);
            sessionRef.current?.highlight(null);
          }}
          onEditBlock={onEditBlock}
        />
      ) : null}
      <div className={cn("relative overflow-hidden rounded-xl border border-border bg-muted", mode === "edit" ? "h-(--sz-80vh)" : "h-(--sz-70vh)")}>
        <ScaledFrame
          frameRef={frameRef}
          src={websiteFrameSrc(editorOrigin, mode === "edit" ? "editor" : "preview", page.id)}
          title={mode === "edit" ? "Page editor" : `Page preview, ${device} width`}
          width={width}
          sandbox={WEBSITE_FRAME_SANDBOX}
          allow=""
          onLoad={start}
          testId="website-editor-frame"
          viewport={mode === "preview" ? device : "editor"}
        />
      </div>
    </div>
  );
}

function SaveBanner({
  mode,
  connection,
  connectionMessage,
  saveState,
  dirty,
  frameError,
  canRetry,
  onRetrySave,
  onReconnect,
}: {
  mode: Mode;
  connection: WebsiteFrameConnection;
  connectionMessage: string | null;
  saveState: WebsiteFrameSaveState;
  dirty: boolean;
  frameError: string | null;
  canRetry: boolean;
  onRetrySave: () => void;
  onReconnect: () => void;
}) {
  const tone = {
    neutral: "border-border bg-muted/40 text-muted-foreground",
    success: "border-status-success/40 bg-status-success-soft text-status-success-foreground",
    warning: "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
    danger: "border-status-danger/40 bg-status-danger-soft text-status-danger-foreground",
  };
  let kind: keyof typeof tone = "neutral";
  let text: string;
  let action: { label: string; onClick: () => void } | null = null;

  if (connectionMessage) {
    kind = connection.phase === "no-answer" ? "warning" : "danger";
    text = connectionMessage;
    action = { label: "Retry", onClick: onReconnect };
  } else if (connection.phase === "connecting") {
    text = "Connecting to the site's editor";
  } else if (frameError) {
    kind = "danger";
    text = frameError;
    action = { label: "Reload", onClick: onReconnect };
  } else if (mode === "preview") {
    text = "Preview. Click a block to ask for a change, or switch to Edit to change it yourself.";
  } else if (saveState.status === "saving") {
    text = "Saving";
  } else if (saveState.status === "saved") {
    kind = "success";
    text = `Saved at ${formatTime(saveState.savedAt)}`;
  } else if (saveState.status === "conflict") {
    kind = "warning";
    text = `Someone saved this page first (${saveState.savedBy}, ${relativeTime(saveState.savedAt)}). Choose Keep mine or Take theirs in the editor.`;
  } else if (saveState.status === "failed") {
    kind = "danger";
    text = saveState.message;
    if (saveState.retryable && canRetry) action = { label: "Retry", onClick: onRetrySave };
  } else {
    text = dirty ? "Unsaved changes. Save in the editor." : "No changes yet.";
  }
  if (!connectionMessage && mode === "edit" && dirty && saveState.status !== "saving" && saveState.status !== "idle") {
    text = `${text} Unsaved changes.`;
  }

  return (
    <div
      role={kind === "danger" || kind === "warning" ? "alert" : "status"}
      data-testid="website-save-banner"
      data-state={connectionMessage ? connection.phase : saveState.status}
      className={cn("flex min-h-10 flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm", tone[kind])}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {action ? (
        <Button type="button" size="xs" variant="outline" onClick={action.onClick}>
          <RefreshCw />
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function revisionAuthor(revision: WebsiteRevision) {
  if (revision.createdByAgentId) return "an agent";
  if (revision.createdByUserId) return "a person";
  return "GSAM";
}

function HistoryPanel({
  companyId,
  site,
  page,
  beforeRestore,
  onRestored,
}: {
  companyId: string;
  site: WebsiteSite;
  page: WebsitePage;
  beforeRestore: () => Promise<boolean>;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [message, setMessage] = useState<string | null>(null);
  const revisionsQuery = useQuery({
    queryKey: queryKeys.website.revisions(companyId, site.id, page.id),
    queryFn: () => websiteModuleApi.revisions(companyId, site.id, page.id),
  });
  const revisions = revisionsQuery.data ?? [];
  const restore = useMutation({
    mutationFn: (revision: WebsiteRevision) =>
      websiteModuleApi.restoreRevision(companyId, site.id, page.id, revision.id, revisions[0]!.id),
    onSuccess: (result, revision) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.revisions(companyId, site.id, page.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, site.id) });
      if (result.state === "saved") {
        setMessage(`Version ${revision.revisionNumber} restored as version ${result.revisionNumber}.`);
        onRestored();
      } else if (result.state === "conflict") {
        setMessage("Someone saved a newer version. The history is updated; choose again.");
      } else {
        setMessage(result.message);
      }
    },
    onError: (error) => setMessage(errorStateMessage(error)),
  });

  const ask = async (revision: WebsiteRevision) => {
    if (!(await beforeRestore())) return;
    const ok = await confirm({
      title: `Restore version ${revision.revisionNumber}?`,
      description: "Its content becomes a new version of this page. Nothing is deleted; you can restore the current version again later.",
      confirmLabel: "Restore",
    });
    if (ok) restore.mutate(revision);
  };

  return (
    <aside className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4 lg:w-80 lg:shrink-0" aria-labelledby="website-history-title" data-testid="website-history">
      <h3 id="website-history-title" className="text-sm font-semibold">History</h3>
      {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
      {revisionsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading versions</p>
      ) : revisionsQuery.error ? (
        <ErrorState error={revisionsQuery.error} compact onRetry={() => void revisionsQuery.refetch()} />
      ) : (
        <ol className="space-y-2">
          {revisions.map((revision, index) => (
            <li key={revision.id} className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0 flex-1 text-xs">
                <p className="font-medium text-foreground">
                  Version {revision.revisionNumber}
                  {index === 0 ? <span className="ml-1.5 rounded bg-accent px-1.5 py-0.5 text-micro font-medium">Current</span> : null}
                  {revision.id === page.publishedRevisionId ? (
                    <span className="ml-1.5 rounded bg-status-success-soft px-1.5 py-0.5 text-micro font-medium text-status-success-foreground">Live</span>
                  ) : null}
                </p>
                <p className="text-muted-foreground">{`${relativeTime(revision.createdAt)}, by ${revisionAuthor(revision)}`}</p>
                {revision.changeSummary ? <p className="break-words text-muted-foreground">{revision.changeSummary}</p> : null}
              </div>
              {index > 0 ? (
                <Button type="button" size="xs" variant="outline" disabled={restore.isPending} onClick={() => void ask(revision)}>
                  Restore
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function MediaPanel({
  companyId,
  site,
  dirty,
  insertBlockId,
  insertBlockName,
  insertMedia,
  onInserted,
  onMediaAdded,
}: {
  companyId: string;
  site: WebsiteSite;
  dirty: boolean;
  /** The editor's selected block, or null. */
  insertBlockId: string | null;
  /** The selected block's name, as click to change showed it. */
  insertBlockName: string;
  insertMedia: (media: PickedWebsiteMedia, kind: MediaPickerKind) => Promise<WebsiteFrameInsertMediaResult | null>;
  onInserted: () => void;
  onMediaAdded: () => void;
}) {
  const [picker, setPicker] = useState<MediaPickerKind | null>(null);
  const [message, setMessage] = useState<{ text: string; tone?: "success" | "warn" } | null>(null);
  const mediaQuery = useQuery({
    queryKey: queryKeys.website.media(companyId, site.id),
    queryFn: () => websiteModuleApi.media(companyId, site.id),
  });
  const media = mediaQuery.data ?? [];
  const blockName = insertBlockName || "The selected block";

  // Today's flow: the new entry reaches the frame with the next load-draft.
  const added = (text: string) => {
    setMessage({ text: dirty ? `${text} Save the page, then reload the editor to pick it.` : text });
    onMediaAdded();
  };

  // The frame did not answer insert-media (older site): today's flow, and say so.
  const notAnswered = (item: PickedWebsiteMedia, kind: MediaPickerKind) => {
    const noun = kind === "animation" ? "animation" : "image";
    if (!item.created) {
      setMessage({ text: `The site's editor did not answer, so nothing changed. Pick the ${noun} from the block's image field.`, tone: "warn" });
      return;
    }
    setMessage({
      text: dirty
        ? `The site's editor did not answer. The ${noun} is saved in Website media. Save the page, then reload the editor to pick it from the block's image field.`
        : `The site's editor did not answer, so the editor was reloaded. The ${noun} is saved in Website media. Pick it from the block's image field.`,
      tone: "warn",
    });
    onMediaAdded();
  };

  const use = async (text: string, item: PickedWebsiteMedia, kind: MediaPickerKind) => {
    if (!insertBlockId) return added(text);
    setMessage({ text: `Putting it in ${blockName}.` });
    const result = await insertMedia(item, kind);
    if (!result) return notAnswered(item, kind);
    if (result.ok) {
      setMessage({ text: insertMediaMessage(result, blockName, kind), tone: "success" });
      onInserted();
      return;
    }
    // Refused: the entry stays, and a clean editor reloads so its fields can pick it.
    setMessage({ text: insertMediaMessage(result, blockName, kind), tone: "warn" });
    if (item.created && !dirty) onMediaAdded();
  };

  return (
    <aside className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4 lg:w-80 lg:shrink-0" aria-labelledby="website-media-title" data-testid="website-media">
      <div>
        <h3 id="website-media-title" className="text-sm font-semibold">Media</h3>
        <p className="text-xs text-muted-foreground">
          {insertBlockId
            ? `Selected block: ${blockName}. Add image or Add animation puts the item in it.`
            : "The site's images. The editor's image fields pick from these."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => setPicker("image")} data-testid="website-add-image">
          <Plus />
          Add image
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => setPicker("animation")} data-testid="website-add-animation">
          <Film />
          Add animation
        </Button>
      </div>
      {message ? (
        message.tone === "warn" ? (
          <p role="alert" className="rounded-md border border-status-warning/40 bg-status-warning-soft px-2.5 py-2 text-xs text-status-warning-foreground">
            {message.text}
          </p>
        ) : message.tone === "success" ? (
          <p role="status" className="flex gap-1.5 rounded-md border border-status-success/30 bg-status-success-soft px-2.5 py-2 text-xs text-status-success-foreground">
            <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{message.text}</span>
          </p>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">{message.text}</p>
        )
      ) : null}
      {mediaQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading media</p>
      ) : mediaQuery.error ? (
        <ErrorState error={mediaQuery.error} compact onRetry={() => void mediaQuery.refetch()} />
      ) : media.length === 0 ? (
        <p className="text-xs text-muted-foreground">No media yet. Images added as media entries show here.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {media.map((item) => (
            <WebsiteMediaCard key={item.entryId} item={item} />
          ))}
        </ul>
      )}
      <WebsiteMediaPicker
        companyId={companyId}
        site={site}
        kind={picker}
        media={media}
        canInsert={insertBlockId !== null}
        insertBlockName={insertBlockName}
        onClose={() => setPicker(null)}
        onAdded={(text, item) => void use(text, item, picker ?? "image")}
      />
    </aside>
  );
}
