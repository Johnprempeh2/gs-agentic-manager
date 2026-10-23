import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Pencil } from "lucide-react";
import type { WebsitePage, WebsiteSite, WebsiteSitemapOption, WebsiteSitemapTree } from "@greatstone/shared";
import { websiteModuleApi } from "../../../api/website";
import { queryKeys } from "../../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs } from "@/components/ui/tabs";
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

/** "{name} + mix", with a number on the end when an option already has that name. */
export function mixName(baseName: string, options: Pick<WebsiteSitemapOption, "name">[]): string {
  const taken = new Set(options.map((entry) => entry.name));
  const stem = `${baseName.slice(0, 108)} + mix`;
  if (!taken.has(stem)) return stem;
  let count = 2;
  while (taken.has(`${stem} ${count}`)) count += 1;
  return `${stem} ${count}`;
}

function statusPill(option: WebsiteSitemapOption) {
  if (option.status === "approved" && option.changedSinceApproval) {
    return <Pill className="bg-status-warning-soft text-status-warning-foreground">Approved, changes not applied</Pill>;
  }
  if (option.status === "approved") return <Pill className="bg-status-success-soft text-status-success-foreground">Approved</Pill>;
  if (option.status === "archived") return <Pill className="bg-muted text-muted-foreground">Archived</Pill>;
  return <Pill className="bg-muted text-foreground">Draft</Pill>;
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
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const tree = draft ?? option.tree;
  const pagesById = useMemo(() => pagesLookup(pages), [pages]);
  const readOnly = !canEdit || option.status === "archived";

  useEffect(() => {
    setDraft(null);
    setRenaming(false);
    setConfirming(false);
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
  // A mix is always a new option, so the two options compared stay as they were (GRE-2143).
  const mix = useMutation({
    mutationFn: ({ baseName, tree: mixTree }: { baseName: string; tree: WebsiteSitemapTree }) =>
      websiteModuleApi.createSitemapOption(companyId, site.id, { name: mixName(baseName, options), tree: mixTree }),
    onSuccess: (created) => {
      queryClient.setQueryData<WebsiteSitemapOption[]>(
        queryKeys.website.sitemapOptions(companyId, site.id),
        (current) => (current ? [...current, created] : current),
      );
      refresh();
      setNotice(`Your mix is saved as a new option, ${created.name}. The options you compared do not change.`);
    },
  });
  const approve = useMutation({
    mutationFn: (id: string) => websiteModuleApi.approveSitemapOption(companyId, site.id, id),
    onSuccess: (result) => {
      setConfirming(false);
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
  const error = save.error ?? copy.error ?? mix.error ?? approve.error ?? archive.error;
  const busy = save.isPending || copy.isPending || mix.isPending || approve.isPending || archive.isPending;

  // What approving does to the site, before a person confirms it.
  const impact = useMemo(() => {
    const liveIds = new Set(pages.map((page) => page.id));
    const liveSlugs = new Set(pages.map((page) => page.slug));
    const matched = new Set(tree.nodes.flatMap((node) => (node.pageId && liveIds.has(node.pageId) ? [node.pageId] : [])));
    for (const page of pages) if (tree.nodes.some((node) => !node.pageId && node.path === page.slug)) matched.add(page.id);
    const created = tree.nodes.filter((node) => !(node.pageId && liveIds.has(node.pageId)) && !liveSlugs.has(node.path)).length;
    return { created, archived: pages.filter((page) => !matched.has(page.id)).length };
  }, [tree, pages]);
  const canApproveThis = canApprove && option.status !== "archived" && (option.status !== "approved" || option.changedSinceApproval);

  return (
    <div className="space-y-6" data-testid="website-sitemap-section">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">Option</span>
            <NativeSelect
              value={option.id}
              onChange={(event) => {
                if (draft && !window.confirm("Leave this option without saving your changes?")) return;
                setOptionId(event.target.value);
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
            <Button type="button" size="sm" variant={confirming ? "outline" : "default"} disabled={busy} onClick={() => setConfirming(true)}>
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
        {confirming ? (
          <div role="alertdialog" aria-labelledby="sitemap-approve-title" className="gs-glass-card space-y-3 rounded-xl border p-4">
            <h3 id="sitemap-approve-title" className="text-sm font-semibold">Approve {option.name}?</h3>
            <p className="text-sm text-muted-foreground">
              Its pages become the site's pages and menus: {impact.created} new pages are planned and {impact.archived} pages that are not in it are archived (not deleted). Visitors see it after the next Publish.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => approve.mutate(option.id)}>
                {approve.isPending ? "Approving" : "Approve"}
              </Button>
            </div>
          </div>
        ) : null}
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
            initialA={approved && approved.id !== option.id ? approved.id : option.id}
            initialB={approved && approved.id !== option.id ? option.id : options.find((entry) => entry.id !== option.id)?.id ?? null}
            canApprove={canApprove && !draft}
            canEdit={canEdit}
            busy={busy}
            onApprove={(id) => {
              const chosen = options.find((entry) => entry.id === id);
              if (!window.confirm(`Approve ${chosen?.name ?? "this option"}? Its pages become the site's pages and menus. Pages it does not name are archived, not deleted.`)) return;
              setOptionId(id);
              approve.mutate(id);
            }}
            onCopy={async (targetId, nextTree) => {
              const target = options.find((entry) => entry.id === targetId)!;
              const created = await mix.mutateAsync({ baseName: target.name, tree: nextTree }).catch(() => null);
              return created?.id ?? null;
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
