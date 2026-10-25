import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Eye,
  FileText,
  Film,
  History,
  Image as ImageIcon,
  ListTree,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  PenLine,
  Plus,
  Redo2,
  RefreshCw,
  Send,
  Undo2,
  Waves,
  X,
} from "lucide-react";
import {
  WEBSITE_FRAME_SANDBOX,
  createWebsiteFrameNonce,
  websiteFrameSrc,
  type WebsiteEditorCommand,
  type WebsiteFrameEditorState,
  type WebsiteFrameInsertMediaResult,
  type WebsiteFrameMediaRequested,
  type WebsiteFrameSetMotionResult,
  type WebsiteMotionChoice,
  type WebsiteMotionIntensity,
  type WebsiteMediaItem,
  type WebsitePage,
  type WebsitePageStatus,
  type WebsiteProperty,
  type WebsiteRevision,
  type WebsiteSite,
} from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { useConfirm } from "../../context/ConfirmContext";
import { useCompanyLiveEvent } from "../../context/LiveUpdatesProvider";
import { queryKeys } from "../../lib/queryKeys";
import { Navigate, useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { cn, formatTime, relativeTime } from "@/lib/utils";
import {
  WebsiteFrameHostSession,
  type WebsiteFrameBlockPick,
  type WebsiteFrameConnection,
  type WebsiteFrameSaveAnswer,
  type WebsiteFrameSaveState,
} from "../../lib/website-frame-host";
import {
  MOTION_INTENSITY_LABELS,
  blockMotionOptions,
  editorOpenProblem,
  fetchAssetBlob,
  frameConnectionMessage,
  frameDraft,
  insertMediaAssetUrl,
  insertMediaEntry,
  insertMediaField,
  insertMediaMessage,
  motionChoice,
  motionOptionFor,
  saveThroughGsam,
  setMotionMessage,
  websiteEditorPath,
  type BlockMotionOptions,
  type MotionOption,
} from "../../lib/website-editor";
import { isTextField, websiteEditorEscape, websiteEditorShortcut } from "../../lib/website-editor-shortcuts";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScaledFrame } from "../AttachmentPreviewPanel";
import { EmptyState } from "../EmptyState";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { WebsiteChangeRequestPanel, type WebsiteChangeTarget } from "./WebsiteChangeRequest";
import { WebsiteCommentsPanel, useWebsitePageComments } from "./WebsitePageComments";
import { WEBSITE_PREVIEW_DEVICES, type WebsitePreviewDevice, type WebsiteTab } from "./WebsiteHub";
import { useWebsiteSite } from "./WebsiteSiteConnection";
import { WebsiteMediaCard, WebsiteMediaPicker, type MediaPickerKind, type PickedWebsiteMedia } from "./WebsiteStudioMedia";

// The Website editor (GRE-2296). The Pages tab lists the site's pages; Edit
// opens the full-screen editor at /website/edit: one slim top bar, the site's
// own Puck editor in a frame across the whole canvas (GRE-1916 contract), and
// one drawer for History, Media, Motion and click to change that opens only
// when asked for. Every save goes through GSAM's API; the frame holds no
// login, and nothing publishes from here: Request publish asks a person with
// Publish rights to approve the page.

const ORIGIN_CHANGED_NOTICE = "The editor address for this site changed. Reload to continue.";

type Mode = "edit" | "preview";
type Source = "draft" | "live";
type Drawer = "history" | "media" | "motion" | "change" | "comments" | null;

const PAGE_STATUS_COPY: Record<WebsitePageStatus, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "bg-muted text-muted-foreground" },
  draft: { label: "Draft", tone: "bg-status-running-soft text-status-running-foreground" },
  review: { label: "Waiting for approval", tone: "bg-status-warning-soft text-status-warning-foreground" },
  approved: { label: "Approved", tone: "bg-status-info-soft text-status-info-foreground" },
  published: { label: "Live", tone: "bg-status-success-soft text-status-success-foreground" },
};

/* ---- Pages tab ---- */

/** Where the full-screen editor goes back to: the page that opened it. */
export function useOpenWebsiteEditor() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (input: { propertyId?: string | null; pageId?: string | null; motion?: string | null } = {}) =>
      navigate(websiteEditorPath(input), { state: { from: `${location.pathname}${location.search}` } }),
    [location.pathname, location.search, navigate],
  );
}

function SiteNotReady({ site, onOpenTab }: { site: WebsiteSite | null; onOpenTab: (tab: WebsiteTab) => void }) {
  if (!site) {
    return (
      <EmptyState
        icon={FileText}
        title="Connect the site first"
        message="Pages are edited here once the site is connected. Connect it under Releases, Site connection."
        action="Open Releases"
        onAction={() => onOpenTab("releases")}
      />
    );
  }
  return (
    <EmptyState
      icon={PenLine}
      title="Set the editor address"
      message="The site's editor runs on its own address, for example https://editor.example.com. A company owner or admin sets it under Releases, Site connection."
      action="Open Releases"
      onAction={() => onOpenTab("releases")}
    />
  );
}

/** The Pages tab: every page of the site, each with Edit into the full-screen editor. */
export function WebsitePagesTab({
  companyId,
  property,
  onOpenTab,
}: {
  companyId: string;
  property: WebsiteProperty;
  onOpenTab: (tab: WebsiteTab) => void;
}) {
  const { site, isLoading, error, refetch } = useWebsiteSite(companyId, property.id);
  const [searchParams] = useSearchParams();
  const openEditor = useOpenWebsiteEditor();
  const pagesQuery = useQuery({
    queryKey: queryKeys.website.pages(companyId, site?.id ?? ""),
    queryFn: () => websiteModuleApi.pages(companyId, site!.id),
    enabled: !!site?.editorFrameOrigin,
  });

  // The old in-page editor's links (`?tab=editor&page=` and GS Studio's `&motion=`) open the full-screen editor.
  const legacyPage = searchParams.get("page");
  const legacyMotion = searchParams.get("motion");
  if (legacyPage || legacyMotion) {
    return <Navigate replace to={websiteEditorPath({ propertyId: property.id, pageId: legacyPage, motion: legacyMotion })} />;
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the site</p>;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!site || !site.editorFrameOrigin) return <SiteNotReady site={site} onOpenTab={onOpenTab} />;
  if (pagesQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading pages</p>;
  if (pagesQuery.error) return <ErrorState error={pagesQuery.error} onRetry={() => void pagesQuery.refetch()} />;
  const pages = pagesQuery.data ?? [];
  if (pages.length === 0) {
    return <EmptyState icon={FileText} title="No pages yet" message="Pages appear here once the sitemap is approved and its pages are created." />;
  }

  return (
    <section className="space-y-3" aria-labelledby="website-pages-title" data-testid="website-pages">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="website-pages-title" className="text-sm font-semibold">Pages</h2>
          <p className="text-xs text-muted-foreground">Edit opens the page full screen. Click any words or image on the page to change them.</p>
        </div>
        <Button type="button" size="sm" onClick={() => openEditor({ propertyId: property.id, pageId: pages[0]!.id })}>
          <PenLine />
          Edit pages
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {pages.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <button
              type="button"
              onClick={() => openEditor({ propertyId: property.id, pageId: entry.id })}
              className="flex min-w-0 flex-1 basis-48 flex-col rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-sm font-medium">{entry.title}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{entry.slug}</span>
            </button>
            <PageStatusPill status={entry.status} />
            <Button type="button" size="xs" variant="outline" onClick={() => openEditor({ propertyId: property.id, pageId: entry.id })} aria-label={`Edit ${entry.title}`}>
              <PenLine />
              Edit
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageStatusPill({ status }: { status: WebsitePageStatus }) {
  const copy = PAGE_STATUS_COPY[status] ?? PAGE_STATUS_COPY.draft;
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", copy.tone)}>{copy.label}</span>;
}

/* ---- Full-screen editor ---- */

/**
 * The full-screen editor of one website (GRE-2296). It covers the whole
 * viewport above GSAM's sidebar and header; GSAM's dialogs, menus and toasts
 * still open above it.
 */
export function WebsiteFullScreenEditor({
  companyId,
  property,
  onLeave,
}: {
  companyId: string;
  property: WebsiteProperty;
  /** Back: where the person came from. */
  onLeave: () => void;
}) {
  const { site, isLoading, error, refetch } = useWebsiteSite(companyId, property.id);
  let body: ReactNode;
  if (isLoading) body = <ScreenMessage>Loading the site</ScreenMessage>;
  else if (error) body = <ScreenMessage><ErrorState error={error} onRetry={() => void refetch()} /></ScreenMessage>;
  else if (!site || !site.editorFrameOrigin) {
    body = (
      <ScreenMessage>
        <SiteNotReady site={site} onOpenTab={onLeave} />
      </ScreenMessage>
    );
  } else return <EditorScreen companyId={companyId} site={site} onLeave={onLeave} />;
  return (
    <FullScreen>
      <TopBar>
        <BackButton onClick={onLeave} />
      </TopBar>
      {body}
    </FullScreen>
  );
}

export function FullScreen({ children }: { children: ReactNode }) {
  // The page under the editor does not scroll while it is open.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-dialog flex flex-col bg-background pt-(--sz-safe-top) text-foreground"
      data-testid="website-editor"
    >
      {children}
    </div>,
    document.body,
  );
}

function ScreenMessage({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-start justify-center overflow-auto p-6 text-sm text-muted-foreground">{children}</div>;
}

function TopBar({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2 sm:gap-1.5" data-testid="website-editor-topbar">
      {children}
    </header>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick} aria-label="Back to Website" title="Back to Website (Esc)">
      <ArrowLeft />
      <span className="hidden sm:inline">Website</span>
    </Button>
  );
}

function openDialogShown() {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

function EditorScreen({ companyId, site, onLeave }: { companyId: string; site: WebsiteSite; onLeave: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const pagesQuery = useQuery({
    queryKey: queryKeys.website.pages(companyId, site.id),
    queryFn: () => websiteModuleApi.pages(companyId, site.id),
  });
  const pages = pagesQuery.data ?? [];
  const page = pages.find((entry) => entry.id === searchParams.get("page")) ?? pages[0] ?? null;
  const openComments = useWebsitePageComments(companyId, site.id, page?.id ?? null).data?.length ?? 0;
  const [mode, setMode] = useState<Mode>("edit");
  const [source, setSource] = useState<Source>("draft");
  const [device, setDevice] = useState<WebsitePreviewDevice>("laptop");
  /** GS Studio's Use on website: the study number or effect to place, from `?motion=`. */
  const wantedMotion = searchParams.get("motion");
  const [drawer, setDrawer] = useState<Drawer>(() => (wantedMotion ? "motion" : null));
  /** Counts draft loads, so the Motion panel reads the engine's choices once the frame has them. */
  const [draftLoads, setDraftLoads] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warn" } | null>(null);
  /** The block Media and Motion act on: picked in click to change, selected in the editor, or clicked as an image. */
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [focusBlockName, setFocusBlockName] = useState("");
  /** The image field the editor asked to replace (`media-requested`), and a counter that opens the picker. */
  const [mediaRequest, setMediaRequest] = useState<{ n: number; field: string; kind: MediaPickerKind } | null>(null);
  const [connection, setConnection] = useState<WebsiteFrameConnection>({ phase: "connecting" });
  const [saveState, setSaveState] = useState<WebsiteFrameSaveState>({ status: "idle" });
  const [frameError, setFrameError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<WebsiteFrameEditorState | null>(null);
  const [commands, setCommands] = useState<ReadonlySet<WebsiteEditorCommand>>(new Set());
  /** Click to change or Ask an agent: what the comment is about; each one starts a fresh request. */
  const [ask, setAsk] = useState<{ n: number; target: WebsiteChangeTarget; picked: boolean } | null>(null);
  const sessionRef = useRef<WebsiteFrameHostSession<Window> | null>(null);
  const hadSelection = useRef(false);
  const frameSessionKey = `${page?.id ?? ""}:${mode}:${source}:${frameKey}`;

  // Each iframe load is a new session: nothing from the last one carries over.
  useEffect(() => {
    setConnection({ phase: "connecting" });
    setSaveState({ status: "idle" });
    setFrameError(null);
    setEditorState(null);
    setCommands(new Set());
    setAsk(null);
    setDrawer((current) => (current === "change" ? null : current));
    hadSelection.current = false;
  }, [frameSessionKey]);

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

  const leave = useCallback(async () => {
    if (await leaveUnsaved()) onLeave();
  }, [leaveUnsaved, onLeave]);

  const clearFocus = () => {
    setFocusBlockId(null);
    setFocusBlockName("");
    setMediaRequest(null);
  };

  const openPage = async (pageId: string) => {
    if (pageId === page?.id || !(await leaveUnsaved())) return;
    const params = new URLSearchParams(searchParams);
    params.set("page", pageId);
    setSearchParams(params, { replace: true });
    setDirty(false);
    setMessage(null);
    clearFocus();
  };

  const switchView = async (next: { mode?: Mode; source?: Source }) => {
    if (!(await leaveUnsaved())) return false;
    if (next.mode) setMode(next.mode);
    if (next.source) setSource(next.source);
    setDirty(false);
    if (drawer === "change") setDrawer(null);
    return true;
  };

  // A words or image change goes straight into the draft: open the block in the editor.
  const editBlock = async (blockId: string, blockName: string) => {
    setFocusBlockId(blockId);
    setFocusBlockName(blockName);
    if (!(await switchView({ mode: "edit", source: "draft" }))) {
      setFocusBlockId(null);
      return;
    }
    // A GS Studio hand-off goes back to Motion, now with the block to put it in.
    setDrawer(wantedMotion ? "motion" : null);
  };

  const reload = () => {
    setNotice(null);
    setDirty(false);
    setFrameKey((key) => key + 1);
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.sites(companyId) });
  };

  const onEditorState = (state: WebsiteFrameEditorState) => {
    setEditorState(state);
    if (state.selection) {
      hadSelection.current = true;
      setFocusBlockId(state.selection.blockId);
      setFocusBlockName(state.selection.label);
    } else if (hadSelection.current) {
      // Only a selection the person cleared: the first state after load must not drop a block opened from click to change.
      hadSelection.current = false;
      clearFocus();
    }
  };

  const onMediaRequested = (request: WebsiteFrameMediaRequested) => {
    setFocusBlockId(request.blockId);
    if (request.label) setFocusBlockName(request.label);
    setMediaRequest((current) => ({ n: (current?.n ?? 0) + 1, field: request.field, kind: request.kind }));
    setDrawer("media");
  };

  const run = (command: WebsiteEditorCommand, on?: boolean) => sessionRef.current?.command(command, on) ?? false;

  const save = () => {
    if (mode !== "edit") return;
    if (run("save")) return;
    setMessage({ text: "This site's editor saves from its own Save button. Use it to keep your changes.", tone: "warn" });
  };

  const escape = () => {
    const action = websiteEditorEscape({ drawerOpen: drawer !== null, selected: Boolean(editorState?.selection) });
    if (action === "close-drawer") return setDrawer(null);
    if (action === "deselect") {
      if (!run("deselect")) void leave();
      return;
    }
    void leave();
  };

  // Shortcuts while focus is in GSAM's top bar or drawer; the frame sends Esc itself (`editor-key`).
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || openDialogShown()) return;
    const shortcut = websiteEditorShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      inTextField: isTextField(event.target),
    });
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "save") save();
    else if (shortcut === "undo") run("undo");
    else if (shortcut === "redo") run("redo");
    else escape();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const requestPublish = useMutation({
    mutationFn: (target: WebsitePage) => websiteModuleApi.submitPage(companyId, site.id, target.id),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, site.id) });
      setMessage({ text: `${updated.title} is waiting for approval. A person with Publish rights reviews it and publishes it; nothing is live yet.`, tone: "success" });
    },
    onError: (error) => setMessage({ text: errorStateMessage(error), tone: "warn" }),
  });

  const askToPublish = async () => {
    if (!page) return;
    if (dirty) {
      setMessage({ text: "Save the page first. Request publish sends the saved version.", tone: "warn" });
      return;
    }
    const ok = await confirm({
      title: `Request publish for ${page.title}?`,
      description: "A person with Publish rights reviews the saved version and publishes it. Nothing goes live now.",
      confirmLabel: "Request publish",
    });
    if (ok) requestPublish.mutate(page);
  };

  // Ask an agent (GRE-2350): about the block selected in the editor, else the whole page.
  const askAgent = () => {
    const selection = mode === "edit" ? editorState?.selection : null;
    const target: WebsiteChangeTarget = selection
      ? { kind: "block", blockId: selection.blockId, blockType: selection.blockType, label: selection.label }
      : { kind: "page" };
    setAsk((current) => ({ n: (current?.n ?? 0) + 1, target, picked: false }));
    setDrawer("change");
  };

  // An agent's change is a draft of this page: show the latest draft in the preview.
  const previewChange = async () => {
    if (!(await switchView({ mode: "preview", source: "draft" }))) return;
    setFrameKey((key) => key + 1);
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, site.id) });
  };

  if (pagesQuery.isLoading || pagesQuery.error || !page) {
    return (
      <FullScreen>
        <TopBar>
          <BackButton onClick={onLeave} />
        </TopBar>
        <ScreenMessage>
          {pagesQuery.isLoading ? (
            "Loading pages"
          ) : pagesQuery.error ? (
            <ErrorState error={pagesQuery.error} onRetry={() => void pagesQuery.refetch()} />
          ) : (
            <EmptyState icon={FileText} title="No pages yet" message="Pages appear here once the sitemap is approved and its pages are created." />
          )}
        </ScreenMessage>
      </FullScreen>
    );
  }

  // The block opened from click to change, selected in the editor, or clicked as an image.
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
      // The field the editor asked for, else the block's media field.
      field: mediaRequest?.field ?? insertMediaField(session.shownPageData, insertBlockId, kind),
      // The GSAM asset id: the frame stores `media:<id>`, and draft media and releases key media by it.
      mediaEntryId: media.assetId,
      assetUrl: insertMediaAssetUrl(media.contentPath, window.location.origin),
      alt: media.alt,
      ...(entry ? { media: entry } : {}),
    });
  };

  const setMotion = async (choice: WebsiteMotionChoice): Promise<WebsiteFrameSetMotionResult | null> => {
    const session = sessionRef.current;
    if (!session || !insertBlockId) return null;
    return session.setMotion({ blockId: insertBlockId, motion: choice });
  };
  const session = sessionRef.current;
  const motionReady = mode === "edit" && draftLoads > 0 && session !== null;
  const motionOptions =
    motionReady && insertBlockId ? blockMotionOptions(session.motionCapabilities, session.shownPageData, insertBlockId) : null;
  const engineEffects = motionReady ? session.motionCapabilities.effects : [];

  const deviceWidth = WEBSITE_PREVIEW_DEVICES.find((entry) => entry.value === device)!.width;
  // Editing at laptop width fills the canvas; tablet and phone show the page at that width.
  const width = mode === "preview" || device !== "laptop" ? deviceWidth : null;
  const editing = mode === "edit";
  const ready = connection.phase === "ready";
  const canUndo = editing && ready && commands.has("undo") && Boolean(editorState?.canUndo);
  const canRedo = editing && ready && commands.has("redo") && Boolean(editorState?.canRedo);
  const canAddBlock = editing && ready && commands.has("add-block");
  const canOutline = editing && ready && commands.has("outline");
  const outlineOn = Boolean(editorState?.outline);
  const waiting = page.status === "review";
  const connectionMessage = frameConnectionMessage(connection, site.editorFrameOrigin!);
  const toggleDrawer = (next: Exclude<Drawer, null>) => setDrawer((current) => (current === next ? null : next));

  return (
    <FullScreen>
      <TopBar>
        <BackButton onClick={() => void leave()} />
        <PagePicker pages={pages} page={page} onOpen={(id) => void openPage(id)} />
        <SaveStatePill mode={mode} connection={connection} saveState={saveState} dirty={dirty} status={page.status} />
        <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          {editing ? (
            <>
              <IconButton label="Undo (⌘Z)" icon={Undo2} disabled={!canUndo} onClick={() => run("undo")} />
              <IconButton label="Redo (⇧⌘Z)" icon={Redo2} disabled={!canRedo} onClick={() => run("redo")} />
            </>
          ) : null}
          <IconButton label="Ask an agent" icon={MessageSquarePlus} labelled pressed={drawer === "change" && !ask?.picked} onClick={askAgent} />
          <div className="hidden items-center gap-1 lg:flex">
            {editing ? (
              <>
                <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
                <IconButton label="Add block" icon={Plus} labelled disabled={!canAddBlock} onClick={() => run("add-block")} />
                <IconButton label="Outline" icon={ListTree} labelled disabled={!canOutline} pressed={outlineOn} onClick={() => run("outline", !outlineOn)} />
              </>
            ) : null}
            <Segmented
              label="Width"
              value={device}
              options={WEBSITE_PREVIEW_DEVICES.map((entry) => ({ value: entry.value, label: entry.label, title: `${entry.label} ${entry.width}` }))}
              onChange={setDevice}
            />
            {mode === "preview" ? (
              <Segmented
                label="Preview version"
                value={source}
                options={[
                  { value: "draft", label: "Draft" },
                  { value: "live", label: "Live" },
                ]}
                onChange={(value) => void switchView({ source: value })}
              />
            ) : null}
            <IconButton
              label="Comments"
              icon={MessagesSquare}
              labelled
              badge={openComments}
              pressed={drawer === "comments"}
              onClick={() => toggleDrawer("comments")}
            />
            <IconButton label="History" icon={History} labelled pressed={drawer === "history"} onClick={() => toggleDrawer("history")} />
            <IconButton label="Media" icon={ImageIcon} labelled pressed={drawer === "media"} onClick={() => toggleDrawer("media")} />
            <IconButton label="Motion" icon={Waves} labelled pressed={drawer === "motion"} onClick={() => toggleDrawer("motion")} />
          </div>
          <Button
            type="button"
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            aria-pressed={mode === "preview"}
            onClick={() => void switchView({ mode: mode === "preview" ? "edit" : "preview", source: "draft" })}
            className="hidden sm:inline-flex"
          >
            {mode === "preview" ? <PenLine /> : <Eye />}
            {mode === "preview" ? "Edit" : "Preview"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void askToPublish()}
            disabled={waiting || requestPublish.isPending}
            className="hidden sm:inline-flex"
            data-testid="website-request-publish"
          >
            <Send />
            {waiting ? "Waiting for approval" : "Request publish"}
          </Button>
          <MoreMenu
            mode={mode}
            device={device}
            drawer={drawer}
            openComments={openComments}
            waiting={waiting}
            canAddBlock={canAddBlock}
            canOutline={canOutline}
            outlineOn={outlineOn}
            onMode={() => void switchView({ mode: mode === "preview" ? "edit" : "preview", source: "draft" })}
            onDevice={setDevice}
            onDrawer={toggleDrawer}
            onAddBlock={() => run("add-block")}
            onOutline={() => run("outline", !outlineOn)}
            onRequestPublish={() => void askToPublish()}
          />
        </div>
      </TopBar>
      {notice ? (
        <Strip tone="warning" action={{ label: "Reload", onClick: reload }}>{notice}</Strip>
      ) : (
        <ProblemStrip
          mode={mode}
          connection={connection}
          connectionMessage={connectionMessage}
          saveState={saveState}
          dirty={dirty}
          frameError={frameError}
          canRetry={Boolean(sessionRef.current?.canRetry)}
          onRetrySave={() => void sessionRef.current?.retry()}
          onReconnect={reload}
        />
      )}
      {message ? (
        <Strip tone={message.tone === "success" ? "success" : "warning"} onClose={() => setMessage(null)}>{message.text}</Strip>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div className={cn("relative min-w-0 flex-1", width ? "bg-muted" : "bg-background")}>
          {notice ? null : (
            <EditorFrame
              key={frameSessionKey}
              companyId={companyId}
              site={site}
              page={page}
              mode={mode}
              source={source}
              width={width}
              device={device}
              sessionRef={sessionRef}
              focusBlockId={mode === "edit" ? focusBlockId : null}
              onConnection={(next) => {
                setConnection(next);
                if (next.phase === "ready") setCommands(new Set(sessionRef.current?.editorCommands ?? []));
              }}
              onSaveState={setSaveState}
              onFrameError={setFrameError}
              onBlockPicked={(picked) => {
                const target: WebsiteChangeTarget = {
                  kind: "block",
                  blockId: picked.ref.blockId,
                  blockType: picked.ref.blockType,
                  label: picked.label,
                  pageRevisionId: picked.ref.pageRevisionId,
                  engine: picked.ref.engine,
                  source: picked.ref.source,
                };
                setAsk((current) => ({ n: (current?.n ?? 0) + 1, target, picked: true }));
                setDrawer("change");
              }}
              onEditorState={onEditorState}
              onEditorKey={() => escape()}
              onMediaRequested={onMediaRequested}
              onDirty={setDirty}
              onDraftLoaded={() => setDraftLoads((count) => count + 1)}
              onOriginChanged={() => setNotice(ORIGIN_CHANGED_NOTICE)}
            />
          )}
        </div>
        {drawer ? (
          <EditorDrawer
            title={DRAWER_TITLES[drawer]}
            onClose={() => {
              setDrawer(null);
              if (drawer === "change") {
                if (ask?.picked) sessionRef.current?.highlight(null);
                setAsk(null);
              }
            }}
          >
            {drawer === "history" ? (
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
            {drawer === "media" ? (
              <MediaPanel
                companyId={companyId}
                site={site}
                dirty={dirty}
                insertBlockId={insertBlockId}
                insertBlockName={focusBlockName}
                requested={mediaRequest}
                insertMedia={insertMedia}
                onInserted={() => setDirty(true)}
                onMediaAdded={() => {
                  // The frame gets the site's media with load-draft, so a clean editor reloads to pick up the new item.
                  if (!dirty) setFrameKey((key) => key + 1);
                }}
              />
            ) : null}
            {drawer === "motion" ? (
              <MotionPanel
                key={`${page.id}:${insertBlockId ?? ""}:${draftLoads}`}
                editorOrigin={site.editorFrameOrigin!}
                mode={mode}
                ready={motionReady}
                blockId={insertBlockId}
                blockName={focusBlockName}
                options={motionOptions}
                engineEffects={engineEffects.length}
                wanted={wantedMotion}
                setMotion={setMotion}
                onApplied={() => setDirty(true)}
              />
            ) : null}
            {drawer === "change" && ask ? (
              <WebsiteChangeRequestPanel
                key={ask.n}
                companyId={companyId}
                siteId={site.id}
                page={page}
                target={ask.target}
                width={device}
                dirty={dirty}
                onCancel={() => {
                  if (ask.picked) sessionRef.current?.highlight(null);
                  setAsk(null);
                  setDrawer(null);
                }}
                onEditBlock={ask.picked && mode === "preview" ? (blockId, blockName) => void editBlock(blockId, blockName) : undefined}
              />
            ) : null}
            {drawer === "comments" ? (
              <WebsiteCommentsPanel
                companyId={companyId}
                siteId={site.id}
                page={page}
                onAsk={askAgent}
                onPreviewChange={() => void previewChange()}
              />
            ) : null}
          </EditorDrawer>
        ) : null}
      </div>
    </FullScreen>
  );
}

const DRAWER_TITLES: Record<Exclude<Drawer, null>, string> = {
  history: "History",
  media: "Media",
  motion: "Motion",
  change: "Ask an agent",
  comments: "Comments",
};

/**
 * GSAM's one drawer. From lg up it is a column beside the canvas, so the page
 * narrows and reflows instead of hiding under it; below lg it lies over the
 * right of the canvas, and on a phone it is a bottom sheet. Not modal.
 */
function EditorDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside
      aria-label={title}
      className={cn(
        "absolute z-raised flex flex-col border-border bg-background shadow-lg",
        "inset-x-0 bottom-0 max-h-(--sz-70vh) rounded-t-xl border-t",
        "sm:inset-x-auto sm:top-0 sm:right-0 sm:max-h-none sm:w-96 sm:rounded-none sm:border-t-0 sm:border-l",
        "lg:relative lg:inset-auto lg:shrink-0 lg:shadow-none",
      )}
      data-testid="website-editor-drawer"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={`Close ${title}`}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

/** Pressed reads like the chosen Width segment, with an edge so it holds on the light wash. */
const PRESSED = "bg-accent text-foreground ring-1 ring-inset ring-border hover:bg-accent";

function IconButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  pressed,
  labelled,
  badge,
}: {
  label: string;
  icon: typeof Undo2;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Show the label beside the icon where the bar has room (xl and up). */
  labelled?: boolean;
  /** A count beside the icon, e.g. open comments. Hidden at 0. */
  badge?: number;
}) {
  const name = label.replace(/ \(.+\)$/, "");
  return (
    <Button
      type="button"
      variant="ghost"
      size={labelled ? "sm" : "icon-sm"}
      aria-label={name}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(labelled && "w-9 xl:w-auto", badge ? "relative" : null, pressed && PRESSED)}
    >
      <Icon />
      {labelled ? <span className="hidden xl:inline">{name}</span> : null}
      {badge ? (
        <span
          className="absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground xl:static xl:ml-0.5"
          data-testid="website-comments-count"
        >
          {badge}
        </span>
      ) : null}
    </Button>
  );
}

/** The page picker: search the site's pages by title or address. */
function PagePicker({ pages, page, onOpen }: { pages: WebsitePage[]; page: WebsitePage; onOpen: (pageId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Page: ${page.title}. Change page`}
          className="flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="website-page-picker"
        >
          <span className="min-w-0 truncate text-sm font-medium">{page.title}</span>
          {/* The home page's "/" read as a broken breadcrumb; the picker list still shows it. */}
          {page.slug !== "/" ? (
            <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:inline">{page.slug}</span>
          ) : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find a page" />
          <CommandList>
            <CommandEmpty>No page matches.</CommandEmpty>
            {pages.map((entry) => (
              <CommandItem
                key={entry.id}
                value={`${entry.title} ${entry.slug} ${entry.id}`}
                onSelect={() => {
                  setOpen(false);
                  onOpen(entry.id);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{entry.title}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{entry.slug}</span>
                </span>
                {entry.id === page.id ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Draft or Saved, in one word or two: the top bar's save state. */
function SaveStatePill({
  mode,
  connection,
  saveState,
  dirty,
  status,
}: {
  mode: Mode;
  connection: WebsiteFrameConnection;
  saveState: WebsiteFrameSaveState;
  dirty: boolean;
  status: WebsitePageStatus;
}) {
  let text: string;
  // Full-strength text on a neutral fill: the state is a must-have, so never the faint grey.
  let tone = "border border-border bg-status-neutral-soft text-foreground";
  if (connection.phase === "connecting") text = "Connecting";
  else if (mode === "preview") text = "Preview";
  else if (saveState.status === "saving") text = "Saving";
  else if (dirty) {
    text = "Unsaved";
    tone = "bg-status-warning-soft text-status-warning-foreground";
  } else if (saveState.status === "saved") {
    text = `Saved ${formatTime(saveState.savedAt)}`;
    tone = "bg-status-success-soft text-status-success-foreground";
  } else {
    const copy = PAGE_STATUS_COPY[status] ?? PAGE_STATUS_COPY.draft;
    text = copy.label;
    // Draft keeps the neutral pill: the draft token is green in this palette and read as Saved.
    if (status !== "planned" && status !== "draft") tone = copy.tone;
  }
  return (
    <span
      role="status"
      className={cn("inline-flex max-w-24 shrink-0 truncate rounded-full px-2 py-0.5 text-xs font-medium sm:max-w-none", tone)}
      data-testid="website-save-state"
    >
      {text}
    </span>
  );
}

/** Everything the top bar does not show on a phone. */
function MoreMenu({
  mode,
  device,
  drawer,
  openComments,
  waiting,
  canAddBlock,
  canOutline,
  outlineOn,
  onMode,
  onDevice,
  onDrawer,
  onAddBlock,
  onOutline,
  onRequestPublish,
}: {
  mode: Mode;
  device: WebsitePreviewDevice;
  drawer: Drawer;
  openComments: number;
  waiting: boolean;
  canAddBlock: boolean;
  canOutline: boolean;
  outlineOn: boolean;
  onMode: () => void;
  onDevice: (device: WebsitePreviewDevice) => void;
  onDrawer: (drawer: Exclude<Drawer, null>) => void;
  onAddBlock: () => void;
  onOutline: () => void;
  onRequestPublish: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="More" className="lg:hidden">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onMode} className="sm:hidden">
          {mode === "preview" ? <PenLine /> : <Eye />}
          {mode === "preview" ? "Edit" : "Preview"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRequestPublish} disabled={waiting} className="sm:hidden">
          <Send />
          {waiting ? "Waiting for approval" : "Request publish"}
        </DropdownMenuItem>
        {mode === "edit" ? (
          <>
            <DropdownMenuItem onSelect={onAddBlock} disabled={!canAddBlock}>
              <Plus />
              Add block
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOutline} disabled={!canOutline}>
              <ListTree />
              {outlineOn ? "Hide outline" : "Show outline"}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onDrawer("comments")}>
          <MessagesSquare />
          Comments{openComments ? ` (${openComments} open)` : ""}{drawer === "comments" ? " (shown)" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDrawer("history")}>
          <History />
          History{drawer === "history" ? " (open)" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDrawer("media")}>
          <ImageIcon />
          Media{drawer === "media" ? " (open)" : ""}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDrawer("motion")}>
          <Waves />
          Motion{drawer === "motion" ? " (open)" : ""}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Width</DropdownMenuLabel>
        {WEBSITE_PREVIEW_DEVICES.map((entry) => (
          <DropdownMenuItem key={entry.value} onSelect={() => onDevice(entry.value)}>
            <entry.icon />
            {`${entry.label} ${entry.width}`}
            {entry.value === device ? <Check className="ml-auto" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          title={option.title}
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

const STRIP_TONES = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  success: "border-status-success/40 bg-status-success-soft text-status-success-foreground",
  warning: "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
  danger: "border-status-danger/40 bg-status-danger-soft text-status-danger-foreground",
};

/** One line under the top bar: a problem or an outcome, never a permanent panel. */
function Strip({
  tone,
  children,
  action,
  onClose,
  testId,
  state,
}: {
  tone: keyof typeof STRIP_TONES;
  children: ReactNode;
  action?: { label: string; onClick: () => void } | null;
  onClose?: () => void;
  testId?: string;
  state?: string;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      data-testid={testId}
      data-state={state}
      className={cn("flex min-h-9 shrink-0 flex-wrap items-center gap-3 border-b px-3 py-1.5 text-sm", STRIP_TONES[tone])}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action ? (
        <Button type="button" size="xs" variant="outline" onClick={action.onClick}>
          <RefreshCw />
          {action.label}
        </Button>
      ) : null}
      {onClose ? (
        <Button type="button" size="icon-xs" variant="ghost" onClick={onClose} aria-label="Dismiss">
          <X />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The save banner, only when there is something to act on: the frame did not
 * connect, a save failed or met a conflict, or the editor is in preview. A
 * clean or saved page says so in the top bar instead.
 */
function ProblemStrip({
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
  let tone: keyof typeof STRIP_TONES = "neutral";
  let text: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;

  if (connectionMessage) {
    tone = connection.phase === "no-answer" ? "warning" : "danger";
    text = connectionMessage;
    action = { label: "Retry", onClick: onReconnect };
  } else if (connection.phase === "connecting") {
    return null;
  } else if (frameError) {
    tone = "danger";
    text = frameError;
    action = { label: "Reload", onClick: onReconnect };
  } else if (mode === "preview") {
    text = "Preview. Click a block to ask for a change, or switch to Edit to change it yourself.";
  } else if (saveState.status === "conflict") {
    tone = "warning";
    text = `Someone saved this page first (${saveState.savedBy}, ${relativeTime(saveState.savedAt)}). Choose Keep mine or Take theirs in the editor.`;
  } else if (saveState.status === "failed") {
    tone = "danger";
    text = saveState.message;
    if (saveState.retryable && canRetry) action = { label: "Retry", onClick: onRetrySave };
  } else if (saveState.status === "saved" && !dirty) {
    tone = "success";
    text = `Saved at ${formatTime(saveState.savedAt)}`;
  } else if (dirty) {
    text = "Unsaved changes. Save with ⌘S or the editor's Save.";
  }
  if (!text) return null;
  if (!connectionMessage && mode === "edit" && dirty && (saveState.status === "conflict" || saveState.status === "failed")) {
    text = `${text} Unsaved changes.`;
  }
  return (
    <Strip tone={tone} action={action} testId="website-save-banner" state={connectionMessage ? connection.phase : saveState.status}>
      {text}
    </Strip>
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
  sessionRef,
  focusBlockId,
  onConnection,
  onSaveState,
  onFrameError,
  onBlockPicked,
  onEditorState,
  onEditorKey,
  onMediaRequested,
  onDirty,
  onDraftLoaded,
  onOriginChanged,
}: {
  companyId: string;
  site: WebsiteSite;
  page: WebsitePage;
  mode: Mode;
  source: Source;
  width: number | null;
  device: WebsitePreviewDevice;
  sessionRef: React.MutableRefObject<WebsiteFrameHostSession<Window> | null>;
  focusBlockId: string | null;
  onConnection: (connection: WebsiteFrameConnection) => void;
  onSaveState: (state: WebsiteFrameSaveState) => void;
  onFrameError: (message: string) => void;
  onBlockPicked: (pick: WebsiteFrameBlockPick) => void;
  onEditorState: (state: WebsiteFrameEditorState) => void;
  onEditorKey: () => void;
  onMediaRequested: (request: WebsiteFrameMediaRequested) => void;
  onDirty: (dirty: boolean) => void;
  onDraftLoaded: () => void;
  onOriginChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const editorOrigin = site.editorFrameOrigin!;
  const problem = editorOpenProblem(site, window.location.origin, import.meta.env.DEV);
  const notLive = mode === "preview" && source === "live" && !page.publishedRevisionId;
  // The session lives across renders; it calls the newest handlers.
  const handlers = useRef({ onConnection, onSaveState, onFrameError, onBlockPicked, onEditorState, onEditorKey, onMediaRequested, onDirty, onDraftLoaded, onOriginChanged });
  handlers.current = { onConnection, onSaveState, onFrameError, onBlockPicked, onEditorState, onEditorKey, onMediaRequested, onDirty, onDraftLoaded, onOriginChanged };

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
        if (answer.outcome === "failed" && answer.code === "origin-changed") handlers.current.onOriginChanged();
        return answer;
      },
      onConnection: (connection) => handlers.current.onConnection(connection),
      onSaveState: (state) => handlers.current.onSaveState(state),
      onDirty: (dirty) => handlers.current.onDirty(dirty),
      onBlockPicked: (picked) => {
        handlers.current.onBlockPicked(picked);
        sessionRef.current?.highlight(picked.ref.blockId);
      },
      onDraftLoaded: () => {
        if (focusBlockId) sessionRef.current?.highlight(focusBlockId);
        handlers.current.onDraftLoaded();
      },
      onFrameError: (error) => handlers.current.onFrameError(error.message),
      onEditorState: (state) => handlers.current.onEditorState(state),
      onEditorKey: () => handlers.current.onEditorKey(),
      onMediaRequested: (request) => handlers.current.onMediaRequested(request),
      onDrop: (reason) => console.warn(`[website editor] dropped a frame message: ${reason}`),
    });
    sessionRef.current = session;
    session.start();
  };

  if (problem) {
    return (
      <div className="p-4">
        <div role="alert" className="rounded-lg border border-status-danger/40 bg-status-danger-soft px-4 py-3 text-sm text-status-danger-foreground">
          GSAM will not open the editor from {editorOrigin}: it must be its own https address, not the public site or a GSAM address. A company owner or admin can change it under Releases, Site connection.
        </div>
      </div>
    );
  }
  if (notLive) {
    return (
      <div className="p-6">
        <EmptyState icon={FileText} title="This page is not live yet" message="It has no published version. Preview the draft instead." />
      </div>
    );
  }

  return (
    <ScaledFrame
      frameRef={frameRef}
      src={websiteFrameSrc(editorOrigin, mode === "edit" ? "editor" : "preview", page.id)}
      title={mode === "edit" ? "Page editor" : `Page preview, ${device} width`}
      width={width}
      sandbox={WEBSITE_FRAME_SANDBOX}
      allow=""
      onLoad={start}
      testId="website-editor-frame"
      viewport={mode === "preview" || width ? device : "editor"}
    />
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
    <section className="min-w-0 space-y-3" aria-label="Versions of this page" data-testid="website-history">
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
    </section>
  );
}

function MediaPanel({
  companyId,
  site,
  dirty,
  insertBlockId,
  insertBlockName,
  requested,
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
  /** The page asked to replace an image (`media-requested`): open the picker for it. */
  requested: { n: number; kind: MediaPickerKind } | null;
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
  useEffect(() => {
    if (requested) setPicker(requested.kind);
  }, [requested]);

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
    <section className="min-w-0 space-y-3" aria-label="Website media" data-testid="website-media">
      <div>
        <p className="text-xs text-muted-foreground">
          {insertBlockId
            ? `Selected block: ${blockName}. Add image or Add animation puts the item in it.`
            : "The site's images. Click an image on the page to replace it, or pick from an image field in the editor."}
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
    </section>
  );
}

const EFFECT_INTENSITIES: { value: WebsiteMotionIntensity; label: string }[] = [
  { value: "subtle", label: MOTION_INTENSITY_LABELS.subtle },
  { value: "full", label: MOTION_INTENSITY_LABELS.full },
];

/**
 * Motion (GRE-2219): put one of the engine's effects in the selected block.
 * The engine owns the effects, their stills and the checks; GSAM sends only
 * the choice (`set-motion`), and the person saves the page in the editor.
 */
function MotionPanel({
  editorOrigin,
  mode,
  ready,
  blockId,
  blockName,
  options,
  engineEffects,
  wanted,
  setMotion,
  onApplied,
}: {
  editorOrigin: string;
  mode: Mode;
  /** The editor has the draft and said what motion it takes. */
  ready: boolean;
  blockId: string | null;
  blockName: string;
  options: BlockMotionOptions | null;
  /** How many effects the engine described; 0 for an engine from before GRE-2232. */
  engineEffects: number;
  wanted: string | null;
  setMotion: (choice: WebsiteMotionChoice) => Promise<WebsiteFrameSetMotionResult | null>;
  onApplied: () => void;
}) {
  const name = blockName || "The selected block";
  const wantedOption = options ? motionOptionFor(options.options, wanted) : null;
  const [effect, setEffect] = useState(wantedOption?.id ?? options?.current.effect ?? "none");
  const [intensity, setIntensity] = useState<WebsiteMotionIntensity>(
    options && options.current.intensity !== "off" ? options.current.intensity : "subtle",
  );
  const [applied, setApplied] = useState<WebsiteMotionChoice | null>(options?.current ?? null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "warn" } | null>(null);
  const chosen = options?.options.find((option) => option.id === effect) ?? null;
  const choice = motionChoice(effect, intensity);
  const unchanged = applied !== null && applied.effect === choice.effect && applied.intensity === choice.intensity;

  const apply = async () => {
    if (!chosen) return;
    setPending(true);
    setMessage(null);
    const result = await setMotion(choice);
    setPending(false);
    setMessage({ text: setMotionMessage(result, name, chosen.label, choice.intensity), tone: result?.ok ? "success" : "warn" });
    if (result?.ok) {
      setApplied(choice);
      onApplied();
    }
  };

  let hint: string;
  if (mode !== "edit") hint = "Switch to Edit to put motion in a block.";
  else if (!blockId) hint = "Pick a block first: click it on the page. Its motion choices show here.";
  else if (!ready) hint = "Waiting for the site's editor.";
  else if (engineEffects === 0) hint = "This site's engine does not offer motion choices yet. Set motion in the block's own fields.";
  else if (!options) hint = `${name} takes no motion. Pick a hero or a section block.`;
  else hint = `Selected block: ${name}. Pick an effect, then Use in block.`;

  return (
    <section className="min-w-0 space-y-3" aria-label="Motion in the selected block" data-testid="website-motion">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{hint}</p>
        {wanted ? (
          <p className="text-xs text-muted-foreground" data-testid="website-motion-wanted">
            {wantedOption
              ? `From GS Studio: ${wantedOption.study ? `study ${wantedOption.study}, ` : ""}${wantedOption.label}.`
              : options
                ? `From GS Studio: ${/^\d{3}$/.test(wanted) ? `study ${wanted}` : wanted} is not offered for ${name}.`
                : `From GS Studio: ${/^\d{3}$/.test(wanted) ? `study ${wanted}` : wanted}.`}
          </p>
        ) : null}
      </div>
      {options ? (
        <>
          <div role="radiogroup" aria-label="Effect" className="grid grid-cols-2 gap-2" data-testid="website-motion-effects">
            {options.options.map((option) => (
              <MotionOptionTile
                key={option.id}
                option={option}
                editorOrigin={editorOrigin}
                checked={option.id === effect}
                current={applied?.effect === option.id}
                onSelect={() => setEffect(option.id)}
              />
            ))}
          </div>
          {effect !== "none" ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">Strength</span>
              <Segmented label="Strength" value={choice.intensity} options={EFFECT_INTENSITIES} onChange={setIntensity} />
            </div>
          ) : null}
          <Button type="button" size="sm" className="w-full" disabled={pending || unchanged || !chosen} onClick={() => void apply()} data-testid="website-motion-apply">
            {pending ? "Putting it in the block" : unchanged ? "In the block" : "Use in block"}
          </Button>
        </>
      ) : null}
      {message ? (
        message.tone === "success" ? (
          <p role="status" className="flex gap-1.5 rounded-md border border-status-success/30 bg-status-success-soft px-2.5 py-2 text-xs text-status-success-foreground">
            <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{message.text}</span>
          </p>
        ) : (
          <p role="alert" className="rounded-md border border-status-warning/40 bg-status-warning-soft px-2.5 py-2 text-xs text-status-warning-foreground">
            {message.text}
          </p>
        )
      ) : null}
    </section>
  );
}

function MotionOptionTile({
  option,
  editorOrigin,
  checked,
  current,
  onSelect,
}: {
  option: MotionOption;
  editorOrigin: string;
  checked: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "border-foreground bg-accent" : "border-border hover:bg-accent/50",
      )}
      data-testid={`website-motion-effect-${option.id}`}
    >
      {/* The engine draws its effects for the site's dark surface, so the still sits on the dark theme's background in both themes. */}
      <span className="dark relative block aspect-video w-full overflow-hidden rounded-md bg-background">
        {option.still ? (
          // The engine's own still, from the editor origin: GSAM keeps no copy.
          <img
            src={`${editorOrigin}${option.still}`}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">No motion</span>
        )}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 px-1 pb-0.5">
        {option.study ? <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">{option.study}</span> : null}
        <span className="truncate text-xs font-medium text-foreground">{option.label}</span>
        {current ? <span className="ml-auto shrink-0 text-(length:--text-micro) text-muted-foreground">Now</span> : null}
      </span>
    </button>
  );
}
