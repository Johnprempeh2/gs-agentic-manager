import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Pencil } from "lucide-react";
import type { WebsitePage, WebsiteSite, WebsiteSitemapOption, WebsiteSitemapTree } from "@greatstone/shared";
import { websiteModuleApi } from "../../../api/website";
import { queryKeys } from "../../../lib/queryKeys";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs } from "@/components/ui/tabs";
import { useConfirm } from "@/context/ConfirmContext";
import { formatDateTime } from "@/lib/utils";
import { PageTabBar } from "../../PageTabBar";
import { ErrorState, errorStateMessage } from "../../ErrorState";
import { SitemapBoardView } from "./SitemapBoard";
import { pagesLookup } from "./model";
import { SitemapCompareView } from "./SitemapCompare";
import { Pill, SitemapJourneysView, SitemapListView, SitemapMenusView, SitemapTreeView } from "./SitemapViews";

// The Sitemap section (GRE-2111): see, compare, edit and approve the site's
// structure. Every view edits one local draft of the chosen option; Save
// writes it, Approve (people who can publish) makes it the site's pages and
// menus, live with the next Publish.

export type SitemapView = "tree" | "board" | "menus" | "journeys" | "list" | "compare" | "xml";

export const SITEMAP_VIEWS: { value: SitemapView; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "board", label: "Board" },
  { value: "menus", label: "Menus" },
  { value: "journeys", label: "Journeys" },
  { value: "list", label: "List" },
  { value: "compare", label: "Compare" },
  { value: "xml", label: "sitemap.xml" },
];

/** A first option from the site's current pages, so a site with pages starts from what it has. */
export function treeFromPages(pages: WebsitePage[]): WebsiteSitemapTree {
  const idFor = new Map(pages.map((page, index) => [page.id, `n${index + 1}`]));
  const siblingsOrder = new Map<string | null, number>();
  return {
    nodes: [...pages]
      .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0) || a.slug.localeCompare(b.slug))
      .map((page) => {
        const parentId = page.parentPageId ? idFor.get(page.parentPageId) ?? null : null;
        const order = siblingsOrder.get(parentId) ?? 0;
        siblingsOrder.set(parentId, order + 1);
        return {
          id: idFor.get(page.id)!,
          title: page.title,
          path: page.slug,
          parentId,
          order,
          menu: page.menu,
          menuOrder: page.menuOrder,
          pageId: page.id,
          seoTitle: page.seo.title ?? null,
          noindex: page.seo.noindex ?? false,
        };
      }),
    journeys: [],
  };
}

const EMPTY_TREE: WebsiteSitemapTree = {
  nodes: [{ id: "n1", title: "Home", path: "/", parentId: null, order: 0, menu: "none", menuOrder: null }],
  journeys: [],
};

function statusPill(option: WebsiteSitemapOption) {
  if (option.status === "approved" && option.changedSinceApproval) {
    return <Pill className="bg-status-warning-soft text-status-warning-foreground">Approved, changes not applied</Pill>;
  }
  if (option.status === "approved") return <Pill className="bg-status-success-soft text-status-success-foreground">Approved</Pill>;
  if (option.status === "archived") return <Pill className="bg-muted text-muted-foreground">Archived</Pill>;
  return <Pill className="bg-muted text-foreground">Draft</Pill>;
}

/** What approving a tree does to the site's current pages: pages it plans and pages it archives. */
export function approvalImpact(tree: WebsiteSitemapTree, pages: WebsitePage[]) {
  const liveIds = new Set(pages.map((page) => page.id));
  const liveSlugs = new Set(pages.map((page) => page.slug));
  const matched = new Set(tree.nodes.flatMap((node) => (node.pageId && liveIds.has(node.pageId) ? [node.pageId] : [])));
  for (const page of pages) if (tree.nodes.some((node) => !node.pageId && node.path === page.slug)) matched.add(page.id);
  const created = tree.nodes.filter((node) => !(node.pageId && liveIds.has(node.pageId)) && !liveSlugs.has(node.path)).length;
  return { created, archived: pages.filter((page) => !matched.has(page.id)).length };
}

/** The one approve step, opened from the header and from Compare alike. */
function ApproveDialog({ option, pages, pending, error, onCancel, onApprove }: {
  option: WebsiteSitemapOption | null;
  pages: WebsitePage[];
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onApprove: (optionId: string) => void;
}) {
  const impact = useMemo(() => (option ? approvalImpact(option.tree, pages) : null), [option, pages]);
  return (
    <AlertDialog open={!!option} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <AlertDialogContent data-testid="sitemap-approve-dialog" className="sm:max-w-md">
        <AlertDialogHeader className="text-left sm:text-left">
          <AlertDialogTitle className="text-base leading-snug">Approve {option?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its pages become the site's pages and menus: {impact?.created ?? 0} new pages are planned and {impact?.archived ?? 0} pages that are not in it are archived (not deleted). Visitors see it after the next Publish.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(error)}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={pending || !option} onClick={() => option && onApprove(option.id)}>
            {pending ? "Approving" : "Approve"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useSitemapData(companyId: string, siteId: string | null) {
  const options = useQuery({
    queryKey: queryKeys.website.sitemapOptions(companyId, siteId ?? ""),
    queryFn: () => websiteModuleApi.sitemapOptions(companyId, siteId!),
    enabled: !!siteId,
  });
  const pages = useQuery({
    queryKey: queryKeys.website.pages(companyId, siteId ?? ""),
    queryFn: () => websiteModuleApi.pages(companyId, siteId!),
    enabled: !!siteId,
  });
  return { options, pages };
}

/** Starts the first option: from the site's pages when it has some, else a Home page. */
export function StartSitemap({ companyId, site, pages }: { companyId: string; site: WebsiteSite; pages: WebsitePage[] }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () =>
      websiteModuleApi.createSitemapOption(companyId, site.id, {
        name: pages.length ? "Current site" : "Option 1",
        tree: pages.length ? treeFromPages(pages) : EMPTY_TREE,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.website.sitemapOptions(companyId, site.id) }),
  });
  return (
    <section className="gs-glass-card space-y-3 rounded-xl border p-4" aria-labelledby="sitemap-start-title">
      <h2 id="sitemap-start-title" className="text-sm font-semibold">Build the sitemap here</h2>
      <p className="text-sm text-muted-foreground">
        Start an option to see, edit and compare the site's pages and menus here. An approved option becomes the site's pages and menus.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
          {pages.length ? "Start from the current pages" : "Start a sitemap"}
        </Button>
        {start.isError ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(start.error)}</p> : null}
      </div>
    </section>
  );
}

export function SitemapSection({ companyId, site, options, pages, canApprove, canEdit }: {
  companyId: string;
  site: WebsiteSite;
  options: WebsiteSitemapOption[];
  pages: WebsitePage[];
  canApprove: boolean;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const approved = options.find((option) => option.status === "approved") ?? null;
  const [optionId, setOptionId] = useState<string>(approved?.id ?? options[0]?.id ?? "");
  const option = options.find((entry) => entry.id === optionId) ?? approved ?? options[0]!;
  const [draft, setDraft] = useState<WebsiteSitemapTree | null>(null);
  const [view, setView] = useState<SitemapView>("tree");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(option.name);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tree = draft ?? option.tree;
  const pagesById = useMemo(() => pagesLookup(pages), [pages]);
  const readOnly = !canEdit || option.status === "archived";
  const confirm = useConfirm();

  useEffect(() => {
    setDraft(null);
    setRenaming(false);
    setName(option.name);
  }, [option.id, option.name]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.sitemapOptions(companyId, site.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.pages(companyId, site.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.sitemapXml(companyId, site.id) });
  };
  const save = useMutation({
    mutationFn: (patch: { optionId: string; tree?: WebsiteSitemapTree; name?: string; baseUpdatedAt?: string }) =>
      websiteModuleApi.updateSitemapOption(companyId, site.id, patch.optionId, {
        ...(patch.tree ? { tree: patch.tree } : {}),
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.baseUpdatedAt ? { baseUpdatedAt: patch.baseUpdatedAt } : {}),
      }),
    onSuccess: () => {
      setDraft(null);
      setRenaming(false);
      refresh();
    },
  });
  const copy = useMutation({
    mutationFn: () => websiteModuleApi.createSitemapOption(companyId, site.id, { name: `${option.name} copy`.slice(0, 120), tree }),
    onSuccess: (created) => {
      refresh();
      setOptionId(created.id);
      setNotice(`Made ${created.name}. Change it, then compare it with the others.`);
    },
  });
  const approve = useMutation({
    mutationFn: (id: string) => websiteModuleApi.approveSitemapOption(companyId, site.id, id),
    onSuccess: (result) => {
      setApprovingId(null);
      setOptionId(result.option.id);
      setNotice(
        `Approved ${result.option.name}: ${result.summary.created} new pages planned, ${result.summary.updated} updated, ${result.summary.archived} archived. It goes live with the next Publish.`,
      );
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: () => websiteModuleApi.archiveSitemapOption(companyId, site.id, option.id),
    onSuccess: () => {
      setOptionId(approved?.id ?? options.find((entry) => entry.id !== option.id)?.id ?? "");
      refresh();
    },
  });
  // Approve errors show in the dialog while it is open.
  const error = save.error ?? copy.error ?? (approvingId ? null : approve.error) ?? archive.error;
  const busy = save.isPending || copy.isPending || approve.isPending || archive.isPending;

  const canApproveThis = canApprove && option.status !== "archived" && (option.status !== "approved" || option.changedSinceApproval);

  return (
    <div className="space-y-6" data-testid="website-sitemap-section">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Option</span>
            <NativeSelect
              value={option.id}
              onChange={async (event) => {
                const nextId = event.target.value;
                if (draft && !(await confirm({ title: "Leave this option without saving your changes?", confirmLabel: "Leave without saving", tone: "destructive" }))) return;
                setOptionId(nextId);
              }}
              className="max-w-full sm:w-80"
            >
              {options.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}{entry.status === "approved" ? " (approved)" : ""}</option>
              ))}
            </NativeSelect>
          </label>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {statusPill(option)}
            {draft ? <Pill className="bg-status-warning-soft text-status-warning-foreground">Unsaved changes</Pill> : null}
            <span className="text-xs text-muted-foreground">
              {tree.nodes.length} pages, {tree.journeys.length} journeys
              {option.approvedAt ? `, approved ${formatDateTime(option.approvedAt)}` : ""}
            </span>
          </div>
        </div>
        {renaming ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) save.mutate({ optionId: option.id, name: name.trim() });
            }}
          >
            <Input aria-label="Option name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="h-8 max-w-xs" autoFocus />
            <Button type="submit" size="xs" disabled={!name.trim() || busy}>Save name</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
          </form>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {draft ? (
            <>
              <Button type="button" size="sm" disabled={busy} onClick={() => save.mutate({ optionId: option.id, tree: draft, baseUpdatedAt: option.updatedAt })}>
                {save.isPending ? "Saving" : "Save changes"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Discard</Button>
            </>
          ) : null}
          {canApproveThis && !draft ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => { approve.reset(); setApprovingId(option.id); }}>
              <Check aria-hidden="true" />
              {option.status === "approved" ? "Apply changes to the site" : "Approve this option"}
            </Button>
          ) : null}
          {canEdit ? (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => copy.mutate()}>
                <Copy aria-hidden="true" />
                New option from this one
              </Button>
              {readOnly ? null : (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRenaming(true)}>
                  <Pencil aria-hidden="true" />
                  Rename
                </Button>
              )}
              {option.status === "draft" ? (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => archive.mutate()}>Archive option</Button>
              ) : null}
            </>
          ) : null}
        </div>
        <ApproveDialog
          option={options.find((entry) => entry.id === approvingId) ?? null}
          pages={pages}
          pending={approve.isPending}
          error={approve.error}
          onCancel={() => setApprovingId(null)}
          onApprove={(id) => approve.mutate(id)}
        />
        {notice ? <p role="status" className="text-sm text-status-success-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(error)}</p> : null}
      </div>
      <div>
        {/* The view bar sits 16px above the view it switches (DESIGN.md page rhythm). */}
        <Tabs value={view} onValueChange={(value) => setView(value as SitemapView)} className="mb-4">
          <PageTabBar items={SITEMAP_VIEWS} value={view} onValueChange={(value) => setView(value as SitemapView)} align="start" ariaLabel="Sitemap view" />
        </Tabs>
        {view === "tree" ? <SitemapTreeView tree={tree} onChange={setDraft} pagesById={pagesById} readOnly={readOnly} /> : null}
        {view === "board" ? <SitemapBoardView tree={tree} onChange={setDraft} pagesById={pagesById} readOnly={readOnly} /> : null}
        {view === "menus" ? <SitemapMenusView tree={tree} onChange={setDraft} pagesById={pagesById} readOnly={readOnly} /> : null}
        {view === "journeys" ? <SitemapJourneysView tree={tree} onChange={setDraft} pagesById={pagesById} readOnly={readOnly} /> : null}
        {view === "list" ? <SitemapListView tree={tree} onChange={setDraft} pagesById={pagesById} readOnly={readOnly} /> : null}
        {view === "compare" ? (
          <SitemapCompareView
            options={options.map((entry) => (entry.id === option.id && draft ? { ...entry, tree: draft } : entry))}
            pagesById={pagesById}
            initialA={approved && approved.id !== option.id ? approved.id : option.id}
            initialB={approved && approved.id !== option.id ? option.id : options.find((entry) => entry.id !== option.id)?.id ?? null}
            canApprove={canApprove && !draft}
            canEdit={canEdit}
            busy={busy}
            onApprove={(id) => { approve.reset(); setApprovingId(id); }}
            onCopy={(targetId, nextTree) => {
              const target = options.find((entry) => entry.id === targetId)!;
              save.mutate({ optionId: targetId, tree: nextTree, baseUpdatedAt: target.updatedAt });
              setNotice(`Copied the branch into ${target.name}.`);
            }}
          />
        ) : null}
        {view === "xml" ? <SitemapXmlView companyId={companyId} site={site} /> : null}
      </div>
    </div>
  );
}

function SitemapXmlView({ companyId, site }: { companyId: string; site: WebsiteSite }) {
  const xml = useQuery({
    queryKey: queryKeys.website.sitemapXml(companyId, site.id),
    queryFn: () => websiteModuleApi.sitemapXml(companyId, site.id),
  });
  if (xml.error) return <ErrorState error={xml.error} compact onRetry={() => void xml.refetch()} />;
  return (
    <div className="space-y-3" data-testid="sitemap-xml">
      <p className="text-sm text-muted-foreground">
        The sitemap.xml the approved sitemap makes for {site.domain}: every page that is not marked noindex. Publishing puts it on the site.
      </p>
      <pre className="max-h-(--sz-70vh) overflow-auto rounded-xl border border-border bg-muted p-4 font-mono text-xs text-foreground">
        {xml.isLoading ? "Loading" : xml.data}
      </pre>
    </div>
  );
}
