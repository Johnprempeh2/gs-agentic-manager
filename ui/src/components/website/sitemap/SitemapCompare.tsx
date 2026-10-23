import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { diffSitemapTrees, type SitemapChange, type WebsiteSitemapOption } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { copyBranch, flatten, type Tree } from "./model";
import { Pill } from "./SitemapViews";

const CHANGE_LABELS: Record<SitemapChange, { label: string; className: string }> = {
  added: { label: "Added", className: "bg-status-success-soft text-status-success-foreground" },
  removed: { label: "Removed", className: "bg-status-danger-soft text-status-danger-foreground" },
  moved: { label: "Moved", className: "bg-status-info-soft text-status-info-foreground" },
  renamed: { label: "Renamed", className: "bg-status-warning-soft text-status-warning-foreground" },
};

function OptionColumn({ option, tree, changesById, side }: {
  option: WebsiteSitemapOption;
  tree: Tree;
  changesById: Map<string, SitemapChange[]>;
  side: "a" | "b";
}) {
  const rows = flatten(tree);
  return (
    <section aria-labelledby={`compare-${side}`} className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4">
      <h3 id={`compare-${side}`} className="text-sm font-semibold">{option.name}</h3>
      <ul className="space-y-1" aria-label={`Pages in ${option.name}`}>
        {rows.map(({ node, depth }) => {
          const changes = changesById.get(node.id) ?? [];
          return (
            <li
              key={node.id}
              className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 text-sm", changes.length > 0 && "bg-muted")}
              style={{ paddingInlineStart: `calc(var(--spacing) * ${2 + depth * 5})` }}
            >
              <span className="min-w-0 font-medium">{node.title}</span>
              <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{node.path}</span>
              {changes.map((change) => (
                <Pill key={change} className={CHANGE_LABELS[change].className}>{CHANGE_LABELS[change].label}</Pill>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Compare (GRE-2111): two options side by side, with added, removed, moved
 * and renamed pages marked. Pick one (approve it), or copy a branch from one
 * option into a copy of the other to mix them: the mix is a new option, shown
 * on the right, and the two options compared do not change (GRE-2143).
 */
export function SitemapCompareView({ options, initialA, initialB, canApprove, canEdit, onApprove, onCopy, busy }: {
  options: WebsiteSitemapOption[];
  initialA: string | null;
  initialB: string | null;
  canApprove: boolean;
  canEdit: boolean;
  onApprove: (optionId: string) => void;
  /** Saves the mix as a new option and resolves to its id (null when the save fails). */
  onCopy: (targetOptionId: string, tree: Tree) => Promise<string | null>;
  busy: boolean;
}) {
  const [aId, setAId] = useState(initialA ?? options[0]?.id ?? "");
  const [bId, setBId] = useState(initialB ?? options.find((option) => option.id !== aId)?.id ?? "");
  const a = options.find((option) => option.id === aId);
  const b = options.find((option) => option.id === bId);
  const [copyFrom, setCopyFrom] = useState<"a" | "b">("b");
  const [copyNode, setCopyNode] = useState("");
  const [copyParent, setCopyParent] = useState("");

  const diff = useMemo(() => (a && b ? diffSitemapTrees(a.tree, b.tree) : []), [a, b]);
  const { aChanges, bChanges, counts } = useMemo(() => {
    const aChanges = new Map<string, SitemapChange[]>();
    const bChanges = new Map<string, SitemapChange[]>();
    const counts: Record<SitemapChange, number> = { added: 0, removed: 0, moved: 0, renamed: 0 };
    for (const entry of diff) {
      for (const change of entry.changes) counts[change] += 1;
      if (entry.a) aChanges.set(entry.a.id, entry.changes);
      if (entry.b) bChanges.set(entry.b.id, entry.changes);
    }
    return { aChanges, bChanges, counts };
  }, [diff]);

  if (options.length < 2) {
    return <p className="text-sm text-muted-foreground">Compare needs two options. Use New option to copy this one, change it, then compare.</p>;
  }

  const source = copyFrom === "a" ? a : b;
  const target = copyFrom === "a" ? b : a;
  const select = (label: string, value: string, onChange: (value: string) => void) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm sm:max-w-xs">
      <span className="font-medium">{label}</span>
      <NativeSelect value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}{option.status === "approved" ? " (approved)" : ""}</option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <div className="space-y-6" data-testid="sitemap-compare">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          {select("Left", aId, setAId)}
          {select("Right", bId, setBId)}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {(Object.keys(CHANGE_LABELS) as SitemapChange[]).map((change) => (
            <Pill key={change} className={CHANGE_LABELS[change].className}>{counts[change]} {CHANGE_LABELS[change].label.toLowerCase()}</Pill>
          ))}
          <span>Marks read from left to right: added means only the right option has the page.</span>
        </p>
      </div>
      {a && b ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <OptionColumn option={a} tree={a.tree} changesById={aChanges} side="a" />
            {canApprove && a.status !== "approved" ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(a.id)}>Use {a.name}</Button>
            ) : null}
          </div>
          <div className="min-w-0 space-y-2">
            <OptionColumn option={b} tree={b.tree} changesById={bChanges} side="b" />
            {canApprove && b.status !== "approved" ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => onApprove(b.id)}>Use {b.name}</Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {canEdit && source && target && source.id !== target.id ? (
        <form
          className="gs-glass-card space-y-3 rounded-xl border p-4"
          aria-labelledby="sitemap-copy-branch"
          onSubmit={(event) => {
            event.preventDefault();
            if (!copyNode) return;
            const targetId = target.id;
            void onCopy(targetId, copyBranch(source.tree, copyNode, target.tree, copyParent || null)).then((createdId) => {
              if (!createdId) return;
              // Keep the base option on the left and show the new mix on the right.
              setAId(targetId);
              setBId(createdId);
              setCopyFrom("a");
              setCopyNode("");
              setCopyParent("");
            });
          }}
        >
          <h3 id="sitemap-copy-branch" className="text-sm font-semibold">Mix: copy a branch</h3>
          <p className="text-xs text-muted-foreground">
            Copies a page and its sub-pages into a copy of the other option and saves it as a new option. The options you compare do not change. Paths already in use get a number on the end.
          </p>
          {/* One field per row on a phone; a row from sm up (GRE-2143). */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium">From</span>
              <NativeSelect value={copyFrom} onChange={(event) => {
                setCopyFrom(event.target.value as "a" | "b");
                setCopyNode("");
                setCopyParent("");
              }}>
                <option value="a">{a?.name}</option>
                <option value="b">{b?.name}</option>
              </NativeSelect>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm sm:max-w-xs sm:flex-1">
              <span className="font-medium">Page and its sub-pages</span>
              <NativeSelect value={copyNode} onChange={(event) => setCopyNode(event.target.value)}>
                <option value="">Choose a page</option>
                {flatten(source.tree).map(({ node }) => (
                  <option key={node.id} value={node.id}>{node.title} ({node.path})</option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm sm:max-w-xs sm:flex-1">
              <span className="font-medium">Into a copy of {target.name}, under</span>
              <NativeSelect value={copyParent} onChange={(event) => setCopyParent(event.target.value)}>
                <option value="">Top level</option>
                {flatten(target.tree).map(({ node }) => (
                  <option key={node.id} value={node.id}>{node.title} ({node.path})</option>
                ))}
              </NativeSelect>
            </label>
            <Button type="submit" size="sm" variant="outline" className="self-start sm:self-auto" disabled={!copyNode || busy}>
              <Copy aria-hidden="true" />
              Copy branch
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
