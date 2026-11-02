import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Loader2, Pencil, Trash2, Upload } from "lucide-react";
import { referencesApi, type ReferenceItem } from "../api/references";
import { assetsApi } from "../api/assets";
import { useToast } from "../context/ToastContext";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const referencesQueryKey = (companyId: string) => ["references", companyId] as const;

/** A checkerboard behind previews, so a light logo and a dark one both stay visible. */
const PREVIEW_BG = {
  backgroundColor: "#8a8a8a",
  backgroundImage: "conic-gradient(#6f6f6f 25%, transparent 0 50%, #6f6f6f 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

const parseTags = (text: string) => [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];

/**
 * GS Studio's References (2 Nov 2026): brand elements, approved designs and
 * examples, each with a note on how to use it. Agents read the same list, and
 * the live design chat can drop one into an instruction.
 */
export function ReferenceStudio({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReferenceItem | null>(null);
  const query = useQuery({ queryKey: referencesQueryKey(companyId), queryFn: () => referencesApi.list(companyId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: referencesQueryKey(companyId) });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const created: ReferenceItem[] = [];
      for (const file of files) {
        const asset = await assetsApi.uploadImage(companyId, file, "references");
        created.push(await referencesApi.create(companyId, { assetId: asset.assetId, title: file.name.replace(/\.[^.]+$/, "") }));
      }
      return created;
    },
    onSuccess: (created) => {
      void refresh();
      // Straight into naming the first one: a reference without a note is half a reference.
      if (created.length === 1) setEditing(created[0]);
      pushToast({ title: created.length === 1 ? "Reference added" : `${created.length} references added`, tone: "success" });
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Upload failed", tone: "error" }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => referencesApi.archive(companyId, id),
    onSuccess: () => void refresh(),
  });

  const items = query.data ?? [];
  const tags = useMemo(() => [...new Set(items.flatMap((i) => i.tags))].sort(), [items]);
  const shown = tag ? items.filter((i) => i.tags.includes(tag)) : items;

  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <section className="space-y-4" aria-label="References">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Brand elements, approved designs and good examples, each with a note on how to use it. Agents see these too, and you can pick one in live design.
        </p>
        <Button type="button" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Upload className="size-4" aria-hidden="true" />}
          Add images
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) upload.mutate(files);
          }}
        />
      </div>

      {tags.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
          {[null, ...tags].map((t) => (
            <Button key={t ?? "all"} type="button" size="xs" variant={tag === t ? "default" : "outline"} onClick={() => setTag(t)} aria-pressed={tag === t}>
              {t ?? "All"}
            </Button>
          ))}
        </div>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading references</p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Library}
          title="No references yet"
          message="Add the logo, colours, approved screens or examples you like. Give each a short note, for example: primary logo, dark backgrounds only."
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((item) => (
            <li key={item.id} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex aspect-video items-center justify-center" style={PREVIEW_BG}>
                <img src={item.contentPath} alt={item.title} loading="lazy" className="max-h-full max-w-full object-contain" />
              </div>
              <div className="space-y-1 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{item.title}</p>
                  <div className="flex shrink-0 gap-1">
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${item.title}`} onClick={() => archive.mutate(item.id)}>
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {item.notes ? <p className="line-clamp-2 text-xs text-muted-foreground">{item.notes}</p> : null}
                {item.tags.length ? <p className="truncate text-xs text-muted-foreground">{item.tags.join(" · ")}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <EditReference
          item={editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await referencesApi.update(companyId, editing.id, body);
            void refresh();
            setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}

function EditReference({
  item,
  onClose,
  onSave,
}: {
  item: ReferenceItem;
  onClose: () => void;
  onSave: (body: { title: string; notes: string | null; tags: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reference</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setSaving(true);
            void onSave({ title: title.trim(), notes: notes.trim() || null, tags: parseTags(tags) }).finally(() => setSaving(false));
          }}
        >
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">How to use it</span>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} placeholder="For example: primary logo, dark backgrounds only, never stretched" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Tags, separated by commas</span>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="greatstone, logo" />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !title.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A compact picker for composers: click a reference to add it to the instruction. */
export function ReferencePickerList({ companyId, onPick }: { companyId: string; onPick: (item: ReferenceItem) => void }) {
  const query = useQuery({ queryKey: referencesQueryKey(companyId), queryFn: () => referencesApi.list(companyId) });
  const items = query.data ?? [];
  if (query.isLoading) return <p className="p-2 text-sm text-muted-foreground">Loading references</p>;
  if (!items.length) return <p className="p-2 text-sm text-muted-foreground">No references yet. Add them in GS Studio, References.</p>;
  return (
    <ul className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto p-1">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onPick(item)}
            className="w-full overflow-hidden rounded-md border border-border text-left hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
          >
            <div className="flex aspect-video items-center justify-center" style={PREVIEW_BG}>
              <img src={item.contentPath} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
            </div>
            <p className="truncate px-2 py-1 text-xs font-medium">{item.title}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}
